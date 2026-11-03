//! 会话与状态中枢：把「服务端 <-> 窗口」粘起来的那一层。
//!
//! 对应旧版 `main.js` 里除窗口管理以外的部分：
//! 历史（仅内存）、会话生命周期、网络重算、二维码刷新、状态推送、点赞复现。
//!
//! 三个不变式（沿用旧版设计）：
//! 1. **消息只存在内存里**，结束培训即释放，绝不落盘；
//! 2. 推给窗口的历史副本**去掉图片正文**（`compact`），否则每来一张图就要把
//!    几百 KB 的 base64 广播给三个窗口；
//! 3. 状态变化用 120ms 合并刷新（`schedule_push`），避免连发消息时渲染层高频重排。

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::network;
use crate::qr;
use crate::server::{Bridge, BridgeConfig, MessageSink, Outgoing, Signals, ServerState};
use crate::settings::{settings_to_json, Store};

pub const HISTORY_MAX_TEXT: usize = 300;
pub const HISTORY_MAX_IMAGE: usize = 20;
/// 点赞数跨过这些台阶时自动把这条重新推上屏（"共鸣"效果）
const LIKE_REPLAY_STEPS: [u32; 5] = [5, 10, 20, 50, 100];
const REPLAY_COOLDOWN: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct Session {
    pub port: u16,
    pub token: String,
    pub ip: String,
    pub nic_name: String,
    pub url: String,
}

/// 历史里的一条。图片正文留在 `payload` 里（只在内存中）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub seq: u64,
    pub content_type: String,
    pub payload: String,
    pub color: Option<String>,
    pub likes: u32,
    pub flagged: bool,
    pub flag_category: Option<String>,
    pub ts: u64,
    pub client_id: Option<String>,
}

impl From<&Outgoing> for HistoryItem {
    fn from(m: &Outgoing) -> Self {
        HistoryItem {
            seq: m.seq,
            content_type: m.content_type.clone(),
            payload: m.payload.clone(),
            color: m.color.clone(),
            likes: m.likes,
            flagged: m.flagged,
            flag_category: m.flag_category.clone(),
            ts: m.ts,
            client_id: m.client_id.clone(),
        }
    }
}

impl HistoryItem {
    /// 给界面用的精简条目：**不带图片正文**。
    pub fn compact(&self) -> Value {
        json!({
            "seq": self.seq,
            "ts": self.ts,
            "contentType": self.content_type,
            "text": if self.content_type == "text" { self.payload.clone() } else { String::new() },
            "color": self.color,
            "likes": self.likes,
            "flagged": self.flagged,
            "flagCategory": self.flag_category,
        })
    }
}

pub struct AppCore {
    pub settings: Arc<Store>,
    history: Mutex<Vec<HistoryItem>>,
    session: Mutex<Option<Session>>,
    bridge: Mutex<Option<Bridge>>,
    pub paused: AtomicBool,
    pub ended: AtomicBool,
    pub online: AtomicUsize,
    pub total: AtomicU32,
    qr: Mutex<String>,
    warnings: Mutex<Vec<Value>>,
    pub overlay_visible: AtomicBool,
    shortcut_report: Mutex<Value>,
    profiles_cache: Mutex<Option<(Instant, Vec<network::ConnectionProfile>)>>,
    push_scheduled: AtomicBool,
    last_like_replay: Mutex<Option<Instant>>,
    /// 远程模式的端到端密钥槽（与 Tunnel 共享）
    remote_key: crate::crypto::RemoteKey,
}

impl AppCore {
    pub fn new(settings: Arc<Store>, remote_key: crate::crypto::RemoteKey) -> Arc<AppCore> {
        Arc::new(AppCore {
            settings,
            remote_key,
            history: Mutex::new(Vec::new()),
            session: Mutex::new(None),
            bridge: Mutex::new(None),
            paused: AtomicBool::new(false),
            ended: AtomicBool::new(false),
            online: AtomicUsize::new(0),
            total: AtomicU32::new(0),
            qr: Mutex::new(String::new()),
            warnings: Mutex::new(Vec::new()),
            overlay_visible: AtomicBool::new(true),
            shortcut_report: Mutex::new(json!({})),
            profiles_cache: Mutex::new(None),
            push_scheduled: AtomicBool::new(false),
            last_like_replay: Mutex::new(None),
        })
    }

