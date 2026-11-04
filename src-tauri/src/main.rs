//! 主程序：生命周期、窗口编排、IPC 命令、托盘、快捷键。
//!
//! 对应旧版 `src/main/main.js`。这里只做**编排**，业务都在各模块里：
//! - `settings`  设置项持久化（白名单 + 防抖落盘 + 便携模式）
//! - `server`    HTTP + WebSocket 会话服务
//! - `filter`    内容过滤
//! - `network`   网卡选择与网络位置
//! - `qr`        二维码
//! - `core`      历史、会话状态、与窗口的桥
//! - `windows`   四个窗口的创建与置顶守护
//! - `sys`       Win32 原生调用
//!
//! 与旧版最大的结构差异：不再有「主进程 = Node」这层。服务端和窗口在同一个 Rust
//! 进程里，靠 tokio 任务和 channel 通信，没有跨进程 IPC 序列化开销。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod core;
mod crypto;
mod filter;
mod network;
mod qr;
mod server;
mod settings;
mod sys;
mod tunnel;
mod windows;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent};

use core::{install_app_handle, AppCore};
use settings::Store;
use tunnel::Tunnel;
use windows::{CONTROL, OVERLAY};

fn core_of(app: &AppHandle) -> Arc<AppCore> {
    app.state::<Arc<AppCore>>().inner().clone()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window(CONTROL) {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        return;
                    }
                    let app = app.clone();
                    let name = shortcut.to_string();
                    tauri::async_runtime::spawn(async move {
                        run_shortcut_action(&app, &name).await;
                    });
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            state_get,
            session_toggle_pause,
            session_clear,
            session_end,
            session_restart,
            session_replay,
            history_get,
            app_copy_link,
            app_export,
            app_open_repo,
            app_set_config,
            app_set_display,
            app_set_nic,
            app_refresh_network,
            app_open_network_settings,
            app_toggle_overlay,
            app_toggle_join,
            app_set_mode,
            app_import_words,
            app_hide_panel,
            app_minimize,
            app_quit,
            join_close,
            dm_hover,
            dm_modal,
            dm_ready,
            tunnel_start,
            tunnel_stop,
            tunnel_state,
            tunnel_set_auto,
            app_pick_cloudflared,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            install_app_handle(handle.clone());

            let data_dir = settings::resolve_data_dir();
            let store = Store::open(data_dir.join("settings.json"));
            // 远程模式的端到端密钥槽：Tunnel 写入，服务端按连接读取
            let remote_key = crypto::new_slot();
            let tunnel = Tunnel::new(remote_key.clone(), handle.clone());
            let core = AppCore::new(store, remote_key, Arc::clone(&tunnel));
            app.manage(Arc::clone(&core));
            app.manage(tunnel);

            // 窗口先出来，讲师有东西可看
            windows::create_control(&handle)?;
            let display = core
                .settings
                .get()
                .display_id
                .as_ref()
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            windows::create_overlay(&handle, display.as_deref())?;
            windows::spawn_cursor_watch(handle.clone());
            windows::spawn_style_guard(handle.clone());

            create_tray(&handle)?;
            register_shortcuts(&handle);

            // 托盘菜单文字跟状态走：1 秒一次的极轻量刷新（只在真正变化时才写菜单）
            let handle_tray = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(1));
                let core = core_of(&handle_tray);
                refresh_tray_labels(&handle_tray, &core);
            });
            apply_theme_background(&handle, &core);

            // 服务随后启动（网卡探测不挡首屏）
            let core_bg = Arc::clone(&core);
            let handle_bg = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = core_bg.start_session().await {
                    eprintln!("[main] 会话启动失败: {err}");
                    core_bg.set_warnings(vec![json!({
                        "level": "error",
                        "text": format!("{err}。请点「重新检测」重试，或检查端口是否被占用。"),
                        "action": "refresh"
                    })]);
                }
                core_bg.push_state();

                // 诊断/自动化用：LDM_TUNNEL=1 时开机自动开一次隧道，
                // 这样不依赖 GUI 点击就能验证"下载 cloudflared → 建隧道"整条链路。
                if std::env::var("LDM_TUNNEL")
                    .map(|v| v == "1")
                    .unwrap_or(false)
                {
                    if let Some(session) = core_bg.session() {
                        let cfg = core_bg.settings.get();
                        let t = handle_bg.state::<std::sync::Arc<Tunnel>>().inner().clone();
                        core::probe_log("LDM_TUNNEL: 自动开启隧道");
                        t.start(tunnel::StartArgs {
                            port: session.port,
                            room: session.token.clone(),
                            tunnel_token: cfg.tunnel_token.clone(),
                            host: cfg.tunnel_host.clone(),
                            cloudflared_path: Some(cfg.cloudflared_path.clone())
                                .filter(|s| !s.trim().is_empty()),
                        });
                    }
                }
                // 网络位置探测会起一次 PowerShell，放后台
                let core_net = Arc::clone(&core_bg);
                tauri::async_runtime::spawn_blocking(move || core_net.refresh_network())
                    .await
                    .ok();
                core_bg.push_state();

                // 网络变化时重算地址（IP 变了二维码要跟着变）
                loop {
                    tokio::time::sleep(Duration::from_secs(15)).await;
                    let core_tick = Arc::clone(&core_bg);
                    tauri::async_runtime::spawn_blocking(move || core_tick.refresh_network())
                        .await
                        .ok();
                    core_bg.schedule_push();
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 启动失败")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                // 退出前吼一嗓子，让观众端立刻看到「培训已结束」。
                // 这里刻意不 await：进程马上要退，只需要把帧发出去。
                let core = core_of(app);
                if let Some(st) = core.server_state() {
                    st.broadcast_json(&json!({ "type": "session_end", "reason": "quit" }));
                }
                // 隧道子进程必须显式收尸，否则 cloudflared 会留在后台
                app.state::<std::sync::Arc<Tunnel>>().inner().shutdown();
                std::thread::sleep(Duration::from_millis(80));
            }
        });
}

