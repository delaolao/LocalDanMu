//! 四个窗口的创建、布局与置顶守护。
//!
//! 对应旧版 `main.js` 的 `createControlWindow` / `createOverlay` / `createCloudWindow` /
//! `createJoinWindow` / `applyDisplayToOverlay` / 置顶守护 / 光标轮询。
//!
//! 弹幕层的窗口配方是 P1 探针验过的，别随手改：
//! 透明 + 无边框 + 置顶 + 跳过任务栏 + 不抢焦点 + 默认点击穿透。
//! 其中「不抢焦点」靠 `WS_EX_NOACTIVATE`，「点击穿透」靠 `WS_EX_LAYERED | WS_EX_TRANSPARENT`，
//! 两者都必须由 `sys::apply_overlay_style` 持续自愈（tao 会覆盖）。

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::time::Duration;

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};

use crate::sys;

pub const CONTROL: &str = "control";
pub const OVERLAY: &str = "overlay";
pub const CLOUD: &str = "cloud";
pub const JOIN: &str = "join";

/// 弹幕层当前是否接管了鼠标（由渲染层的命中测试驱动）。
pub static MOUSE_CAPTURED: AtomicBool = AtomicBool::new(false);

fn overlay_hwnd() -> &'static AtomicIsize {
    static HWND: AtomicIsize = AtomicIsize::new(0);
    &HWND
}

pub fn hwnd_of(app: &AppHandle, label: &str) -> Option<isize> {
    let win = app.get_webview_window(label)?;
    win.hwnd().ok().map(|h| h.0 as isize)
}

/// 目标显示器的物理边界。找不到就回落到主屏。
pub fn target_bounds(
    app: &AppHandle,
    display_name: Option<&str>,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let monitors = app.available_monitors().unwrap_or_default();
    let chosen = display_name
        .and_then(|name| {
            monitors
                .iter()
                .find(|m| m.name().map(|n| n.as_str()) == Some(name))
                .cloned()
        })
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| monitors.first().cloned());

    match chosen {
        Some(m) => (*m.position(), *m.size()),
        None => (PhysicalPosition::new(0, 0), PhysicalSize::new(1280, 720)),
    }
}

/* --------------------------------------------------------------- 控制面板 */

pub fn create_control(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(CONTROL).is_some() {
        return Ok(());
    }

    // 按屏幕可用高度自适应：小屏笔记本上别把底部裁掉
    let (width, height) = match app.primary_monitor().ok().flatten() {
        Some(m) => {
            let scale = m.scale_factor();
            let size = m.size().to_logical::<f64>(scale);
            let h = (size.height - 50.0).clamp(620.0, 880.0);
            let w = 480.0_f64.min((size.width - 80.0).max(420.0));
            (w, h)
        }
        None => (480.0, 760.0),
    };

    let win = WebviewWindowBuilder::new(app, CONTROL, WebviewUrl::App("control/index.html".into()))
        .title("培训弹幕互动")
        .inner_size(width, height)
        .min_inner_size(400.0, 520.0)
        .resizable(true)
        .maximizable(false)
        .decorations(false)
        .always_on_top(true)
        .visible(false)
        .center()
        .build()?;

    // 关闭 = 隐藏到托盘（旧版行为：讲师不小心点掉窗口不该杀掉服务）
    let app_handle = app.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(w) = app_handle.get_webview_window(CONTROL) {
                let _ = w.hide();
            }
        }
    });

    win.show()?;
    Ok(())
}

/* --------------------------------------------------------------- 弹幕层 */