    /* --------------------------------------------------------------- 会话 */

    pub fn session(&self) -> Option<Session> {
        self.session.lock().ok().and_then(|g| g.clone())
    }

    pub fn qr(&self) -> String {
        self.qr.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn server_state(&self) -> Option<ServerState> {
        self.bridge.lock().ok().and_then(|g| g.as_ref().map(|b| b.state.clone()))
    }

    /// 起一场新培训：选端口、生成口令、选网卡、起服务、生成二维码。
    pub async fn start_session(self: &Arc<Self>) -> Result<(), String> {
        self.ended.store(false, Ordering::SeqCst);
        self.paused.store(false, Ordering::SeqCst);
        self.total.store(0, Ordering::SeqCst);
        self.online.store(0, Ordering::SeqCst);
        if let Ok(mut h) = self.history.lock() {
            h.clear();
        }

        let settings = self.settings.get();
        // 开发/自动化测试可用 LDM_TOKEN 固定房间号（打包后忽略，避免被误用）
        let token = if cfg!(debug_assertions) {
            std::env::var("LDM_TOKEN").unwrap_or_else(|_| crate::server::random_token(8))
        } else {
            crate::server::random_token(8)
        };
        let picked = network::pick(settings.preferred_ip.as_deref());
        let ip = picked.address.to_string();

        let filter = crate::filter::Filter::from_settings(&settings.filter_level, &settings.custom_words);

        let sink: Arc<dyn MessageSink> = Arc::new(CoreSink {
            app: app_handle(),
            core: Arc::clone(self),
        });

        let bridge = Bridge::start(BridgeConfig {
            token: token.clone(),
            interval_sec: settings.interval_sec,
            filter: Some(filter),
            sink,
            preferred_port: 8080,
            remote_key: Arc::clone(&self.remote_key),
        })
        .await
        .map_err(|e| format!("服务启动失败：{e}"))?;

        let port = bridge.port;
        let url = bridge.url(&ip);
        {
            let mut s = self.session.lock().map_err(|_| "会话状态损坏")?;
            *s = Some(Session {
                port,
                token: token.clone(),
                ip: ip.clone(),
                nic_name: picked.name.clone(),
                url: url.clone(),
            });
        }
        {
            let mut b = self.bridge.lock().map_err(|_| "服务状态损坏")?;
            *b = Some(bridge);
        }

        self.refresh_qr();

        // 调试/自动化探针需要知道本次会话的地址（仅 debug 构建写这个文件）
        if probe_enabled() {
            let dir = probe_dir();
            let _ = std::fs::create_dir_all(&dir);
            let _ = std::fs::write(
                dir.join("session.json"),
                json!({ "url": url, "port": port, "token": token }).to_string(),
            );
        }
        Ok(())
    }

    pub async fn end_session(self: &Arc<Self>) {
        self.ended.store(true, Ordering::SeqCst);
        self.paused.store(false, Ordering::SeqCst);
        let bridge = self.bridge.lock().ok().and_then(|mut g| g.take());
        if let Some(b) = bridge {
            b.shutdown("ended").await;
        }
        if let Ok(mut h) = self.history.lock() {
            h.clear();
        }
        if let Ok(mut s) = self.session.lock() {
            *s = None;
        }
        if let Ok(mut q) = self.qr.lock() {
            q.clear();
        }
        self.total.store(0, Ordering::SeqCst);
        self.online.store(0, Ordering::SeqCst);
    }

    pub async fn restart_session(self: &Arc<Self>) {
        let bridge = self.bridge.lock().ok().and_then(|mut g| g.take());
        if let Some(b) = bridge {
            b.shutdown("restart").await;
        }
        if let Ok(mut s) = self.session.lock() {
            *s = None;
        }
        let _ = self.start_session().await;
    }

    pub fn toggle_pause(&self) -> bool {
        if self.session().is_none() {
            return self.paused.load(Ordering::SeqCst);
        }
        let next = !self.paused.load(Ordering::SeqCst);
        self.paused.store(next, Ordering::SeqCst);
        if let Some(st) = self.server_state() {
            st.live().set_paused(next);
            st.broadcast_json(&json!({ "type": "paused", "paused": next }));
        }
        next
    }

    /// 设置变更后需要同步给服务端的部分。
    pub fn on_settings_changed(&self, patch: &Value) {
        if let Some(st) = self.server_state() {
            if patch.get("intervalSec").is_some() {
                let secs = self.settings.get().interval_sec;
                st.live().set_interval_sec(secs);
                st.broadcast_json(&json!({ "type": "config", "intervalSec": secs }));
            }
            if patch.get("filterLevel").is_some() || patch.get("customWords").is_some() {
                let s = self.settings.get();
                st.set_filter(Some(crate::filter::Filter::from_settings(&s.filter_level, &s.custom_words)));
            }
        }
    }

    /* --------------------------------------------------------------- 历史 */

    pub fn handle_incoming(&self, msg: &Outgoing) {
        self.total.fetch_add(1, Ordering::SeqCst);
        // 探针用：记录每条真正上屏的消息（仅显式开启 LDM_PROBE=1 时写）
        if probe_enabled() {
            use std::io::Write as _;
            let dir = probe_dir();
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("items.log"))
            {
                let _ = writeln!(
                    f,
                    "seq={} kind={} len={} total={}",
                    msg.seq,
                    msg.content_type,
                    msg.payload.chars().count(),
                    self.total.load(Ordering::SeqCst)
                );
            }
        }
        let item = HistoryItem::from(msg);
        let brief = item.compact();
        if let Ok(mut h) = self.history.lock() {
            h.push(item);
            trim_history(&mut h);
        }
        if let Some(app) = app_handle() {
            // 两种载荷形状，用两个事件名分开，**不要**共用一个事件：
            //
            // - `dm:item`      → 精简副本（无图片正文），控制面板/词云用，广播一次即可；
            // - `dm:item-full` → 完整消息（图片正文在 payload 里），只有弹幕层要。
            //
            // 为什么不能都叫 `dm:item` 再靠 emit_to 区分：Tauri 的 emit_to 在这里
            // 会把事件发给所有 webview（实测），于是控制面板会同时收到完整版和精简版，
            // 表现为"一条消息在最近弹幕里出现三次、其中一条空白"。
            // 拆成两个事件名之后，目标窗口各自只监听自己认识的那个，问题消失。
            let _ = app.emit("dm:item", &brief);
            let _ = app.emit_to("overlay", "dm:item-full", msg);
        }
    }