/* ------------------------------------------------------------------ 托盘 */

struct TrayRefs {
    room: MenuItem<tauri::Wry>,
    pause: MenuItem<tauri::Wry>,
    overlay: MenuItem<tauri::Wry>,
    mode: MenuItem<tauri::Wry>,
    end: MenuItem<tauri::Wry>,
}

/// 上一次写进托盘菜单的状态签名，用来避免每秒重建菜单。
fn tray_sig() -> &'static Mutex<String> {
    static SIG: OnceLock<Mutex<String>> = OnceLock::new();
    SIG.get_or_init(|| Mutex::new(String::new()))
}

fn tray_refs() -> &'static Mutex<Option<TrayRefs>> {
    static REFS: OnceLock<Mutex<Option<TrayRefs>>> = OnceLock::new();
    REFS.get_or_init(|| Mutex::new(None))
}

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let image = tauri::image::Image::from_bytes(include_bytes!("../../assets/tray-32.png"))?;

    let room = MenuItem::with_id(app, "room", "未开始", false, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "显示控制面板", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "暂停弹幕", true, None::<&str>)?;
    let clear = MenuItem::with_id(app, "clear", "清屏", true, None::<&str>)?;
    let mode = MenuItem::with_id(app, "mode", "切换到词云", true, None::<&str>)?;
    let overlay = MenuItem::with_id(app, "overlay", "隐藏弹幕层", true, None::<&str>)?;
    let end = MenuItem::with_id(app, "end", "结束培训", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &room,
            &PredefinedMenuItem::separator(app)?,
            &show,
            &pause,
            &clear,
            &mode,
            &overlay,
            &PredefinedMenuItem::separator(app)?,
            &end,
            &quit,
        ],
    )?;

    TrayIconBuilder::with_id("main")
        .icon(image)
        .tooltip("培训弹幕互动")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref().to_string();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                match id.as_str() {
                    "show" => show_control(&app),
                    "pause" => {
                        let core = core_of(&app);
                        let paused = core.toggle_pause();
                        if let Some(w) = app.get_webview_window(OVERLAY) {
                            let _ = w.emit(
                                "dm:cmd",
                                json!({ "type": if paused { "pause" } else { "resume" } }),
                            );
                        }
                        core.push_state();
                    }
                    "clear" => clear_overlay(&app),
                    "mode" => {
                        let core = core_of(&app);
                        toggle_mode(&app, &core).await;
                    }
                    "overlay" => toggle_overlay(&app),
                    "end" => {
                        let core = core_of(&app);
                        confirm_and_end(&app, &core).await;
                    }
                    "quit" => {
                        let core = core_of(&app);
                        core.end_session().await;
                        app.exit(0);
                    }
                    _ => {}
                }
            });
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { button, .. } = event {
                if button == tauri::tray::MouseButton::Left {
                    show_control(tray.app_handle());
                }
            }
        })
        .build(app)?;

    *tray_refs().lock().unwrap() = Some(TrayRefs {
        room,
        pause,
        overlay,
        mode,
        end,
    });
    Ok(())
}