pub fn create_overlay(app: &AppHandle, display_name: Option<&str>) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(OVERLAY) {
        let (pos, size) = target_bounds(app, display_name);
        let _ = existing.set_position(pos);
        let _ = existing.set_size(size);
        let _ = existing.show();
        if let Some(h) = overlay_hwnd().load(Ordering::SeqCst).checked_hwnd() {
            sys::apply_overlay_style(h, MOUSE_CAPTURED.load(Ordering::SeqCst));
            sys::force_top(h);
        }
        return Ok(());
    }

    let (pos, size) = target_bounds(app, display_name);

    let win = WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App("danmaku/index.html".into()))
        .title("弹幕层")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .focused(false)
        .visible(false)
        // 对应 Electron 的 `backgroundThrottling: false`。
        // 不加这个，窗口一被 hide 掉，WebView2 就把渲染节流/挂起，
        // 重新 show 回来时弹幕层要缓几帧才恢复——表现为"切回滚动弹幕时画面回来得迟钝"。
        .build()?;

    win.set_position(pos)?;
    win.set_size(size)?;

    let hwnd = win.hwnd()?.0 as isize;
    overlay_hwnd().store(hwnd, Ordering::SeqCst);

    // 调试/自动化探针需要知道弹幕层的 HWND（仅显式开启时写这个文件）
    if crate::core::probe_enabled() {
        let dir = crate::core::probe_dir();
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("overlay.txt"), hwnd.to_string());
    }

    // 先钉样式，再显示：避免窗口已经可见了才补 NOACTIVATE。
    //
    // 显示一定要走 **Tauri 的 `win.show()`**，不要用裸 `ShowWindow(SW_SHOWNOACTIVATE)`：
    // 裸调用会让 tao 内部的"是否可见"状态和真实状态不一致，之后 `w.hide()`
    // 就变成空操作——实测表现就是"切到词云时滚动弹幕层根本不消失"。
    // 不用担心抢焦点：WS_EX_NOACTIVATE 已经钉住了真实样式位，`show()` 不会激活它。
    sys::add_ex_style(hwnd, sys::WS_EX_NOACTIVATE | sys::WS_EX_TOOLWINDOW);
    sys::apply_overlay_style(hwnd, false);
    win.show()?;
    sys::force_top(hwnd);

    Ok(())
}

/// 光标轮询：30Hz 读光标位置，把**窗口内的 CSS 像素坐标**推给渲染层做命中测试。
///
/// 旧版之所以要轮询而不是用 `mousemove`：`setIgnoreMouseEvents(forward)` 在部分机器上
/// 收不到事件。Tauri 根本没有 forward 选项，所以这条轮询路径从"兜底"变成"主路径"。
///
/// **坐标单位是最容易错的一处**：`GetCursorPos()` 和 `outer_position()` 都是**物理像素**，
/// 而页面里的 canvas 与弹幕条全是 **CSS 像素**。高 DPI（本机 150%）下如果不除以
/// 缩放比，命中测试就会整体偏 1.5 倍——表现正是"鼠标滑过图片毫无反应"。
/// （旧版 Electron 里 `screen.getCursorScreenPoint()` 和 `getBounds()` 都是 DIP，
/// 天然一致，所以当年没暴露这个坑。）
pub fn spawn_cursor_watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut was_down = false;
        let mut last = (-1i32, -1i32);
        loop {
            std::thread::sleep(Duration::from_millis(33));

            let Some(win) = app.get_webview_window(OVERLAY) else {
                continue;
            };
            if !win.is_visible().unwrap_or(false) {
                continue;
            }
            let Ok(bounds) = win.outer_position() else {
                continue;
            };
            let Some(cursor) = sys::cursor_pos() else {
                continue;
            };

            // 物理像素 → CSS 像素
            let scale = win.scale_factor().unwrap_or(1.0).max(0.1);
            let x = ((cursor.x - bounds.x) as f64 / scale).round() as i32;
            let y = ((cursor.y - bounds.y) as f64 / scale).round() as i32;

            let down = sys::is_left_button_down();
            let pressed = down && !was_down;
            was_down = down;

            if (x, y) != last {
                last = (x, y);
                let _ = app.emit_to(OVERLAY, "dm:cursor", serde_json::json!({ "x": x, "y": y }));
            }
            if pressed {
                let _ = app.emit_to(OVERLAY, "dm:click", serde_json::json!({ "x": x, "y": y }));
            }
        }
    });
}