    pub fn handle_like_signal(&self, seq: u64, likes: u32) {
        if let Ok(mut h) = self.history.lock() {
            if let Some(item) = h.iter_mut().find(|m| m.seq == seq) {
                item.likes = likes;
            }
        }
        if let Some(app) = app_handle() {
            let _ = app.emit("dm:like", json!({ "seq": seq, "likes": likes }));
        }
        self.maybe_replay_by_likes(seq, likes);
    }

    fn maybe_replay_by_likes(&self, seq: u64, likes: u32) {
        let settings = self.settings.get();
        if !settings.auto_replay {
            return;
        }
        if settings.mode != "scroll" {
            return; // 词云模式下不打断讲师
        }
        if !LIKE_REPLAY_STEPS.contains(&likes) {
            return;
        }
        // 15 秒内只复现一次，避免刷屏
        {
            let mut last = match self.last_like_replay.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if let Some(at) = *last {
                if at.elapsed() < REPLAY_COOLDOWN {
                    return;
                }
            }
            *last = Some(Instant::now());
        }
        let item = {
            let h = match self.history.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            h.iter().find(|m| m.seq == seq).cloned()
        };
        if let (Some(item), Some(app)) = (item, app_handle()) {
            let _ = app.emit_to("overlay", "dm:item-full", json!({
                "seq": item.seq,
                "contentType": item.content_type,
                "payload": item.payload,
                "color": item.color,
                "likes": item.likes,
                "flagged": item.flagged,
                "flagCategory": item.flag_category,
                "ts": item.ts,
                "clientId": item.client_id,
                "replay": true,
            }));
        }
    }

    /// 覆盖告警列表（启动失败、网络异常等由主程序设置）。
    pub fn set_warnings(&self, warnings: Vec<Value>) {
        if let Ok(mut w) = self.warnings.lock() {
            *w = warnings;
        }
    }

    /// 导出用：完整历史（含图片正文）。只在讲师主动导出时调用。
    pub fn export_history(&self) -> Vec<HistoryItem> {
        match self.history.lock() {
            Ok(g) => g.clone(),
            Err(p) => p.into_inner().clone(),
        }
    }
    pub fn public_history(&self, limit: usize) -> Vec<Value> {
        let h = match self.history.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let start = h.len().saturating_sub(limit);
        h[start..].iter().map(|m| m.compact()).collect()
    }