/// 托盘菜单文字随状态变化（旧版 `updateTray` 的等价物）。
fn refresh_tray_labels(app: &AppHandle, core: &Arc<AppCore>) {
    // 托盘菜单只能从主线程改，而状态变化发生在任意线程，所以用"1 秒 tick + 变化才写"。
    // 一定要先比签名：每秒无条件 set_text/set_tooltip 会让系统托盘菜单反复重建，
    // 白白增加主线程负担（也是旧版 updateTray 里同款做法的原因）。
    let sig = format!(
        "{}|{}|{}|{}|{}",
        core.session().map(|s| s.token).unwrap_or_default(),
        core.online.load(Ordering::SeqCst),
        core.paused.load(Ordering::SeqCst),
        core.overlay_visible.load(Ordering::SeqCst),
        core.settings.get().mode
    );
    {
        let mut last = match tray_sig().lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if *last == sig {
            return;
        }
        *last = sig;
    }

    let guard = match tray_refs().lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let Some(refs) = guard.as_ref() else { return };

    let online = core.online.load(Ordering::SeqCst);
    let session = core.session();
    let room = match &session {
        Some(s) => format!("房间 {} · 在线 {} 人", s.token, online),
        None => "未开始".to_string(),
    };
    let _ = refs.room.set_text(room);

    let paused = core.paused.load(Ordering::SeqCst);
    let _ = refs.pause.set_text(if paused {
        "恢复弹幕"
    } else {
        "暂停弹幕"
    });

    let visible = core.overlay_visible.load(Ordering::SeqCst);
    let _ = refs.overlay.set_text(if visible {
        "隐藏弹幕层"
    } else {
        "显示弹幕层"
    });

    let cloud = core.settings.get().mode == "cloud";
    let _ = refs.mode.set_text(if cloud {
        "切回滚动弹幕"
    } else {
        "切换到词云"
    });

    let has_session = core.session().is_some();
    let _ = refs.end.set_enabled(has_session);
    let _ = refs.room.set_enabled(false);

    if let Some(tray) = app.tray_by_id("main") {
        let tip = if has_session {
            format!("培训弹幕互动 · 在线 {online} 人")
        } else {
            "培训弹幕互动".to_string()
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}

/* --------------------------------------------------------------- 快捷键 */

fn register_shortcuts(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

    let defs: [(Shortcut, &str); 6] = [
        (
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space),
            "Ctrl+Alt+Space",
        ),
        (
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyX),
            "Ctrl+Alt+X",
        ),
        (
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyJ),
            "Ctrl+Alt+J",
        ),
        (
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyK),
            "Ctrl+Alt+K",
        ),
        (
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyG),
            "Ctrl+Alt+G",
        ),
        (
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyM),
            "Ctrl+Alt+M",
        ),
    ];

    let mut report = serde_json::Map::new();
    for (shortcut, label) in defs {
        let ok = app.global_shortcut().register(shortcut).is_ok();
        report.insert(label.to_string(), Value::Bool(ok));
        if crate::core::probe_enabled() {
            crate::core::probe_log(&format!("shortcut register {label} = {ok}"));
        }
    }
    core_of(app).set_shortcut_report(Value::Object(report));
}

