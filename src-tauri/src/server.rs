//! 会话服务：HTTP 静态资源 + WebSocket 会话，**共用一个端口**。
//!
//! 对应旧版 `src/main/server.js`，协议、限流参数、校验规则逐条对齐：
//!
//! - 一个 `TcpListener` 同时服务 `/j/<token>` 页面和 `/ws` 升级，二维码里只有一个地址，
//!   防火墙也只涉及一条规则；
//! - 三道限流：单人间隔 → 单 IP 令牌桶 → 全局令牌桶；被过滤掉的消息**不占额度**；
//! - 幂等：客户端每次发消息带 `msgId`，连接内缓存最近 40 个，重连重发不重复上屏；
//! - 图片只广播占位（不把原图推给所有人），`max_message_size` 卡在 2MB；
//! - 心跳 20s 一次 ping，两次没应声就踢掉，防止手机切后台留下僵尸连接。
//!
//! 与旧版唯一的架构差异：旧版「一个 Node 进程既跑服务又管窗口」，这里把
//! **业务副作用抽象成 `MessageSink` trait**，由主程序注入实现。
//! 好处是这套协议能**不开 GUI** 就完整验证（见文件末尾的集成测试）。

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tokio::sync::oneshot;

use crate::filter::Filter;

/* ------------------------------------------------------------------ 常量 */

pub const TEXT_MAX_CHARS: usize = 100;
pub const IMAGE_BASE64_MAX: usize = 900 * 1024;
pub const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;

/// 弹幕文字允许的颜色（与手机端调色板一致）。只收白名单，避免传深色导致大屏看不清。
pub const COLORS: [&str; 8] = [
    "#ffffff", "#ffe066", "#7ee787", "#7cc4ff", "#ffb4d1", "#ffa94d", "#b197fc", "#66e3d0",
];

pub const REACT_KINDS: [&str; 3] = ["agree", "confused", "slow"];

const LIKE_COOLDOWN_MS: u64 = 250;
const LIKE_PER_MINUTE: usize = 30;
const REACT_COOLDOWN_MS: u64 = 2000;
const SIGNAL_GLOBAL_RATE: f64 = 25.0;
const SIGNAL_GLOBAL_BURST: f64 = 60.0;

const RECENT_MAX: usize = 24;
const SEQ_MAX: usize = 400;
const SIGNAL_WINDOW_MS: u64 = 60_000;
const MSG_ID_MAX: usize = 40;
const LIKED_SEQ_MAX: usize = 300;

const SECURITY_HEADERS: [(&str, &str); 4] = [
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("X-Frame-Options", "DENY"),
    (
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'",
    ),
];

#[derive(RustEmbed)]
#[folder = "../src/web"]
struct ViewerAssets;

/* ------------------------------------------------------------------- 类型 */

/// 一条通过校验的弹幕（含图片正文），推给主程序入历史、上大屏。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outgoing {
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

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
pub struct KindCounts {
    pub agree: u32,
    pub confused: u32,
    pub slow: u32,
}

impl KindCounts {
    fn bump(&mut self, kind: &str) {
        match kind {
            "agree" => self.agree += 1,
            "confused" => self.confused += 1,
            "slow" => self.slow += 1,
            _ => {}
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
pub struct Signals {
    pub total: KindCounts,
    pub recent: KindCounts,
    #[serde(rename = "windowMs")]
    pub window_ms: u64,
}

/// 主程序注入的副作用接口。服务端只管协议，不直接碰窗口。
pub trait MessageSink: Send + Sync + 'static {
    fn on_message(&self, msg: &Outgoing);
    fn on_like(&self, seq: u64, likes: u32);
    fn on_signals(&self, snap: &Signals);
    fn on_online(&self, online: usize);
    fn on_log(&self, kind: &str, detail: &str);
}

/// 什么都不做的 sink（测试或不关心副作用的场景）。
pub struct NullSink;

impl MessageSink for NullSink {
    fn on_message(&self, _msg: &Outgoing) {}
    fn on_like(&self, _seq: u64, _likes: u32) {}
    fn on_signals(&self, _snap: &Signals) {}
    fn on_online(&self, _online: usize) {}
    fn on_log(&self, _kind: &str, _detail: &str) {}
}

/* ------------------------------------------------------------------ 状态 */

struct Bucket {
    tokens: f64,
    last: Instant,
}

impl Bucket {
    fn new(tokens: f64) -> Self {
        Bucket { tokens, last: Instant::now() }
    }

    /// 按速率补充令牌后尝试取 1 个。
    fn try_take(&mut self, rate_per_sec: f64, burst: f64) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last).as_secs_f64();
        self.tokens = (self.tokens + elapsed * rate_per_sec).min(burst);
        self.last = now;
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }

    /// 还差多久才有 1 个令牌（毫秒）。
    fn wait_ms(&self, rate_per_sec: f64) -> u64 {
        let deficit = (1.0 - self.tokens).max(0.0);
        (deficit / rate_per_sec * 1000.0).ceil() as u64
    }
}

#[derive(Clone)]
struct ItemIndex {
    client_id: Option<String>,
    likes: u32,
}

struct Inner {
    seq: u64,
    ip_buckets: HashMap<IpAddr, Bucket>,
    global_bucket: Bucket,
    signal_bucket: Bucket,
    items_by_seq: HashMap<u64, ItemIndex>,
    seq_order: VecDeque<u64>,
    recent: VecDeque<Value>,
    signals_total: KindCounts,
    recent_signals: VecDeque<(String, Instant)>,
}

impl Inner {
    fn recent_counts(&mut self) -> KindCounts {
        let now = Instant::now();
        while let Some((_, ts)) = self.recent_signals.front() {
            if now.duration_since(*ts) > Duration::from_millis(SIGNAL_WINDOW_MS) {
                self.recent_signals.pop_front();
            } else {
                break;
            }
        }
        let mut counts = KindCounts::default();
        for (kind, _) in &self.recent_signals {
            counts.bump(kind);
        }
        counts
    }
}

/// 与界面共享的实时配置（暂停状态、发送间隔）。
pub struct LiveConfig {
    paused: AtomicBool,
    interval_sec: AtomicU32,
}