/// 置顶守护 + 样式自愈：每 350ms 一次。
///
/// WPS/PPT 一进放映就把自己的全屏窗口设成置顶并激活，
/// Electron 的 `setAlwaysOnTop` 对这种窗口是空操作，必须用 `SetWindowPos(HWND_TOPMOST)` 抢回来。
/// 顺带复核窗口样式——tao 会在 WebView2 初始化完成后覆盖一次 ex_style。
pub fn spawn_style_guard(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(350));

        // 弹幕层
        if let Some(h) = overlay_hwnd().load(Ordering::SeqCst).checked_hwnd() {
            if sys::is_visible(h) {
                sys::apply_overlay_style(h, MOUSE_CAPTURED.load(Ordering::SeqCst));
                sys::force_top(h);
            }
        }

        // 词云页同样是"置顶但点击穿透"
        if let Some(h) = hwnd_of(&app, CLOUD) {
            if sys::is_visible(h) {
                sys::apply_overlay_style(h, false);
                sys::force_top(h);
            }
        }

        // 引导页：只要置顶，不碰透明/穿透
        if let Some(h) = hwnd_of(&app, JOIN) {
            if sys::is_visible(h) {
                sys::force_top(h);
            }
        }

        // 控制面板要特殊处理：**如果它已经是前台窗口，就不要再 SetWindowPos**。
        //
        // 原因（实测踩到）：Chromium 的原生 `<select>` 下拉列表是一个属于浏览器窗口的
        // 弹出窗口；每 350ms 对属主窗口重排一次 z 序，会让已经弹开的下拉列表立刻关掉——
        // 表现就是"设置与网络里的所有下拉框点开就收回，留不住"。
        // 讲师正在操作控制面板时它本来就在最上面，根本不需要我们再压；
        // 只有当 PPT 放映把它盖住（它不再是前台窗口）时，才把它抢回来。
        if let Some(h) = hwnd_of(&app, CONTROL) {
            if sys::is_visible(h) && sys::foreground_window() != h {
                if crate::core::probe_enabled() {
                    crate::core::probe_log("guard: force_top(control)");
                }
                sys::force_top(h);
            }
        }
    });
}

trait CheckedHwnd {
    fn checked_hwnd(self) -> Option<isize>;
}

impl CheckedHwnd for isize {
    /// 0 表示还没创建，不要拿去调 Win32。
    fn checked_hwnd(self) -> Option<isize> {
        if self == 0 {
            None
        } else {
            Some(self)
        }
    }
}

/* ----------------------------------------------------------------- 词云页 */

pub fn create_cloud(app: &AppHandle, display_name: Option<&str>) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(CLOUD) {
        let (pos, size) = target_bounds(app, display_name);
        let _ = existing.set_position(pos);
        let _ = existing.set_size(size);
        let _ = existing.show();
        if let Some(h) = hwnd_of(app, CLOUD) {
            sys::apply_overlay_style(h, false);
            sys::force_top(h);
        }
        return Ok(());
    }

    let (pos, size) = target_bounds(app, display_name);
    let win = WebviewWindowBuilder::new(app, CLOUD, WebviewUrl::App("cloud/index.html".into()))
        .title("词云")
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .visible(false)
        // 同弹幕层：避免 hide/show 之后渲染被节流，切模式时画面回来得慢
        .build()?;

    win.set_position(pos)?;
    win.set_size(size)?;

    let hwnd = win.hwnd()?.0 as isize;
    sys::add_ex_style(hwnd, sys::WS_EX_NOACTIVATE | sys::WS_EX_TOOLWINDOW);
    sys::apply_overlay_style(hwnd, false);
    // 同弹幕层：必须走 Tauri 的 show()，否则之后 hide() 会失效
    win.show()?;
    sys::force_top(hwnd);
    Ok(())
}

/* --------------------------------------------------------------- 投屏引导页 */

pub fn create_join(app: &AppHandle, display_name: Option<&str>) -> tauri::Result<()> {
    if let Some(existing) = app.get_webview_window(JOIN) {
        let (pos, size) = target_bounds(app, display_name);
        let _ = existing.set_position(pos);
        let _ = existing.set_size(size);
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let (pos, size) = target_bounds(app, display_name);
    let win = WebviewWindowBuilder::new(app, JOIN, WebviewUrl::App("join/index.html".into()))
        .title("投屏引导页")
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .visible(false)
        .build()?;

    win.set_position(pos)?;
    win.set_size(size)?;
    // 引导页需要拿到焦点，才能响应 Esc 关闭（这是唯一需要焦点的全屏窗口）
    win.show()?;
    let _ = win.set_focus();
    Ok(())
}

/// 把所有全屏窗口搬到目标显示器上（换投影时调用）。
pub fn apply_display(app: &AppHandle, display_name: Option<&str>) {
    let (pos, size) = target_bounds(app, display_name);
    for label in [OVERLAY, CLOUD, JOIN] {
        if let Some(win) = app.get_webview_window(label) {
            let _ = win.set_position(pos);
            let _ = win.set_size(size);
        }
    }
}