/// 快捷键的动作分派。名字是 `Ctrl+Alt+Space` 这种形式，按修饰键+主键判断。
async fn run_shortcut_action(app: &AppHandle, name: &str) {
    let core = core_of(app);
    // `Shortcut::to_string()` 产出的是 "ctrl+alt+KeyK" 这种形式，必须先把 "key" 前缀剥掉：
    // 否则 "KeyK".to_ascii_lowercase() == "keyk"，和 "k" 永远匹配不上，
    // 表现就是"快捷键能触发但什么都不发生"（这里踩过一次，靠探针日志才看出来）。
    let raw = name
        .split('+')
        .next_back()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let key = raw.strip_prefix("key").unwrap_or(&raw).to_string();

    if crate::core::probe_enabled() {
        crate::core::probe_log(&format!("shortcut fired: name={name} key={key}"));
    }

    match key.as_str() {
        "space" => {
            let paused = core.toggle_pause();
            if let Some(w) = app.get_webview_window(OVERLAY) {
                let _ = w.emit(
                    "dm:cmd",
                    json!({ "type": if paused { "pause" } else { "resume" } }),
                );
            }
            core.push_state();
        }
        "x" => clear_overlay(app),
        "j" => toggle_join(app, &core),
        "k" => toggle_mode(app, &core).await,
        "g" => close_big_image(app),
        "m" => {
            if let Some(w) = app.get_webview_window(CONTROL) {
                if w.is_visible().unwrap_or(false) {
                    let _ = w.hide();
                } else {
                    show_control(app);
                }
            }
        }
        _ => {}
    }
}

/* --------------------------------------------------------- 窗口动作（共用） */

fn show_control(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(CONTROL) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn clear_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let _ = w.emit("dm:cmd", json!({ "type": "clear" }));
    }
}

fn close_big_image(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let _ = w.emit("dm:cmd", json!({ "type": "closeModal" }));
        windows::MOUSE_CAPTURED.store(false, Ordering::SeqCst);
        if let Some(h) = windows::hwnd_of(app, OVERLAY) {
            sys::apply_overlay_style(h, false);
        }
    }
}

fn toggle_overlay(app: &AppHandle) {
    let core = core_of(app);
    let next = !core.overlay_visible.load(Ordering::SeqCst);
    core.overlay_visible.store(next, Ordering::SeqCst);

    if let Some(w) = app.get_webview_window(OVERLAY) {
        if next {
            let _ = w.show();
            if let Some(h) = windows::hwnd_of(app, OVERLAY) {
                sys::apply_overlay_style(h, windows::MOUSE_CAPTURED.load(Ordering::SeqCst));
                sys::force_top(h);
            }
        } else {
            let _ = w.hide();
        }
    }
    core.push_state();
}

fn toggle_join(app: &AppHandle, core: &Arc<AppCore>) {
    let display = core
        .settings
        .get()
        .display_id
        .as_ref()
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let visible = app
        .get_webview_window(windows::JOIN)
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);

    if visible {
        if let Some(w) = app.get_webview_window(windows::JOIN) {
            let _ = w.hide();
        }
    } else {
        let _ = windows::create_join(app, display.as_deref());
    }
    core.push_state();
}

async fn toggle_mode(app: &AppHandle, core: &Arc<AppCore>) {
    let next = if core.settings.get().mode == "cloud" {
        "scroll"
    } else {
        "cloud"
    };
    core.settings.set(&json!({ "mode": next }));
    apply_mode(app, core).await;
}

async fn apply_mode(app: &AppHandle, core: &Arc<AppCore>) {
    let settings = core.settings.get();
    let display = settings
        .display_id
        .as_ref()
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    if settings.mode == "cloud" {
        // 先把弹幕层藏掉，再建/显示词云窗口。顺序反过来会有一段时间两层同时可见，
        // 表现为"切到词云时滚动弹幕迟迟不消失"（首次创建词云窗口要几百毫秒）。
        if let Some(w) = app.get_webview_window(OVERLAY) {
            let _ = w.hide();
        }
        let _ = windows::create_cloud(app, display.as_deref());
        // 词云页需要一份历史，创建/切换后补推一次配置
        if let Some(w) = app.get_webview_window(windows::CLOUD) {
            let _ = w.emit(
                "dm:cmd",
                json!({ "type": "config", "config": settings_json(core) }),
            );
        }
    } else {
        if let Some(w) = app.get_webview_window(windows::CLOUD) {
            let _ = w.hide();
        }
        if core.overlay_visible.load(Ordering::SeqCst) {
            if let Some(w) = app.get_webview_window(OVERLAY) {
                let _ = w.show();
                if let Some(h) = windows::hwnd_of(app, OVERLAY) {
                    sys::apply_overlay_style(h, windows::MOUSE_CAPTURED.load(Ordering::SeqCst));
                    sys::force_top(h);
                }
            }
        }
    }
    core.push_state();
}