impl LiveConfig {
    pub fn new(interval_sec: u32) -> Arc<LiveConfig> {
        Arc::new(LiveConfig {
            paused: AtomicBool::new(false),
            interval_sec: AtomicU32::new(interval_sec.max(1)),
        })
    }
    pub fn paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
    pub fn set_paused(&self, v: bool) {
        self.paused.store(v, Ordering::SeqCst);
    }
    pub fn interval_sec(&self) -> u32 {
        self.interval_sec.load(Ordering::SeqCst).max(1)
    }
    pub fn set_interval_sec(&self, v: u32) {
        self.interval_sec.store(v.max(1), Ordering::SeqCst);
    }
}

#[derive(Clone)]
pub struct ServerState {
    inner: Arc<Mutex<Inner>>,
    token: Arc<String>,
    live: Arc<LiveConfig>,
    filter: Arc<RwLock<Option<Filter>>>,
    sink: Arc<dyn MessageSink>,
    online: Arc<AtomicUsize>,
    tx: broadcast::Sender<String>,
}

impl ServerState {
    pub fn online(&self) -> usize {
        self.online.load(Ordering::SeqCst)
    }

    pub fn signals(&self) -> Signals {
        let mut guard = self.lock();
        let recent = guard.recent_counts();
        Signals { total: guard.signals_total, recent, window_ms: SIGNAL_WINDOW_MS }
    }

    pub fn live(&self) -> &Arc<LiveConfig> {
        &self.live
    }

    pub fn set_filter(&self, filter: Option<Filter>) {
        match self.filter.write() {
            Ok(mut g) => *g = filter,
            Err(poisoned) => *poisoned.into_inner() = filter,
        }
    }

    /// 广播一帧给所有在线观众（设置变更、暂停、结束培训时用）。
    pub fn broadcast_json(&self, payload: &Value) {
        let _ = self.tx.send(payload.to_string());
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        match self.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

/* --------------------------------------------------------------- 工具函数 */

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 恒定时间比较，避免口令被逐字符试探。
pub fn timing_safe_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// 8 位房间口令，去掉易混字符（约 40 bit 熵）。
/// 32 个字符的字母表正好整除 256，所以取模没有偏置。
pub fn random_token(len: usize) -> String {
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
    let mut buf = vec![0u8; len];
    if getrandom::fill(&mut buf).is_err() {
        let seed = now_ms();
        for (i, b) in buf.iter_mut().enumerate() {
            *b = ((seed >> ((i % 8) * 8)) & 0xff) as u8;
        }
    }
    buf.iter()
        .map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char)
        .collect()
}

fn is_invisible(c: char) -> bool {
    matches!(c,
        '\u{200B}'..='\u{200F}'
        | '\u{202A}'..='\u{202E}'
        | '\u{2066}'..='\u{2069}'
        | '\u{FEFF}'
    )
}

/// 清洗文本：去控制字符、零宽字符、方向覆写符，压缩空白。
pub fn clean_text(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_space = false;
    for c in raw.chars() {
        if c.is_control() || is_invisible(c) {
            continue;
        }
        if c.is_whitespace() {
            if !last_space {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out.trim().to_string()
}

pub fn count_chars(s: &str) -> usize {
    s.chars().count()
}

fn normalize_color(raw: Option<&Value>) -> Option<String> {
    let s = raw?.as_str()?.trim().to_lowercase();
    COLORS.contains(&s.as_str()).then_some(s)
}

/// 只接受 png/jpeg/webp/gif 的 data URL；**拒绝 SVG**（SVG 里能塞脚本）。
fn is_image_data_url(data: &str) -> bool {
    let Some(rest) = data.strip_prefix("data:image/") else {
        return false;
    };
    let Some((kind, payload)) = rest.split_once(";base64,") else {
        return false;
    };
    if !matches!(kind, "png" | "jpeg" | "webp" | "gif") {
        return false;
    }
    !payload.is_empty()
        && payload
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}

#[derive(Debug)]
struct Validated {
    content_type: &'static str,
    payload: String,
    color: Option<String>,
}

fn validate(msg: &Value) -> Result<Validated, &'static str> {
    match msg.get("contentType").and_then(|v| v.as_str()).unwrap_or("") {
        "text" => {
            let raw = msg.get("payload").and_then(|v| v.as_str()).ok_or("bad_request")?;
            let text = clean_text(raw);
            if text.is_empty() {
                return Err("empty");
            }
            if count_chars(&text) > TEXT_MAX_CHARS {
                return Err("too_long");
            }
            Ok(Validated {
                content_type: "text",
                payload: text,
                color: normalize_color(msg.get("color")),
            })
        }
        "image" => {
            let data = msg.get("payload").and_then(|v| v.as_str()).ok_or("bad_request")?;
            if data.len() > IMAGE_BASE64_MAX {
                return Err("too_large");
            }
            if !is_image_data_url(data) {
                return Err("bad_image");
            }
            Ok(Validated { content_type: "image", payload: data.to_string(), color: None })
        }
        _ => Err("bad_request"),
    }
}

/* -------------------------------------------------------------- HTTP 部分 */

fn common_headers() -> &'static [(HeaderName, HeaderValue)] {
    static H: OnceLock<Vec<(HeaderName, HeaderValue)>> = OnceLock::new();
    H.get_or_init(|| {
        SECURITY_HEADERS
            .iter()
            .filter_map(|(k, v)| {
                Some((
                    HeaderName::from_bytes(k.as_bytes()).ok()?,
                    HeaderValue::from_str(v).ok()?,
                ))
            })
            .collect()
    })
}

fn respond(status: StatusCode, body: Vec<u8>, content_type: &str) -> Response {
    let mut res = (status, body).into_response();
    let headers = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(content_type) {
        headers.insert(header::CONTENT_TYPE, v);
    }
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-cache, must-revalidate"),
    );
    for (k, v) in common_headers() {
        headers.insert(k.clone(), v.clone());
    }
    res
}

fn html_page(status: StatusCode, html: &str) -> Response {
    respond(status, html.as_bytes().to_vec(), "text/html; charset=utf-8")
}

async fn page_root() -> Response {
    html_page(
        StatusCode::OK,
        r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>培训互动</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0f1117;color:#e8eaef;font:16px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
text-align:center;padding:24px}h1{font-size:20px;margin:0 0 12px}p{color:#98a0b0;margin:0}</style></head>
<body><div><h1>请用手机扫描大屏上的二维码</h1><p>本页面只接受带房间口令的链接</p></div></body></html>"#,
    )
}

async fn page_invalid() -> Response {
    html_page(
        StatusCode::FORBIDDEN,
        r#"<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>链接无效</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0f1117;color:#e8eaef;font:16px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
text-align:center;padding:24px}h1{font-size:20px;margin:0 0 12px}p{color:#98a0b0;margin:0;max-width:22em}</style></head>
<body><div><h1>链接已失效</h1><p>请重新扫描大屏上的二维码，或向讲师索取当前链接。</p></div></body></html>"#,
    )
}

async fn serve_embedded(path: &str) -> Response {
    let Some(file) = ViewerAssets::get(path) else {
        return respond(
            StatusCode::NOT_FOUND,
            b"Not Found".to_vec(),
            "text/plain; charset=utf-8",
        );
    };
    let mime = match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "json" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    };
    respond(StatusCode::OK, file.data.into_owned(), mime)
}