    /// 重播某条：切回滚动模式再推上屏，不计数、不入历史。
    pub fn replay(&self, seq: u64) -> bool {
        let item = {
            let h = match self.history.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            h.iter().find(|m| m.seq == seq).cloned()
        };
        let Some(item) = item else { return false };
        let Some(app) = app_handle() else { return false };
        let _ = app.emit_to("overlay", "dm:item-full", json!({
            "seq": item.seq,
            "contentType": item.content_type,
            "payload": item.payload,
            "color": item.color,
            "likes": item.likes,
            "flagged": item.flagged,
            "flagCategory": item.flag_category,
            "ts": item.ts,
            "clientId": item.client_id,
            "replayed": true,
        }));
        let _ = app.emit("dm:replayed", json!({ "seq": seq }));
        true
    }

    /* --------------------------------------------------------- 网络与二维码 */

    pub fn refresh_qr(&self) {
        let Some(session) = self.session() else { return };
        let generated = qr::data_url(&session.url).unwrap_or_default();
        if let Ok(mut q) = self.qr.lock() {
            *q = generated;
        }
    }

    /// 重算网卡与网络位置，必要时刷新二维码（IP 变了二维码要跟着变）。
    pub fn refresh_network(&self) {
        let settings = self.settings.get();
        let picked = network::pick(settings.preferred_ip.as_deref());
        let mut warnings: Vec<Value> = Vec::new();

        if picked.fallback || picked.address.is_loopback() {
            warnings.push(json!({
                "level": "error",
                "text": "没有检测到可用的局域网地址，手机将无法访问。请连接 WiFi 或热点后点「重新检测」。",
                "action": "refresh"
            }));
        } else if picked.is_virtual {
            warnings.push(json!({
                "level": "warn",
                "text": format!("当前选中「{}」看起来是虚拟网卡，手机可能连不上。请在设置里换一个网卡。", picked.name),
                "action": "settings"
            }));
        }

        // 公用网络下 Windows 防火墙默认拦截入站，这是"手机扫码打不开"的第二大原因
        let profiles = self.connection_profiles_cached();
        if !profiles.is_empty() {
            let hit = profiles.iter().find(|p| {
                p.interface_alias.eq_ignore_ascii_case(&picked.name) || p.name.eq_ignore_ascii_case(&picked.name)
            });
            let any_public = hit.map(|h| h.is_public()).unwrap_or_else(|| profiles.iter().any(|p| p.is_public()));
            if any_public {
                warnings.push(json!({
                    "level": "warn",
                    "text": "当前网络被 Windows 识别为「公用网络」，防火墙默认会拦截手机访问。建议改为「专用网络」，或为本程序放行。",
                    "action": "networkSettings"
                }));
            }
        }

        if let Ok(mut w) = self.warnings.lock() {
            *w = warnings;
        }

        // IP 变了就更新会话地址并重画二维码
        let next_ip = picked.address.to_string();
        let changed = {
            let mut s = match self.session.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            match s.as_mut() {
                Some(session) if session.ip != next_ip || session.nic_name != picked.name => {
                    session.ip = next_ip;
                    session.nic_name = picked.name.clone();
                    session.url = format!("http://{}:{}/j/{}", session.ip, session.port, session.token);
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.refresh_qr();
        }
    }

    fn connection_profiles_cached(&self) -> Vec<network::ConnectionProfile> {
        {
            let cache = match self.profiles_cache.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if let Some((at, list)) = cache.as_ref() {
                if at.elapsed() < Duration::from_secs(60) {
                    return list.clone();
                }
            }
        }
        let list = network::connection_profiles();
        let mut cache = match self.profiles_cache.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        *cache = Some((Instant::now(), list.clone()));
        list
    }

    pub fn nics(&self) -> Vec<Value> {
        let current_ip = self.session().map(|s| s.ip).unwrap_or_default();
        network::list_candidates()
            .into_iter()
            .map(|c| {
                json!({
                    "address": c.address.to_string(),
                    "name": c.name,
                    "virtual": c.is_virtual,
                    "current": c.address.to_string() == current_ip,
                })
            })
            .collect()
    }

    pub fn set_shortcut_report(&self, report: Value) {
        if let Ok(mut g) = self.shortcut_report.lock() {
            *g = report;
        }
    }

    /* ------------------------------------------------------------- 状态快照 */

    /// 与旧版 `buildState()` 字段一一对应。
    pub fn build_state(&self, app: &AppHandle) -> Value {
        let settings = self.settings.get();
        let session = self.session();
        let signals = self
            .server_state()
            .map(|st| st.signals())
            .unwrap_or(Signals { total: Default::default(), recent: Default::default(), window_ms: 60000 });

        let displays = collect_displays(app);
        let selected = selected_display_id(app, settings.display_id.as_ref());

        json!({
            "ready": session.is_some(),
            "url": session.as_ref().map(|s| s.url.clone()).unwrap_or_default(),
            "token": session.as_ref().map(|s| s.token.clone()).unwrap_or_default(),
            "ip": session.as_ref().map(|s| s.ip.clone()).unwrap_or_default(),
            "port": session.as_ref().map(|s| s.port).unwrap_or(0),
            "nicName": session.as_ref().map(|s| s.nic_name.clone()).unwrap_or_default(),
            "nics": self.nics(),
            "online": self.online.load(Ordering::SeqCst),
            "total": self.total.load(Ordering::SeqCst),
            "paused": self.paused.load(Ordering::SeqCst),
            "ended": self.ended.load(Ordering::SeqCst),
            "qr": self.qr(),
            "displays": displays,
            "selectedDisplay": selected,
            "overlayVisible": self.overlay_visible.load(Ordering::SeqCst),
            "joinVisible": join_visible(app),
            "config": settings_to_json(&settings),
            "signals": signals,
            "warnings": self.warnings.lock().map(|g| g.clone()).unwrap_or_default(),
            "shortcuts": self.shortcut_report.lock().map(|g| g.clone()).unwrap_or_else(|_| json!({})),
            "version": env!("CARGO_PKG_VERSION"),
        })
    }

    /// 推状态给所有窗口（120ms 合并）。
    pub fn schedule_push(self: &Arc<Self>) {
        if self.push_scheduled.swap(true, Ordering::SeqCst) {
            return;
        }
        let core = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(120)).await;
            core.push_scheduled.store(false, Ordering::SeqCst);
            core.push_state();
        });
    }

    pub fn push_state(&self) {
        let Some(app) = app_handle() else { return };
        let state = self.build_state(&app);
        let _ = app.emit("state", state);
    }
}