fn settings_json(core: &Arc<AppCore>) -> Value {
    settings::settings_to_json(&core.settings.get())
}

async fn confirm_and_end(app: &AppHandle, core: &Arc<AppCore>) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
    app.dialog()
        .message("将关闭手机端连接并清空内存中的全部消息（未导出的数据无法找回）。")
        .title("结束本次培训？")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "结束培训".into(),
            "取消".into(),
        ))
        .show(move |confirmed| {
            let _ = tx.send(confirmed);
        });

    if !rx.await.unwrap_or(false) {
        return;
    }
    core.end_session().await;
    for label in [windows::JOIN, windows::CLOUD] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.hide();
        }
    }
    clear_overlay(app);
    core.push_state();
}

fn apply_theme_background(app: &AppHandle, core: &Arc<AppCore>) {
    let dark = core.settings.get().theme != "light";
    let color = if dark {
        tauri::window::Color(0x12, 0x14, 0x1a, 0xff)
    } else {
        tauri::window::Color(0xf4, 0xf5, 0xf8, 0xff)
    };
    for label in [CONTROL, windows::JOIN] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.set_background_color(Some(color));
        }
    }
}

/* ------------------------------------------------------------------ 命令 */

#[tauri::command]
fn state_get(app: AppHandle) -> Value {
    let core = core_of(&app);
    let state = core.build_state(&app);
    refresh_tray_labels(&app, &core);
    state
}

#[tauri::command]
fn session_toggle_pause(app: AppHandle) -> Value {
    let core = core_of(&app);
    let paused = core.toggle_pause();
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let _ = w.emit(
            "dm:cmd",
            json!({ "type": if paused { "pause" } else { "resume" } }),
        );
    }
    core.push_state();
    core.build_state(&app)
}

#[tauri::command]
fn session_clear(app: AppHandle) -> bool {
    clear_overlay(&app);
    true
}

#[tauri::command]
async fn session_end(app: AppHandle) -> Value {
    let core = core_of(&app);
    confirm_and_end(&app, &core).await;
    core.build_state(&app)
}

#[tauri::command]
async fn session_restart(app: AppHandle) -> Value {
    let core = core_of(&app);
    if let Err(err) = core.restart_session().await {
        core.push_warning("error", &format!("重新开始失败：{err}"));
    }
    apply_mode(&app, &core).await;
    core.build_state(&app)
}

#[tauri::command]
fn session_replay(app: AppHandle, seq: u64) -> bool {
    core_of(&app).replay(seq)
}

#[tauri::command]
fn history_get(app: AppHandle) -> Value {
    let core = core_of(&app);
    json!({
        "items": core.public_history(200),
        "total": core.total.load(Ordering::SeqCst),
    })
}

#[tauri::command]
fn app_copy_link(app: AppHandle) -> bool {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let core = core_of(&app);
    let Some(session) = core.session() else {
        return false;
    };
    app.clipboard().write_text(session.url).is_ok()
}

#[tauri::command]
async fn app_open_repo(app: AppHandle) -> bool {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url("https://github.com/delaolao/LocalDanMu", None::<&str>)
        .is_ok()
}

#[tauri::command]
async fn app_open_network_settings(app: AppHandle) -> bool {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url("ms-settings:network-status", None::<&str>)
        .is_ok()
}

#[tauri::command]
async fn app_set_config(app: AppHandle, patch: Value) -> Value {
    let core = core_of(&app);
    core.settings.set(&patch);
    core.on_settings_changed(&patch);

    if patch.get("displayId").is_some() {
        let display = core
            .settings
            .get()
            .display_id
            .as_ref()
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        windows::apply_display(&app, display.as_deref());
    }
    if patch.get("theme").is_some() {
        apply_theme_background(&app, &core);
    }
    if patch.get("mode").is_some() {
        apply_mode(&app, &core).await;
    }
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let _ = w.emit(
            "dm:cmd",
            json!({ "type": "config", "config": settings_json(&core) }),
        );
    }
    core.push_state();
    settings_json(&core)
}