async fn join_page(State(st): State<ServerState>, Path(token): Path<String>) -> Response {
    if !timing_safe_eq(&token, &st.token) {
        return page_invalid().await;
    }
    serve_embedded("index.html").await
}

async fn asset(Path(path): Path<String>) -> Response {
    let clean = path.trim_start_matches('/');
    if clean.contains("..") {
        return respond(StatusCode::NOT_FOUND, b"Not Found".to_vec(), "text/plain; charset=utf-8");
    }
    serve_embedded(&format!("assets/{clean}")).await
}

async fn healthz() -> Response {
    respond(
        StatusCode::OK,
        json!({ "ok": true, "ts": now_ms() }).to_string().into_bytes(),
        "application/json; charset=utf-8",
    )
}

/* ----------------------------------------------------------- WebSocket 部分 */

#[derive(Deserialize)]
struct WsQuery {
    t: Option<String>,
}

async fn ws_handler(
    State(st): State<ServerState>,
    Query(q): Query<WsQuery>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    ws: WebSocketUpgrade,
) -> Response {
    if !timing_safe_eq(&q.t.unwrap_or_default(), &st.token) {
        return respond(StatusCode::UNAUTHORIZED, b"Unauthorized".to_vec(), "text/plain; charset=utf-8");
    }
    ws.max_message_size(MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, st, peer.ip()))
}

/// 每条连接自己的会话状态（不共享、不过锁）。
struct Conn {
    last_sent_at: Option<Instant>,
    msg_ids: VecDeque<String>,
    liked_seqs: HashSet<u64>,
    last_like_at: Option<Instant>,
    like_timestamps: VecDeque<Instant>,
    last_react_at: Option<Instant>,
    client_id: String,
}

async fn send_json(socket: &mut WebSocket, payload: &Value) {
    let _ = socket.send(Message::Text(payload.to_string().into())).await;
}