/// 全局 AppHandle 句柄：方便各处（含非 UI 线程）推事件。
static APP_HANDLE: Mutex<Option<AppHandle>> = Mutex::new(None);

/// 取全局 AppHandle 的副本（Mutex<Option<..>> 不能直接 `.get()`）。
fn app_handle() -> Option<AppHandle> {
    APP_HANDLE.lock().ok().and_then(|g| g.clone())
}

pub fn install_app_handle(app: AppHandle) {
    if let Ok(mut g) = APP_HANDLE.lock() {
        *g = Some(app);
    }
}

/// 探针钩子是否开启。默认关闭——release 产物不会把房间口令写到磁盘上。
/// 现场排障或自动化验证时设环境变量 `LDM_PROBE=1` 即可。
pub fn probe_enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("LDM_PROBE").map(|v| v == "1").unwrap_or(false))
}

pub fn probe_dir() -> std::path::PathBuf {
    std::env::temp_dir().join("localdanmu-debug")
}

/// 往探针日志里追加一行（仅在 `LDM_PROBE=1` 时有效）。
pub fn probe_log(line: &str) {
    if !probe_enabled() {
        return;
    }
    use std::io::Write as _;
    let dir = probe_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("probe.log"))
    {
        let _ = writeln!(f, "{line}");
    }
}

fn trim_history(history: &mut Vec<HistoryItem>) {
    let mut images = history.iter().filter(|m| m.content_type == "image").count();
    let mut i = 0;
    while i < history.len() && (history.len() > HISTORY_MAX_TEXT || images > HISTORY_MAX_IMAGE) {
        if history[i].content_type == "image" {
            history.remove(i);
            images -= 1;
        } else if history.len() > HISTORY_MAX_TEXT {
            history.remove(i);
        } else {
            i += 1;
        }
    }
}