#[tauri::command]
async fn app_set_display(app: AppHandle, id: String) -> Value {
    let core = core_of(&app);
    core.settings.set(&json!({ "displayId": id }));
    let display = core
        .settings
        .get()
        .display_id
        .as_ref()
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    windows::apply_display(&app, display.as_deref());
    core.push_state();
    core.build_state(&app)
}

#[tauri::command]
async fn app_set_nic(app: AppHandle, address: Option<String>) -> Value {
    let core = core_of(&app);
    core.settings.set(&json!({ "preferredIp": address }));
    let core_bg = Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || core_bg.refresh_network())
        .await
        .ok();
    core.push_state();
    core.build_state(&app)
}

#[tauri::command]
async fn app_refresh_network(app: AppHandle) -> Value {
    let core = core_of(&app);
    let core_bg = Arc::clone(&core);
    tauri::async_runtime::spawn_blocking(move || core_bg.refresh_network())
        .await
        .ok();
    // 只刷新网卡不够：如果上次服务压根没起来，这里要把它真正拉起来
    if let Err(err) = core.ensure_session_started().await {
        core.set_warnings(vec![serde_json::json!({
            "level": "error",
            "text": format!("服务启动失败：{err}"),
            "hint": "检查 8080 端口是否被占用，或点「重新检测」再试"
        })]);
    }
    core.push_state();
    core.build_state(&app)
}

#[tauri::command]
async fn app_toggle_overlay(app: AppHandle) -> Value {
    // 必须 async：同步命令跑在主线程上，而任何会"创建/搬动窗口"的操作
    // 都需要主线程自己去处理排队任务——在主线程里同步等它就是死锁。
    toggle_overlay(&app);
    core_of(&app).build_state(&app)
}

#[tauri::command]
async fn app_toggle_join(app: AppHandle) -> Value {
    // **必须 async**。这是手动测试报"投屏引导页点不出来"的真因：
    // 同步命令在主线程执行，而 WebviewWindowBuilder::build() 要把创建请求
    // 投递给主线程并等待完成 —— 主线程正卡在命令里，于是整个 app 冻住，
    // 之后所有按钮、下拉框、退出全部失灵。
    let core = core_of(&app);
    toggle_join(&app, &core);
    core.build_state(&app)
}

#[tauri::command]
async fn app_set_mode(app: AppHandle, mode: String) -> Value {
    let core = core_of(&app);
    let mode = if mode == "cloud" { "cloud" } else { "scroll" };
    core.settings.set(&json!({ "mode": mode }));
    apply_mode(&app, &core).await;
    core.build_state(&app)
}

#[tauri::command]
async fn app_import_words(app: AppHandle) -> Value {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("导入自定义词表（一行一个）")
        .add_filter("词表", &["txt", "csv"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });

    let Some(Some(picked)) = rx.await.ok() else {
        return Value::Null;
    };
    let Ok(path) = picked.into_path() else {
        return Value::Null;
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return json!({ "error": "读取文件失败" });
    };

    let core = core_of(&app);
    let split = |s: &str| -> Vec<String> {
        s.split(['\r', '\n', ',', '，', '、', ';', '；'])
            .map(|w| w.trim().to_string())
            .filter(|w| !w.is_empty())
            .collect()
    };

    let incoming: Vec<String> = split(&raw).into_iter().take(2000).collect();
    let existing = split(&core.settings.get().custom_words);

    let mut merged: Vec<String> = existing.clone();
    for w in incoming {
        if !merged.contains(&w) {
            merged.push(w);
        }
    }
    let added = merged.len().saturating_sub(existing.len());
    let joined: String = merged.join("\n").chars().take(6000).collect();

    core.settings.set(&json!({ "customWords": joined }));
    core.on_settings_changed(&json!({ "customWords": joined }));
    core.push_state();

    json!({ "added": added, "total": merged.len() })
}