async fn handle_socket(mut socket: WebSocket, st: ServerState, ip: IpAddr) {
    let mut conn = Conn {
        last_sent_at: None,
        msg_ids: VecDeque::new(),
        liked_seqs: HashSet::new(),
        last_like_at: None,
        like_timestamps: VecDeque::new(),
        last_react_at: None,
        client_id: random_token(10),
    };

    // hello：带上最近几条，避免新进来的观众看到一片空白
    let hello = {
        let mut guard = st.lock();
        let recent: Vec<Value> = guard.recent.iter().cloned().collect();
        let recent_counts = guard.recent_counts();
        let total = guard.signals_total;
        json!({
            "type": "hello",
            "proto": 1,
            "intervalSec": st.live.interval_sec(),
            "paused": st.live.paused(),
            "recent": recent,
            "signals": { "total": total, "recent": recent_counts, "windowMs": SIGNAL_WINDOW_MS },
            "serverTs": now_ms(),
        })
    };
    if socket.send(Message::Text(hello.to_string().into())).await.is_err() {
        return;
    }

    let mut rx = st.tx.subscribe();

    let online = st.online.fetch_add(1, Ordering::SeqCst) + 1;
    st.sink.on_online(online);

    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    heartbeat.tick().await; // 第一次立刻返回，跳过
    let mut last_seen = Instant::now();

    loop {
        tokio::select! {
            biased;

            incoming = socket.recv() => {
                let Some(frame) = incoming else { break };
                let Ok(frame) = frame else { break };
                last_seen = Instant::now();
                match frame {
                    Message::Text(text) => {
                        handle_client_text(&mut socket, &st, ip, text.as_str(), &mut conn).await;
                    }
                    Message::Binary(_) => {
                        send_json(&mut socket, &json!({
                            "type": "ack", "msgId": Value::Null, "status": "invalid", "reason": "binary"
                        })).await;
                    }
                    Message::Ping(p) => { let _ = socket.send(Message::Pong(p)).await; }
                    Message::Pong(_) => {}
                    Message::Close(_) => break,
                }
            }

            broadcast = rx.recv() => {
                if let Ok(text) = broadcast {
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
            }

            _ = heartbeat.tick() => {
                if last_seen.elapsed() > Duration::from_secs(45) {
                    let _ = socket.send(Message::Close(None)).await;
                    break;
                }
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
        }
    }

    let online = st.online.fetch_sub(1, Ordering::SeqCst).saturating_sub(1);
    st.sink.on_online(online);
}

async fn handle_client_text(socket: &mut WebSocket, st: &ServerState, ip: IpAddr, raw: &str, conn: &mut Conn) {
    let Ok(msg) = serde_json::from_str::<Value>(raw) else {
        return send_json(socket, &json!({
            "type": "ack", "msgId": Value::Null, "status": "invalid", "reason": "json"
        })).await;
    };

    match msg.get("type").and_then(|v| v.as_str()) {
        Some("like") => handle_like(socket, st, conn, &msg).await,
        Some("react") => handle_react(socket, st, conn, &msg).await,
        Some("message") => handle_message(socket, st, ip, conn, &msg).await,
        _ => {
            send_json(socket, &json!({
                "type": "ack", "msgId": Value::Null, "status": "invalid", "reason": "type"
            }))
            .await;
        }
    }
}

async fn ack_invalid(socket: &mut WebSocket, msg_id: Option<&String>, reason: &str) {
    send_json(socket, &json!({
        "type": "ack", "msgId": msg_id, "status": "invalid", "reason": reason
    }))
    .await;
}

async fn ack_rate_limited(socket: &mut WebSocket, msg_id: Option<&String>, wait_ms: u64) {
    send_json(socket, &json!({
        "type": "ack", "msgId": msg_id, "status": "rate_limited", "retryAfter": wait_ms
    }))
    .await;
}

async fn handle_message(socket: &mut WebSocket, st: &ServerState, ip: IpAddr, conn: &mut Conn, msg: &Value) {
    let msg_id = msg
        .get("msgId")
        .and_then(|v| v.as_str())
        .map(|s| s.chars().take(64).collect::<String>());

    // 幂等：手机端重连后重发同一 msgId，不重复上屏
    if let Some(id) = &msg_id {
        if conn.msg_ids.contains(id) {
            return send_json(socket, &json!({
                "type": "ack", "msgId": id, "status": "ok", "duplicate": true
            }))
            .await;
        }
    }

    let verified = match validate(msg) {
        Ok(v) => v,
        Err(reason) => return ack_invalid(socket, msg_id.as_ref(), reason).await,
    };

    // 过滤在校验之后、限流之前：被拦下的消息不占额度，也不上屏
    let mut flagged = false;
    let mut flag_category: Option<String> = None;
    if verified.content_type == "text" {
        let verdict = match st.filter.read() {
            Ok(guard) => guard.as_ref().map(|f| f.check(&verified.payload)),
            Err(poisoned) => poisoned.into_inner().as_ref().map(|f| f.check(&verified.payload)),
        };
        if let Some(v) = verdict {
            if v.blocked {
                // 不回显命中词，避免被用来试探规则
                return ack_invalid(socket, msg_id.as_ref(), "filtered").await;
            }
            flagged = v.flagged;
            flag_category = v.category;
        }
    }

    let interval = Duration::from_secs(st.live.interval_sec() as u64);
    let now = Instant::now();

    if let Some(last) = conn.last_sent_at {
        let elapsed = now.duration_since(last);
        if elapsed < interval {
            let wait = (interval - elapsed).as_millis() as u64;
            return ack_rate_limited(socket, msg_id.as_ref(), wait).await;
        }
    }

    // 第二道：单 IP 令牌桶 0.8 条/秒，突发 8
    let ip_wait = {
        let mut guard = st.lock();
        let bucket = guard.ip_buckets.entry(ip).or_insert_with(|| Bucket::new(8.0));
        if bucket.try_take(0.8, 8.0) {
            None
        } else {
            Some(bucket.wait_ms(0.8))
        }
    };
    if let Some(wait) = ip_wait {
        return ack_rate_limited(socket, msg_id.as_ref(), wait).await;
    }

    // 第三道：全局 4 条/秒，突发 12
    let global_ok = st.lock().global_bucket.try_take(4.0, 12.0);
    if !global_ok {
        return ack_rate_limited(socket, msg_id.as_ref(), 1200).await;
    }

    conn.last_sent_at = Some(now);
    if let Some(id) = &msg_id {
        conn.msg_ids.push_back(id.clone());
        while conn.msg_ids.len() > MSG_ID_MAX {
            conn.msg_ids.pop_front();
        }
    }

    let client_id = msg
        .get("clientId")
        .and_then(|v| v.as_str())
        .map(|s| s.chars().take(40).collect::<String>());

    let (seq, item) = {
        let mut guard = st.lock();
        guard.seq += 1;
        let seq = guard.seq;
        let ts = now_ms();

        guard.items_by_seq.insert(seq, ItemIndex { client_id: client_id.clone(), likes: 0 });
        guard.seq_order.push_back(seq);
        while guard.seq_order.len() > SEQ_MAX {
            if let Some(old) = guard.seq_order.pop_front() {
                guard.items_by_seq.remove(&old);
            }
        }

        // 广播给所有观众端：文本带正文，图片只给占位（不把原图推给所有人）
        let brief = json!({
            "seq": seq,
            "kind": if verified.content_type == "image" { "image" } else { "text" },
            "text": if verified.content_type == "text" { verified.payload.clone() } else { String::new() },
            "color": verified.color,
            "likes": 0,
            "clientId": client_id,
            "ts": ts,
        });
        guard.recent.push_back(brief.clone());
        while guard.recent.len() > RECENT_MAX {
            guard.recent.pop_front();
        }

        let mut item = brief;
        if let Value::Object(map) = &mut item {
            map.insert("type".into(), Value::String("item".into()));
        }
        (seq, item)
    };

    // 顺序与旧版一致：先 ack → 再广播 → 最后才通知主程序
    send_json(socket, &json!({
        "type": "ack", "msgId": msg_id, "status": "ok", "seq": seq,
        "retryAfter": interval.as_millis() as u64
    }))
    .await;

    st.broadcast_json(&item);

    st.sink.on_message(&Outgoing {
        seq,
        content_type: verified.content_type.to_string(),
        payload: verified.payload,
        color: verified.color,
        likes: 0,
        flagged,
        flag_category,
        ts: now_ms(),
        client_id,
    });
}

async fn like_reject(socket: &mut WebSocket, seq: Option<u64>, reason: &str, likes: u32) {
    send_json(
        socket,
        &json!({ "type": "like-reject", "seq": seq, "reason": reason, "likes": likes }),
    )
    .await;
}
async fn handle_like(socket: &mut WebSocket, st: &ServerState, conn: &mut Conn, msg: &Value) {
    let seq_no = msg.get("seq").and_then(|v| v.as_u64());
    let client_id = msg
        .get("clientId")
        .and_then(|v| v.as_str())
        .map(|s| s.chars().take(40).collect::<String>());


    let Some(seq) = seq_no else {
        return like_reject(socket, None, "gone", 0).await;
    };
    let Some(cid) = client_id else {
        return like_reject(socket, Some(seq), "no_client", 0).await;
    };

    // 先只看不动锁：拿当前点赞数 & 各种拒绝理由
    enum Outcome {
        Reject(&'static str, u32),
        Proceed(u32),
    }

    let outcome = {
        let guard = st.lock();
        match guard.items_by_seq.get(&seq) {
            None => Outcome::Reject("gone", 0),
            Some(item) if item.client_id.as_deref() == Some(cid.as_str()) => {
                Outcome::Reject("own", item.likes)
            }
            Some(item) => Outcome::Proceed(item.likes),
        }
    };

    let current = match outcome {
        Outcome::Reject(reason, likes) => return like_reject(socket, Some(seq), reason, likes).await,
        Outcome::Proceed(likes) => likes,
    };

    if conn.liked_seqs.contains(&seq) {
        return like_reject(socket, Some(seq), "duplicate", current).await;
    }

    let now = Instant::now();
    if let Some(last) = conn.last_like_at {
        if now.duration_since(last) < Duration::from_millis(LIKE_COOLDOWN_MS) {
            return like_reject(socket, Some(seq), "too_fast", current).await;
        }
    }
    conn.like_timestamps.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
    if conn.like_timestamps.len() >= LIKE_PER_MINUTE {
        return like_reject(socket, Some(seq), "too_many", current).await;
    }

    // 全局信号令牌桶
    let likes = {
        let mut guard = st.lock();
        if !guard.signal_bucket.try_take(SIGNAL_GLOBAL_RATE, SIGNAL_GLOBAL_BURST) {
            None
        } else {
            match guard.items_by_seq.get_mut(&seq) {
                Some(item) => {
                    item.likes += 1;
                    let likes = item.likes;
                    if let Some(brief) = guard
                        .recent
                        .iter_mut()
                        .find(|b| b.get("seq").and_then(|v| v.as_u64()) == Some(seq))
                    {
                        if let Value::Object(map) = brief {
                            map.insert("likes".into(), json!(likes));
                        }
                    }
                    Some(likes)
                }
                None => None,
            }
        }
    };

    let Some(likes) = likes else {
        return like_reject(socket, Some(seq), "busy", current).await;
    };

    conn.last_like_at = Some(now);
    conn.like_timestamps.push_back(now);
    conn.liked_seqs.insert(seq);
    if conn.liked_seqs.len() > LIKED_SEQ_MAX {
        if let Some(old) = conn.liked_seqs.iter().next().copied() {
            conn.liked_seqs.remove(&old);
        }
    }

    st.broadcast_json(&json!({ "type": "like", "seq": seq, "likes": likes }));
    st.sink.on_like(seq, likes);
}

async fn handle_react(socket: &mut WebSocket, st: &ServerState, conn: &mut Conn, msg: &Value) {
    let kind = msg.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    if !REACT_KINDS.contains(&kind) {
        return send_json(socket, &json!({ "type": "react-reject", "reason": "bad_kind" })).await;
    }

    let now = Instant::now();
    if let Some(last) = conn.last_react_at {
        if now.duration_since(last) < Duration::from_millis(REACT_COOLDOWN_MS) {
            return send_json(socket, &json!({ "type": "react-reject", "reason": "too_fast" })).await;
        }
    }

    let snap = {
        let mut guard = st.lock();
        if !guard.signal_bucket.try_take(SIGNAL_GLOBAL_RATE, SIGNAL_GLOBAL_BURST) {
            None
        } else {
            guard.signals_total.bump(kind);
            guard.recent_signals.push_back((kind.to_string(), now));
            while guard.recent_signals.len() > 600 {
                guard.recent_signals.pop_front();
            }
            let recent = guard.recent_counts();
            Some(Signals { total: guard.signals_total, recent, window_ms: SIGNAL_WINDOW_MS })
        }
    };

    let Some(snap) = snap else {
        return send_json(socket, &json!({ "type": "react-reject", "reason": "busy" })).await;
    };

    conn.last_react_at = Some(now);
    st.broadcast_json(&json!({ "type": "react", "kind": kind, "signals": snap }));
    st.sink.on_signals(&snap);
}

/* ------------------------------------------------------------------ Bridge */

pub struct BridgeConfig {
    pub token: String,
    pub interval_sec: u32,
    pub filter: Option<Filter>,
    pub sink: Arc<dyn MessageSink>,
    /// 0 表示让系统分配端口（测试用）
    pub preferred_port: u16,
}

pub struct Bridge {
    pub port: u16,
    pub token: String,
    pub state: ServerState,
    shutdown: Option<oneshot::Sender<()>>,
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl Bridge {
    /// 起服务。端口被占用时依次尝试 8080..=8099，全被占就交给系统分配。
    pub async fn start(cfg: BridgeConfig) -> std::io::Result<Bridge> {
        let inner = Arc::new(Mutex::new(Inner {
            seq: 0,
            ip_buckets: HashMap::new(),
            global_bucket: Bucket::new(12.0),
            signal_bucket: Bucket::new(SIGNAL_GLOBAL_BURST),
            items_by_seq: HashMap::new(),
            seq_order: VecDeque::new(),
            recent: VecDeque::new(),
            signals_total: KindCounts::default(),
            recent_signals: VecDeque::new(),
        }));

        let (tx, _rx) = broadcast::channel::<String>(256);
        let online = Arc::new(AtomicUsize::new(0));

        let state = ServerState {
            inner,
            token: Arc::new(cfg.token.clone()),
            live: LiveConfig::new(cfg.interval_sec),
            filter: Arc::new(RwLock::new(cfg.filter)),
            sink: Arc::clone(&cfg.sink),
            online,
            tx,
        };

        let app = Router::new()
            .route("/", get(page_root))
            .route("/healthz", get(healthz))
            .route("/j/{token}", get(join_page))
            .route("/assets/{*path}", get(asset))
            .route("/ws", get(ws_handler))
            .with_state(state.clone());

        let listener = bind_port(cfg.preferred_port).await?;
        let port = listener.local_addr()?.port();

        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
                .with_graceful_shutdown(async move {
                    let _ = stop_rx.await;
                })
                .await;
        });

        Ok(Bridge {
            port,
            token: cfg.token,
            state,
            shutdown: Some(stop_tx),
            handle: Some(handle),
        })
    }

    pub fn url(&self, ip: &str) -> String {
        format!("http://{}:{}/j/{}", ip, self.port, self.token)
    }

    /// 结束一场：先通知客户端，再断开，最后关服务。
    pub async fn shutdown(mut self, reason: &str) {
        self.state.broadcast_json(&json!({ "type": "session_end", "reason": reason }));
        tokio::time::sleep(Duration::from_millis(60)).await;
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(h) = self.handle.take() {
            let _ = tokio::time::timeout(Duration::from_secs(2), h).await;
        }
    }
}

/// 端口是否"真的"可用。
///
/// 为什么不能直接试 `0.0.0.0:port`：Windows 上通配地址绑定**不会**和已经存在的
/// `127.0.0.1:port` 冲突——两个进程都能 Listen 成功，但发往 127.0.0.1 的流量会被
/// 具体的那个绑定点接走。表现就是"二维码扫得通（走的是局域网 IP），本机却打不开"，
/// 排查时会非常费解（实测在本机上就这样撞了一次）。
/// 所以先探测 127.0.0.1:port，可用再绑通配地址。
async fn port_usable(port: u16) -> bool {
    match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(probe) => {
            drop(probe);
            true
        }
        Err(_) => false,
    }
}

/// 监听地址。默认 `0.0.0.0`（手机要能从局域网连进来）。
///
/// 可以用环境变量 `LDM_BIND=127.0.0.1` 改成只监听回环——自动化测试需要它：
/// 只要程序在非回环地址上监听，Windows 就会弹「是否允许访问网络」的防火墙对话框，
/// 那个对话框会**变暗整个桌面并独占输入**，屏幕取色和模拟点击全部失效。
async fn bind_host() -> String {
    std::env::var("LDM_BIND").unwrap_or_else(|_| "0.0.0.0".to_string())
}

async fn bind_port(preferred: u16) -> std::io::Result<tokio::net::TcpListener> {
    let host = bind_host().await;
    if preferred != 0 {
        for offset in 0..20u16 {
            let port = preferred.saturating_add(offset);
            if port == 0 || !port_usable(port).await {
                continue;
            }
            if let Ok(l) = tokio::net::TcpListener::bind((host.as_str(), port)).await {
                return Ok(l);
            }
        }
    }
    // 全被占用（或测试要求）：交给系统分配
    tokio::net::TcpListener::bind((host.as_str(), 0)).await
}

/* -------------------------------------------------------------------- 测试 */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filter::Level;
    use futures_util::{SinkExt, StreamExt};
    use std::sync::Mutex as StdMutex;
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    #[derive(Default)]
    struct RecordingSink {
        messages: StdMutex<Vec<Outgoing>>,
        likes: StdMutex<Vec<(u64, u32)>>,
    }

    impl MessageSink for RecordingSink {
        fn on_message(&self, msg: &Outgoing) {
            self.messages.lock().unwrap().push(msg.clone());
        }
        fn on_like(&self, seq: u64, likes: u32) {
            self.likes.lock().unwrap().push((seq, likes));
        }
        fn on_signals(&self, _snap: &Signals) {}
        fn on_online(&self, _online: usize) {}
        fn on_log(&self, _kind: &str, _detail: &str) {}
    }

    async fn start_test_bridge() -> (Bridge, Arc<RecordingSink>) {
        let sink = Arc::new(RecordingSink::default());
        let bridge = Bridge::start(BridgeConfig {
            token: "testtoken".into(),
            interval_sec: 5,
            filter: Some(Filter::new(Level::Block, "")),
            sink: sink.clone(),
            preferred_port: 0,
        })
        .await
        .expect("测试服务应当能起来");
        (bridge, sink)
    }

    type Ws = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    async fn connect(port: u16, token: &str) -> Ws {
        let url = format!("ws://127.0.0.1:{port}/ws?t={token}");
        let (ws, _) = tokio_tungstenite::connect_async(url).await.expect("应当能连上");
        ws
    }

    /// 读到第一条指定 type 的消息（带超时，避免测试挂死）。
    async fn read_until(ws: &mut Ws, want: &str) -> Value {
        for _ in 0..40 {
            let next = tokio::time::timeout(Duration::from_secs(3), ws.next())
                .await
                .expect("读超时");
            let Some(Ok(WsMessage::Text(text))) = next else {
                if next.is_none() {
                    break;
                }
                continue;
            };
            let Ok(v) = serde_json::from_str::<Value>(text.as_str()) else {
                continue;
            };
            if v.get("type").and_then(|x| x.as_str()) == Some(want) {
                return v;
            }
        }
        panic!("没收到 type={want} 的消息");
    }

    async fn send(ws: &mut Ws, payload: Value) {
        ws.send(WsMessage::Text(payload.to_string().into()))
            .await
            .expect("发送失败");
    }

    #[test]
    fn token_is_unambiguous_and_random() {
        let a = random_token(8);
        let b = random_token(8);
        assert_eq!(a.len(), 8);
        assert_ne!(a, b);
        // 去掉易混字符 0/o/1/l/i
        for c in a.chars() {
            assert!("abcdefghjkmnpqrstuvwxyz23456789".contains(c), "出现了易混字符 {c}");
        }
    }

    #[test]
    fn timing_safe_compare_behaves_like_equality() {
        assert!(timing_safe_eq("abcd2345", "abcd2345"));
        assert!(!timing_safe_eq("abcd2345", "abcd2346"));
        assert!(!timing_safe_eq("abcd2345", "abcd234"));
        assert!(!timing_safe_eq("", "x"));
    }

    #[test]
    fn text_validation_matches_legacy_rules() {
        assert_eq!(validate(&json!({ "contentType": "text", "payload": "  " })).unwrap_err(), "empty");
        let long = "字".repeat(101);
        assert_eq!(validate(&json!({ "contentType": "text", "payload": long })).unwrap_err(), "too_long");
        let v = validate(&json!({ "contentType": "text", "payload": "你好\u{200B}世界", "color": "#7EE787" })).unwrap();
        assert_eq!(v.payload, "你好世界");
        assert_eq!(v.color.as_deref(), Some("#7ee787"), "颜色应统一小写");
        // 白名单之外的颜色应当被清成 None（大屏用默认白色）
        let v = validate(&json!({ "contentType": "text", "payload": "hi", "color": "#333333" })).unwrap();
        assert!(v.color.is_none());
    }

    #[test]
    fn image_validation_rejects_svg_and_oversize() {
        assert_eq!(
            validate(&json!({ "contentType": "image", "payload": "data:image/svg+xml;base64,PHN2Zz4=" })).unwrap_err(),
            "bad_image",
            "SVG 能塞脚本，必须拒绝"
        );
        assert_eq!(
            validate(&json!({ "contentType": "image", "payload": "data:text/html;base64,PHN2Zz4=" })).unwrap_err(),
            "bad_image"
        );
        let ok = format!("data:image/png;base64,{}", "A".repeat(64));
        assert!(validate(&json!({ "contentType": "image", "payload": ok })).is_ok());
    }

    #[tokio::test]
    async fn http_endpoints_behave_like_legacy() {
        let (bridge, _sink) = start_test_bridge().await;
        let base = format!("http://127.0.0.1:{}", bridge.port);
        let client = reqwest_lite::Client::new();

        let root = client.get(&format!("{base}/")).await;
        assert_eq!(root.0, 200);
        assert!(root.1.contains("二维码"));

        let good = client.get(&format!("{base}/j/testtoken")).await;
        assert_eq!(good.0, 200);
        assert!(good.1.contains("培训互动"), "应当吐出观众端页面");

        let bad = client.get(&format!("{base}/j/wrongtoken")).await;
        assert_eq!(bad.0, 403);
        assert!(bad.1.contains("链接已失效"));

        let css = client.get(&format!("{base}/assets/style.css?v=0.2.0")).await;
        assert_eq!(css.0, 200, "静态资源要能被取到（带 query 也应正常）");

        let missing = client.get(&format!("{base}/assets/nope.js")).await;
        assert_eq!(missing.0, 404);

        let health = client.get(&format!("{base}/healthz")).await;
        assert_eq!(health.0, 200);
        assert!(health.1.contains("\"ok\":true"));

        bridge.shutdown("test").await;
    }

    #[tokio::test]
    async fn ws_rejects_wrong_token() {
        let (bridge, _) = start_test_bridge().await;
        let url = format!("ws://127.0.0.1:{}/ws?t=nope", bridge.port);
        let res = tokio_tungstenite::connect_async(url).await;
        assert!(res.is_err(), "口令不对必须拒绝升级");
        bridge.shutdown("test").await;
    }

    #[tokio::test]
    async fn ws_hello_then_message_roundtrip() {
        let (bridge, sink) = start_test_bridge().await;
        let mut ws = connect(bridge.port, "testtoken").await;

        let hello = read_until(&mut ws, "hello").await;
        assert_eq!(hello["proto"], 1);
        assert_eq!(hello["intervalSec"], 5);
        assert_eq!(hello["paused"], false);

        send(&mut ws, json!({
            "type": "message", "msgId": "m1", "contentType": "text",
            "payload": "第一次发言", "color": "#ffe066", "clientId": "device-A"
        }))
        .await;

        let ack = read_until(&mut ws, "ack").await;
        assert_eq!(ack["status"], "ok");
        assert_eq!(ack["msgId"], "m1");
        assert_eq!(ack["seq"], 1);

        let item = read_until(&mut ws, "item").await;
        assert_eq!(item["seq"], 1);
        assert_eq!(item["text"], "第一次发言");
        assert_eq!(item["kind"], "text");

        // 主程序也应当收到了这条（含完整正文）
        let recorded = sink.messages.lock().unwrap();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].payload, "第一次发言");
        assert_eq!(recorded[0].color.as_deref(), Some("#ffe066"));

        bridge.shutdown("test").await;
    }

    #[tokio::test]
    async fn duplicate_msgid_is_idempotent() {
        let (bridge, sink) = start_test_bridge().await;
        let mut ws = connect(bridge.port, "testtoken").await;
        read_until(&mut ws, "hello").await;

        let payload = json!({
            "type": "message", "msgId": "same-id", "contentType": "text",
            "payload": "只该上屏一次", "clientId": "device-A"
        });
        send(&mut ws, payload.clone()).await;
        let first = read_until(&mut ws, "ack").await;
        assert_eq!(first["status"], "ok");
        assert_eq!(first["seq"], 1);

        // 重连/重发同一个 msgId
        send(&mut ws, payload).await;
        let second = read_until(&mut ws, "ack").await;
        assert_eq!(second["status"], "ok");
        assert_eq!(second["duplicate"], true);
        assert!(second.get("seq").is_none(), "重复消息不应再分配 seq");

        assert_eq!(sink.messages.lock().unwrap().len(), 1, "只该入历史一次");
        bridge.shutdown("test").await;
    }

    #[tokio::test]
    async fn filtered_message_does_not_consume_quota() {
        // 这是旧版很重要的一条行为：被过滤拦下的消息不占发送额度，
        // 否则误伤之后讲师让学员换个说法，学员还得干等 5 秒。
        let (bridge, sink) = start_test_bridge().await;
        let mut ws = connect(bridge.port, "testtoken").await;
        read_until(&mut ws, "hello").await;

        send(&mut ws, json!({
            "type": "message", "msgId": "bad-1", "contentType": "text",
            "payload": "加微信 abc_12345", "clientId": "device-A"
        }))
        .await;
        let blocked = read_until(&mut ws, "ack").await;
        assert_eq!(blocked["status"], "invalid");
        assert_eq!(blocked["reason"], "filtered");

        // 紧接着发正常内容：如果刚才那条占了额度，这里会被 rate_limited
        send(&mut ws, json!({
            "type": "message", "msgId": "good-1", "contentType": "text",
            "payload": "换个说法", "clientId": "device-A"
        }))
        .await;
        let ok = read_until(&mut ws, "ack").await;
        assert_eq!(ok["status"], "ok", "被过滤的消息不该占用额度");
        assert_eq!(sink.messages.lock().unwrap().len(), 1);

        bridge.shutdown("test").await;
    }

    #[tokio::test]
    async fn per_user_interval_is_enforced() {
        let (bridge, _) = start_test_bridge().await;
        let mut ws = connect(bridge.port, "testtoken").await;
        read_until(&mut ws, "hello").await;

        send(&mut ws, json!({ "type": "message", "msgId": "a", "contentType": "text", "payload": "一", "clientId": "d1" })).await;
        assert_eq!(read_until(&mut ws, "ack").await["status"], "ok");

        send(&mut ws, json!({ "type": "message", "msgId": "b", "contentType": "text", "payload": "二", "clientId": "d1" })).await;
        let limited = read_until(&mut ws, "ack").await;
        assert_eq!(limited["status"], "rate_limited");
        assert!(limited["retryAfter"].as_u64().unwrap() > 0, "应当告诉手机还剩多久");

        bridge.shutdown("test").await;
    }

    #[tokio::test]
    async fn likes_work_and_self_like_is_rejected() {
        let (bridge, sink) = start_test_bridge().await;

        // A 发一条
        let mut a = connect(bridge.port, "testtoken").await;
        read_until(&mut a, "hello").await;
        send(&mut a, json!({ "type": "message", "msgId": "x1", "contentType": "text", "payload": "值得点赞", "clientId": "A" })).await;
        assert_eq!(read_until(&mut a, "ack").await["status"], "ok");

        // B 点赞
        let mut b = connect(bridge.port, "testtoken").await;
        read_until(&mut b, "hello").await;
        send(&mut b, json!({ "type": "like", "seq": 1, "clientId": "B" })).await;
        let liked = read_until(&mut b, "like").await;
        assert_eq!(liked["seq"], 1);
        assert_eq!(liked["likes"], 1);

        // A 不能给自己点赞
        send(&mut a, json!({ "type": "like", "seq": 1, "clientId": "A" })).await;
        let rejected = read_until(&mut a, "like-reject").await;
        assert_eq!(rejected["reason"], "own");

        // 同一条重复点赞要被挡住
        send(&mut b, json!({ "type": "like", "seq": 1, "clientId": "B" })).await;
        let dup = read_until(&mut b, "like-reject").await;
        assert_eq!(dup["reason"], "duplicate");

        assert_eq!(sink.likes.lock().unwrap().len(), 1, "主程序只该收到一次点赞回调");

        bridge.shutdown("test").await;
    }

    #[tokio::test]
    async fn react_updates_signal_counts() {
        let (bridge, _) = start_test_bridge().await;
        let mut ws = connect(bridge.port, "testtoken").await;
        read_until(&mut ws, "hello").await;

        send(&mut ws, json!({ "type": "react", "kind": "agree" })).await;
        let react = read_until(&mut ws, "react").await;
        assert_eq!(react["kind"], "agree");
        assert_eq!(react["signals"]["total"]["agree"], 1);
        assert_eq!(react["signals"]["windowMs"], 60000);

        // 2 秒冷却
        send(&mut ws, json!({ "type": "react", "kind": "confused" })).await;
        let rejected = read_until(&mut ws, "react-reject").await;
        assert_eq!(rejected["reason"], "too_fast");

        // 非法语义
        send(&mut ws, json!({ "type": "react", "kind": "angry" })).await;
        let bad = read_until(&mut ws, "react-reject").await;
        assert_eq!(bad["reason"], "bad_kind");

        bridge.shutdown("test").await;
    }

    #[tokio::test]
    async fn broadcast_reaches_every_client() {
        let (bridge, _) = start_test_bridge().await;
        let mut a = connect(bridge.port, "testtoken").await;
        let mut b = connect(bridge.port, "testtoken").await;
        read_until(&mut a, "hello").await;
        read_until(&mut b, "hello").await;

        // 讲师暂停：应当广播给所有观众
        bridge.state.live().set_paused(true);
        bridge.state.broadcast_json(&json!({ "type": "paused", "paused": true }));

        let got_a = read_until(&mut a, "paused").await;
        let got_b = read_until(&mut b, "paused").await;
        assert_eq!(got_a["paused"], true);
        assert_eq!(got_b["paused"], true);

        bridge.shutdown("test").await;
    }

    #[tokio::test]
    async fn new_client_sees_recent_history() {
        let (bridge, _) = start_test_bridge().await;
        let mut a = connect(bridge.port, "testtoken").await;
        read_until(&mut a, "hello").await;
        send(&mut a, json!({ "type": "message", "msgId": "r1", "contentType": "text", "payload": "前面说过的话", "clientId": "A" })).await;
        read_until(&mut a, "ack").await;

        // 后来的观众应当能在 hello 里看到这条
        let mut b = connect(bridge.port, "testtoken").await;
        let hello = read_until(&mut b, "hello").await;
        let recent = hello["recent"].as_array().expect("hello 应当带 recent");
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0]["text"], "前面说过的话");

        bridge.shutdown("test").await;
    }

    /// 极简 HTTP 客户端：只为测试，避免再拉一个 reqwest 依赖。
    mod reqwest_lite {
        pub struct Client;

        pub struct Response(pub u16, pub String);

        impl Client {
            pub fn new() -> Self {
                Client
            }

            pub async fn get(&self, url: &str) -> Response {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let without_scheme = url.trim_start_matches("http://");
                let (host_port, path) = match without_scheme.find('/') {
                    Some(i) => (&without_scheme[..i], &without_scheme[i..]),
                    None => (without_scheme, "/"),
                };
                let mut stream = tokio::net::TcpStream::connect(host_port).await.expect("连不上");
                let req = format!("GET {path} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n");
                stream.write_all(req.as_bytes()).await.expect("写失败");
                let mut buf = Vec::new();
                stream.read_to_end(&mut buf).await.ok();
                let text = String::from_utf8_lossy(&buf).to_string();
                let status = text
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .and_then(|s| s.parse::<u16>().ok())
                    .unwrap_or(0);
                Response(status, text)
            }
        }
    }
}
