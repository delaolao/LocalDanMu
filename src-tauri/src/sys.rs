//! 基于 Windows 消息机制的极小 FFI 层。
//!
//! 为什么不用 `windows` crate 或 `koffi` 那样的 FFI 库：
//!
//! 1. 旧版 Electron 项目用 koffi 调 `SetWindowPos`，是因为 Electron 的
//!    `setAlwaysOnTop` 对「已经置顶」的窗口是空操作，压不住 WPS/PPT 放映窗口；
//! 2. 换到 Rust 之后这些调用只是几个 `extern "system"` 声明，**零依赖、零加载失败分支**，
//!    既省掉一个原生模块（旧版必须 `asarUnpack`），也彻底消除「koffi 加载失败降级」这条路径；
//! 3. 手写声明还能避开「我们的 windows crate 版本和 tauri 内部版本不一致导致 HWND 类型对不上」的坑。
//!
//! 所有函数都只在 `cfg(windows)` 下编译，本项目也只支持 Windows。

#![cfg(windows)]
#![allow(non_snake_case, dead_code)]

use std::ffi::c_void;

pub type HWND = isize;

/* ------------------------------------------------------------ 常量 */

pub const HWND_TOPMOST: HWND = -1;

pub const SWP_NOSIZE: u32 = 0x0001;
pub const SWP_NOMOVE: u32 = 0x0002;
pub const SWP_NOACTIVATE: u32 = 0x0010;
pub const SWP_NOOWNERZORDER: u32 = 0x0200;
pub const SWP_SHOWWINDOW: u32 = 0x0040;

pub const GWL_EXSTYLE: i32 = -20;

pub const WS_EX_TOPMOST: isize = 0x0000_0008;
pub const WS_EX_TRANSPARENT: isize = 0x0000_0020;
pub const WS_EX_TOOLWINDOW: isize = 0x0000_0080;
pub const WS_EX_LAYERED: isize = 0x0008_0000;
pub const WS_EX_NOACTIVATE: isize = 0x0800_0000;

pub const SW_SHOWNOACTIVATE: i32 = 4;
pub const SW_SHOW: i32 = 5;
pub const SW_HIDE: i32 = 0;

pub const VK_LBUTTON: i32 = 0x01;

pub const LWA_ALPHA: u32 = 0x0000_0002;
pub const LWA_COLORKEY: u32 = 0x0000_0001;

#[repr(C)]
#[derive(Default, Clone, Copy, Debug)]
pub struct POINT {
    pub x: i32,
    pub y: i32,
}

#[repr(C)]
#[derive(Default, Clone, Copy, Debug)]
pub struct RECT {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/* ------------------------------------------------- 外部函数声明 */

#[link(name = "user32")]
extern "system" {
    fn SetWindowPos(hwnd: HWND, insert_after: HWND, x: i32, y: i32, cx: i32, cy: i32, flags: u32) -> i32;
    fn GetWindowLongPtrW(hwnd: HWND, index: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: HWND, index: i32, value: isize) -> isize;
    fn ShowWindow(hwnd: HWND, cmd: i32) -> i32;
    fn GetAsyncKeyState(vkey: i32) -> i16;
    fn GetCursorPos(point: *mut POINT) -> i32;
    fn GetForegroundWindow() -> HWND;
    fn SetLayeredWindowAttributes(hwnd: HWND, key: u32, alpha: u8, flags: u32) -> i32;
    fn IsWindowVisible(hwnd: HWND) -> i32;
    fn SetWindowTextW(hwnd: HWND, text: *const u16) -> i32;
}

/* ------------------------------------------------------------ 封装 */

/// 读扩展窗口样式（`WS_EX_*`）。
pub fn ex_style(hwnd: HWND) -> isize {
    unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) }
}

/// 写扩展窗口样式，返回旧值。
pub fn set_ex_style(hwnd: HWND, style: isize) -> isize {
    unsafe { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style) }
}

/// 追加若干 `WS_EX_*` 位。
pub fn add_ex_style(hwnd: HWND, bits: isize) {
    let cur = ex_style(hwnd);
    set_ex_style(hwnd, cur | bits);
}