#[tauri::command]
async fn app_export(app: AppHandle) -> bool {
    use tauri_plugin_dialog::DialogExt;

    let core = core_of(&app);
    let items = core.public_history(usize::MAX);
    if items.is_empty() {
        let (tx, _rx) = tokio::sync::oneshot::channel::<bool>();
        app.dialog()
            .message("还没有收到任何消息")
            .title("导出")
            .show(move |_| {
                let _ = tx.send(true);
            });
        return false;
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("导出本次弹幕记录")
        .set_file_name(format!("弹幕记录_{}.json", date_stamp()))
        .add_filter("JSON", &["json"])
        .add_filter("CSV", &["csv"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });

    let Some(Some(picked)) = rx.await.ok() else {
        return false;
    };
    let Ok(path) = picked.into_path() else {
        return false;
    };

    let is_csv = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("csv"))
        .unwrap_or(false);

    let result = if is_csv {
        write_csv(&core, &path)
    } else {
        write_json(&core, &path)
    };

    let (title, body) = match &result {
        Ok(()) => ("导出完成", path.display().to_string()),
        Err(err) => ("导出失败", err.to_string()),
    };
    let (tx, _rx) = tokio::sync::oneshot::channel::<bool>();
    app.dialog().message(body).title(title).show(move |_| {
        let _ = tx.send(true);
    });

    result.is_ok()
}

fn write_csv(core: &Arc<AppCore>, path: &std::path::Path) -> std::io::Result<()> {
    // 带 BOM：否则 Excel 打开中文会乱码
    let mut out = String::from("\u{FEFF}序号,时间,类型,内容\r\n");
    for item in core.export_history() {
        let content = if item.content_type == "image" {
            "［图片，CSV 中省略，如需图片请导出 JSON］".to_string()
        } else {
            item.payload.clone()
        };
        let kind = if item.content_type == "image" {
            "图片"
        } else {
            "文字"
        };
        out.push_str(&format!(
            "{},{},{},{}\r\n",
            item.seq,
            csv_cell(&fmt_datetime(item.ts)),
            csv_cell(kind),
            csv_cell(&content)
        ));
    }
    std::fs::write(path, out)
}

fn write_json(core: &Arc<AppCore>, path: &std::path::Path) -> std::io::Result<()> {
    let session = core.session();
    let items: Vec<Value> = core
        .export_history()
        .iter()
        .map(|m| {
            json!({
                "seq": m.seq,
                "time": fmt_datetime(m.ts),
                "contentType": m.content_type,
                "content": m.payload,
            })
        })
        .collect();
    let payload = json!({
        "exportedAt": fmt_datetime(server::now_ms()),
        "room": session.map(|s| json!({ "token": s.token, "port": s.port })),
        "count": items.len(),
        "messages": items,
    });
    std::fs::write(
        path,
        serde_json::to_string_pretty(&payload).unwrap_or_default(),
    )
}

fn csv_cell(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn date_stamp() -> String {
    let now = fmt_datetime(server::now_ms());
    // 2026-11-02 19:56:49 -> 20261102_1956
    let digits: String = now.chars().filter(|c| c.is_ascii_digit()).collect();
    format!("{}_{}", &digits[..8], &digits[8..12])
}

/// `YYYY-MM-DD HH:MM:SS`（北京时间）。不引 chrono：只为一处格式化拖一个依赖不值得。
fn fmt_datetime(ms: u64) -> String {
    let total = ms / 1000 + 8 * 3600;
    let days = (total / 86400) as i64;
    let secs = total % 86400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}",
        secs / 3600,
        (secs / 60) % 60,
        secs % 60
    )
}

/// Howard Hinnant 的 civil_from_days 算法。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (y + i64::from(m <= 2), m, d)
}

#[tauri::command]
fn app_hide_panel(app: AppHandle) -> bool {
    if let Some(w) = app.get_webview_window(CONTROL) {
        let _ = w.hide();
    }
    true
}

#[tauri::command]
fn app_minimize(app: AppHandle) -> bool {
    if let Some(w) = app.get_webview_window(CONTROL) {
        let _ = w.minimize();
    }
    true
}

#[tauri::command]
async fn app_quit(app: AppHandle) -> bool {
    let core = core_of(&app);
    core.end_session().await;
    app.exit(0);
    true
}

#[tauri::command]
fn join_close(app: AppHandle) -> bool {
    if let Some(w) = app.get_webview_window(windows::JOIN) {
        let _ = w.hide();
    }
    core_of(&app).push_state();
    true
}