pub fn collect_displays(app: &AppHandle) -> Vec<Value> {
    let primary = app.primary_monitor().ok().flatten();
    let primary_name = primary.as_ref().map(|m| m.name().cloned().unwrap_or_default());

    match app.available_monitors() {
        Ok(list) => list
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let size = m.size();
                let is_primary = m.name() == primary_name.as_ref();
                json!({
                    "id": m.name().cloned().unwrap_or_else(|| format!("monitor-{i}")),
                    "label": format!("{}. {}×{}{}", i + 1, size.width, size.height,
                        if is_primary { "（主屏）" } else { "" }),
                    "width": size.width,
                    "height": size.height,
                })
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

pub fn selected_display_id(app: &AppHandle, saved: Option<&Value>) -> String {
    let saved = saved.and_then(|v| v.as_str()).unwrap_or("");
    if !saved.is_empty() {
        if let Ok(list) = app.available_monitors() {
            if list.iter().any(|m| m.name().map(|n| n.as_str()) == Some(saved)) {
                return saved.to_string();
            }
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .and_then(|m| m.name().cloned())
        .unwrap_or_default()
}

fn join_visible(app: &AppHandle) -> bool {
    app.get_webview_window("join")
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

/* ------------------------------------------------------------------- Sink */

/// 把服务端的回调接到窗口上。
struct CoreSink {
    app: Option<AppHandle>,
    core: Arc<AppCore>,
}

impl MessageSink for CoreSink {
    fn on_message(&self, msg: &Outgoing) {
        self.core.handle_incoming(msg);
        self.core.schedule_push();
    }

    fn on_like(&self, seq: u64, likes: u32) {
        self.core.handle_like_signal(seq, likes);
        self.core.schedule_push();
    }

    fn on_signals(&self, _snap: &Signals) {
        self.core.schedule_push();
    }

    fn on_online(&self, online: usize) {
        self.core.online.store(online, Ordering::SeqCst);
        self.core.schedule_push();
    }

    fn on_log(&self, kind: &str, detail: &str) {
        if let Some(app) = &self.app {
            let _ = app.emit("dm:log", json!({ "kind": kind, "detail": detail }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(seq: u64, kind: &str) -> HistoryItem {
        HistoryItem {
            seq,
            content_type: kind.into(),
            payload: if kind == "text" { "hi".into() } else { "data:image/png;base64,AAAA".into() },
            color: None,
            likes: 0,
            flagged: false,
            flag_category: None,
            ts: 0,
            client_id: None,
        }
    }

    #[test]
    fn compact_strips_image_payload() {
        let img = item(1, "image");
        let brief = img.compact();
        assert_eq!(brief["contentType"], "image");
        assert_eq!(brief["text"], "", "图片正文绝不能进推给界面的副本");
        assert!(!serde_json::to_string(&brief).unwrap().contains("base64"));
    }

    #[test]
    fn compact_keeps_text_and_metadata() {
        let mut t = item(2, "text");
        t.color = Some("#7ee787".into());
        t.likes = 3;
        let brief = t.compact();
        assert_eq!(brief["text"], "hi");
        assert_eq!(brief["color"], "#7ee787");
        assert_eq!(brief["likes"], 3);
    }

    #[test]
    fn history_trims_text_to_300() {
        let mut h: Vec<HistoryItem> = (0..350).map(|i| item(i, "text")).collect();
        trim_history(&mut h);
        assert_eq!(h.len(), HISTORY_MAX_TEXT);
        assert_eq!(h.first().unwrap().seq, 50, "丢的应当是最老的");
        assert_eq!(h.last().unwrap().seq, 349);
    }

    #[test]
    fn history_trims_images_to_20_without_dropping_all_text() {
        let mut h: Vec<HistoryItem> = Vec::new();
        for i in 0..30 {
            h.push(item(i, "image"));
        }
        for i in 30..60 {
            h.push(item(i, "text"));
        }
        trim_history(&mut h);
        let images = h.iter().filter(|m| m.content_type == "image").count();
        assert_eq!(images, HISTORY_MAX_IMAGE, "图片最多留 20 张");
        assert!(h.len() > HISTORY_MAX_IMAGE, "文字不该被图片挤光");
    }

    #[test]
    fn trim_is_stable_when_under_limits() {
        let mut h: Vec<HistoryItem> = (0..10).map(|i| item(i, "text")).collect();
        trim_history(&mut h);
        assert_eq!(h.len(), 10);
    }
}