/// 去掉若干 `WS_EX_*` 位。
pub fn remove_ex_style(hwnd: HWND, bits: isize) {
    let cur = ex_style(hwnd);
    set_ex_style(hwnd, cur & !bits);
}

/// 把窗口强制顶到所有置顶窗口之上：不改尺寸、不改位置、不抢焦点。
///
/// 这是旧版 `topmost.js` 里的同一招，只是不再需要 koffi。
pub fn force_top(hwnd: HWND) -> bool {
    unsafe {
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        ) != 0
    }
}

/// 显示窗口但**不激活**它，避免把键盘焦点从正在放映的 PPT 抢走。
pub fn show_no_activate(hwnd: HWND) {
    unsafe {
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
}

/// 隐藏窗口。
pub fn hide(hwnd: HWND) {
    unsafe {
        ShowWindow(hwnd, SW_HIDE);
    }
}

/// 鼠标左键当前是否按下。
///
/// 旧版必须轮询：Windows 上透明置顶窗口在「穿透 ↔ 接管」反复切换之后，
/// Chromium 偶尔不再把 click 派发给页面。Rust 里读按键状态比走 DOM 事件更可靠。
pub fn is_left_button_down() -> bool {
    unsafe { (GetAsyncKeyState(VK_LBUTTON) & 0x8000u16 as i16) != 0 }
}

/// 当前鼠标屏幕坐标。
pub fn cursor_pos() -> Option<POINT> {
    let mut p = POINT::default();
    let ok = unsafe { GetCursorPos(&mut p) } != 0;
    if ok {
        Some(p)
    } else {
        None
    }
}

/// 当前前台窗口句柄（用来验证「我们的窗口没有抢焦点」）。
pub fn foreground_window() -> HWND {
    unsafe { GetForegroundWindow() }
}

/// 给分层窗口设置颜色键（透明窗口出黑底时的兜底方案）。
pub fn set_color_key(hwnd: HWND, key: u32) -> bool {
    unsafe { SetLayeredWindowAttributes(hwnd, key, 0, LWA_COLORKEY) != 0 }
}

/// 窗口当前是否可见。
pub fn is_visible(hwnd: HWND) -> bool {
    unsafe { IsWindowVisible(hwnd) != 0 }
}

/// 设置窗口标题（UTF-16）。
pub fn set_title(hwnd: HWND, title: &str) {
    let wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        SetWindowTextW(hwnd, wide.as_ptr());
    }
}

/// 把 `c_void` 指针式的 HWND 转成 `isize`，屏蔽不同 tauri 版本的类型差异。
pub fn raw_to_hwnd(raw: *mut c_void) -> HWND {
    raw as isize
}

/// 弹幕层窗口样式的**唯一真相来源**：一次性把「永不激活 + 工具窗口 + 置顶 + 是否穿透」都收敛好。
///
/// 两个必须记住的 Windows 细节（都是实测踩出来的）：
///
/// 1. **点击穿透需要 `WS_EX_LAYERED | WS_EX_TRANSPARENT` 同时在场**。只给 TRANSPARENT
///    不给 LAYERED，鼠标事件仍然会落到我们窗口上（第一版探针就是这么挂的）。
///    所以 LAYERED 常开，只切换 TRANSPARENT。
/// 2. **`WS_EX_NOACTIVATE` 会被 tao 覆盖掉**：WebView2 初始化完成时 tao 把创建时缓存的
///    ex_style 整体写回去，我们在创建后追加的 NOACTIVATE 就没了（日志实录：
///    0x08040198 → 0x000c0138），表现是「明明设了不抢焦点，点一下图片还是把前台抢走」。
///    所以不依赖"设置一次就永久有效"，而是由置顶守护线程每 350ms 复核一次，幂等且只在变化时写。
pub fn apply_overlay_style(hwnd: HWND, captured: bool) {
    let cur = ex_style(hwnd);
    let mut want = cur | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_LAYERED;
    if captured {
        want &= !WS_EX_TRANSPARENT;
    } else {
        want |= WS_EX_TRANSPARENT;
    }
    if want != cur {
        set_ex_style(hwnd, want);
    }
}