/// 鼠标压到图片上时临时接管鼠标，移开恢复穿透。
#[tauri::command]
fn dm_hover(app: AppHandle, on: bool) -> bool {
    windows::MOUSE_CAPTURED.store(on, Ordering::SeqCst);
    if let Some(h) = windows::hwnd_of(&app, OVERLAY) {
        sys::apply_overlay_style(h, on);
    }
    true
}

/// 大图模式：整屏都要能点（点任意位置关闭）。
#[tauri::command]
fn dm_modal(app: AppHandle, open: bool) -> bool {
    windows::MOUSE_CAPTURED.store(open, Ordering::SeqCst);
    if let Some(h) = windows::hwnd_of(&app, OVERLAY) {
        sys::apply_overlay_style(h, open);
    }
    true
}

/// 弹幕层渲染就绪：补推一次配置与暂停状态（旧版 `dm:ready`）。
#[tauri::command]
fn dm_ready(app: AppHandle) -> bool {
    let core = core_of(&app);
    if let Some(w) = app.get_webview_window(OVERLAY) {
        let _ = w.emit(
            "dm:cmd",
            json!({ "type": "config", "config": settings_json(&core) }),
        );
        if core.paused.load(Ordering::SeqCst) {
            let _ = w.emit("dm:cmd", json!({ "type": "pause" }));
        }
    }
    true
}

/* --------------------------------------------------------------- 远程模式 */

/// 开启远程模式（Cloudflare Tunnel）。内容强制端到端加密，中继看不到正文。
#[tauri::command]
fn tunnel_start(app: AppHandle) -> Value {
    let core = core_of(&app);
    let t = app.state::<std::sync::Arc<Tunnel>>().inner().clone();
    let Some(session) = core.session() else {
        return json!({ "status": "error", "message": "会话还没启动", "url": "", "qr": "" });
    };
    let cfg = core.settings.get();
    t.start(tunnel::StartArgs {
        port: session.port,
        room: session.token.clone(),
        tunnel_token: cfg.tunnel_token.clone(),
        host: cfg.tunnel_host.clone(),
        cloudflared_path: Some(cfg.cloudflared_path.clone()).filter(|s| !s.trim().is_empty()),
    });
    t.snapshot()
}

#[tauri::command]
fn tunnel_stop(app: AppHandle) -> Value {
    let t = app.state::<std::sync::Arc<Tunnel>>().inner().clone();
    t.stop();
    t.snapshot()
}

/// 自动续连开关：隧道意外断开时自动重开
#[tauri::command]
fn tunnel_set_auto(app: AppHandle, on: bool) -> Value {
    let t = app.state::<std::sync::Arc<Tunnel>>().inner().clone();
    t.set_auto(on);
    t.snapshot()
}

#[tauri::command]
fn tunnel_state(app: AppHandle) -> Value {
    app.state::<std::sync::Arc<Tunnel>>().inner().snapshot()
}

/// 手动指定 cloudflared.exe —— 自动下载怎么都失败时的逃生口。
///
/// 现实中"浏览器能下、程序不能"几乎都是代理/证书环境的差异，所以必须给用户
/// 一条自己选文件的路，而不是让他去猜某个 `%LOCALAPPDATA%` 子目录该怎么放文件。
#[tauri::command]
async fn app_pick_cloudflared(app: AppHandle) -> Value {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("选择 cloudflared.exe（浏览器下载的那个文件也行，不必改名）")
        .add_filter("可执行文件", &["exe"])
        .add_filter("全部文件", &["*"])
        .pick_file(move |p| {
            let _ = tx.send(p);
        });

    let Some(Some(picked)) = rx.await.ok() else {
        return json!({ "ok": false, "canceled": true });
    };
    let Ok(path) = picked.into_path() else {
        return json!({ "ok": false, "error": "路径无效" });
    };

    // 先校验再保存：选错了当场告诉用户，而不是等到开隧道时才炸
    match tunnel::validate_exe(&path) {
        Ok(bytes) => {
            let core = core_of(&app);
            core.settings
                .set(&json!({ "cloudflaredPath": path.to_string_lossy() }));
            core.push_state();
            json!({
                "ok": true,
                "path": path.display().to_string(),
                "mb": (bytes as f64 / 1_048_576.0 * 10.0).round() / 10.0,
            })
        }
        Err(e) => json!({ "ok": false, "error": e }),
    }
}
