//! 远程模式（测试版）：用 Cloudflare Quick Tunnel 把本机的会话服务暴露到公网，
//! 让学员在场地 WiFi 不可用时，用手机流量也能进入。
//!
//! 设计取舍（这是"测试版"，刻意保持最小）：
//! - 不内置 cloudflared（40MB，会毁掉整个应用 5MB 的体积优势），首次使用时下载到
//!   `%LOCALAPPDATA%\localdanmu\cloudflared.exe` 并缓存
//! - 先试 Quick Tunnel（随机域名、免账号），也支持 Named Tunnel（固定域名 + 令牌）
//! - **端到端加密**：房间密钥放在 URL 的 `#k=` 片段里，永远不会发到 Cloudflare（见 crypto.rs）
//!
//! 进程生命周期：start 起子进程并读 stderr 找公网地址；stop / 应用退出时 kill。

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::qr;

/// 官方资源地址（GitHub release 的 latest 永久链接）
const ASSET_URL: &str =
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

/// 体积下限。实际约 53MB，低于 10MB 一定不是完整文件。
const MIN_EXE_BYTES: u64 = 10 * 1024 * 1024;

/// 预期体积，仅用于进度文案（真实值随版本变化，只求量级对）
const EXPECTED_BYTES: u64 = 53 * 1024 * 1024;

/// 事件名：控制面板订阅它来更新按钮和二维码
pub const EVENT: &str = "tunnel:state";

#[derive(Default)]
struct Inner {
    status: String,
    url: String,
    message: String,
    qr: String,
    child: Option<Child>,
    /// 持有 Job Object 句柄：进程退出（含被强杀）时系统会连带杀掉 cloudflared
    #[cfg(windows)]
    job: Option<JobGuard>,
}

/// 启动一次隧道所需的全部参数（自动续连时原样复用）
#[derive(Clone, Default)]
pub struct StartArgs {
    /// 本机会话服务端口
    pub port: u16,
    /// 房间口令
    pub room: String,
    /// 固定隧道令牌（空 = 用临时隧道）
    pub tunnel_token: String,
    /// 固定域名（例如 dm.example.com）
    pub host: String,
    /// 用户手动指定的 cloudflared.exe 路径（空 = 自动下载/用缓存）
    pub cloudflared_path: Option<String>,
}

pub struct Tunnel {
    inner: Mutex<Inner>,
    busy: AtomicBool,
    /// 端到端密钥槽：开启时写入，关闭时清空（与 server 共享）
    key: crate::crypto::RemoteKey,
    /// 自动续连：隧道掉了自动重开
    auto: AtomicBool,
    /// 是否正在等待重连（防止重复排队）
    retrying: AtomicBool,
    /// 讲师主动关闭时为 true，重连逻辑据此判断"不是意外掉线"
    stopped: AtomicBool,
    /// 最近一次成功启动的参数，重连时复用
    last: Mutex<Option<StartArgs>>,
    /// 创建时就拿到的窗口句柄：让隧道生命周期与 core 状态机解耦于命令层
    app: AppHandle,
}

impl Tunnel {
    pub fn new(key: crate::crypto::RemoteKey, app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                status: "idle".into(),
                ..Default::default()
            }),
            busy: AtomicBool::new(false),
            key,
            auto: AtomicBool::new(false),
            retrying: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            last: Mutex::new(None),
            app,
        })
    }

    pub fn auto(&self) -> bool {
        self.auto.load(Ordering::SeqCst)
    }

    pub fn set_auto(&self, on: bool) {
        self.auto.store(on, Ordering::SeqCst);
    }

    /// 意外掉线后排队重连：延迟后复用上一次的端口与口令重新开隧道。
    fn schedule_restart(self: &Arc<Self>) {
        if !self.auto.load(Ordering::SeqCst) || self.stopped.load(Ordering::SeqCst) {
            return;
        }
        if self.retrying.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            me.retrying.store(false, Ordering::SeqCst);
            if !me.auto.load(Ordering::SeqCst) || me.stopped.load(Ordering::SeqCst) {
                return;
            }
            let target = me.last.lock().ok().and_then(|g| g.clone());
            if let Some(args) = target {
                let app = me.app.clone();
                me.set(&app, "starting", None, "隧道断开，正在自动重连…");
                me.start(args);
            }
        });
    }
    pub fn snapshot(&self) -> Value {
        let g = self.inner.lock().unwrap();
        json!({
            "status": g.status,
            "url": g.url,
            "qr": g.qr,
            "message": g.message,
            "auto": self.auto.load(Ordering::SeqCst),
            "fixed": self
                .last
                .lock()
                .ok()
                .and_then(|l| l.as_ref().map(|a| !a.tunnel_token.is_empty()))
                .unwrap_or(false),
        })
    }

    fn set(&self, app: &AppHandle, status: &str, url: Option<String>, message: &str) {
        {
            let mut g = self.inner.lock().unwrap();
            g.status = status.to_string();
            g.message = message.to_string();
            if let Some(u) = url {
                g.url = u.clone();
                g.qr = qr::data_url(&u).unwrap_or_default();
            }
            if status != "running" {
                g.url.clear();
                g.qr.clear();
            }
        }
        if crate::core::probe_enabled() {
            crate::core::probe_log(&format!("tunnel[{status}] {message}"));
        }
        let _ = app.emit(EVENT, self.snapshot());
    }

    /// 启动隧道。`port` 是本机会话服务端口，`token` 是房间口令。
    pub fn start(self: &Arc<Self>, args: StartArgs) {
        if self.busy.swap(true, Ordering::SeqCst) {
            return; // 已经在启动/运行
        }
        self.stopped.store(false, Ordering::SeqCst);
        if let Ok(mut g) = self.last.lock() {
            *g = Some(args.clone());
        }
        let me = Arc::clone(self);
        let app2 = self.app.clone();
        let fixed = !args.tunnel_token.is_empty();
        let app_self = self.app.clone();
        self.set(
            &app_self,
            "starting",
            None,
            if fixed { "正在连接固定隧道…" } else { "正在准备隧道…" },
        );

        std::thread::spawn(move || {
            let result = me.run(&app2, args);
            me.busy.store(false, Ordering::SeqCst);
            if let Err(err) = result {
                // 失败时把密钥清掉，避免留下一个没人知道的密钥
                crate::crypto::set_key(&me.key, None);
                me.set(&app2, "error", None, &err);
                me.schedule_restart();
            }
        });
    }

    fn run(self: &Arc<Self>, app: &AppHandle, args: StartArgs) -> Result<(), String> {
        let bin = ensure_binary(app, self, args.cloudflared_path.as_deref())?;
        let fixed = !args.tunnel_token.is_empty();

        if fixed && args.host.trim().is_empty() {
            return Err("固定隧道需要在设置里填写公开域名（例如 dm.example.com）".into());
        }
        self.set(
            app,
            "starting",
            None,
            if fixed { "正在连接固定隧道…" } else { "正在建立隧道…" },
        );

        // 每次开启生成一把新密钥；URL 里带 #k=，它不会发给 Cloudflare
        let key = crate::crypto::random_key();
        crate::crypto::set_key(&self.key, Some(key));
        let frag = crate::crypto::key_to_fragment(&key);

        let cmd_args: Vec<String> = if fixed {
            // 注意：--no-autoupdate / --loglevel 是 tunnel 级参数，必须写在 run 前面
            vec![
                "tunnel".into(),
                "--no-autoupdate".into(),
                "--loglevel".into(),
                "info".into(),
                "run".into(),
                "--token".into(),
                args.tunnel_token.clone(),
            ]
        } else {
            vec![
                "tunnel".into(),
                "--url".into(),
                format!("http://127.0.0.1:{}", args.port),
                "--no-autoupdate".into(),
                "--loglevel".into(),
                "info".into(),
            ]
        };

        #[allow(unused_mut)]
        let mut child = Command::new(&bin)
            .args(&cmd_args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW：不弹黑框
            .spawn()
            .map_err(|e| format!("启动 cloudflared 失败：{e}"))?;

        // 关键：先把子进程放进 Job Object，再开始读它的输出
        #[cfg(windows)]
        let job = attach_job(&child);

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // cloudflared 的用法错误可能打到 stdout，成功/失败日志在 stderr。
        // 两边都留最后一行，失败时拼进提示里，省得用户猜。
        let tail_buf: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let tail_out = Arc::clone(&tail_buf);

        // 起两个读线程，避免管道写满导致子进程卡住
        if let Some(out) = stdout {
            std::thread::spawn(move || {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        if let Ok(mut g) = tail_out.lock() {
                            g.push(line);
                            if g.len() > 8 {
                                g.remove(0);
                            }
                        }
                    }
                }
            });
        }

        let me2 = Arc::clone(self);
        let app2 = app.clone();
        let token = args.room.clone();
        let host = args.host.trim().trim_start_matches("https://").trim_end_matches('/').to_string();
        let frag = frag.clone();
        let url_re = regex::Regex::new(r"https://[a-z0-9-]+\.trycloudflare\.com").unwrap();

        let tail_in = Arc::clone(&tail_buf);
        let reader = std::thread::spawn(move || {
            let tail_buf = tail_in;
            let mut found = false;
            if let Some(err) = stderr {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    if !line.trim().is_empty() {
                        if let Ok(mut g) = tail_buf.lock() {
                            g.push(line.clone());
                            if g.len() > 8 {
                                g.remove(0);
                            }
                        }
                    }
                    if !found {
                        if fixed {
                            // 固定隧道：地址是我们自己的域名，连接器注册成功即可用
                            if line.contains("Registered tunnel connection") {
                                found = true;
                                let join = format!("https://{host}/j/{token}#k={frag}");
                                me2.set(&app2, "running", Some(join), "固定隧道已连接，地址不会变");
                            }
                        } else if let Some(m) = url_re.find(&line) {
                            found = true;
                            let base = m.as_str().to_string();
                            let join = format!("{base}/j/{token}#k={frag}");
                            me2.set(&app2, "running", Some(join), "隧道已就绪，手机用流量可访问");
                        }
                    }
                    // 明显的失败信号
                    if line.contains("failed to request quick Tunnel") || line.contains("ERR ") {
                        me2.set(&app2, "error", None, "隧道建立失败，检查网络后重试");
                    }
                }
            }
            if !found {
                // 进程没给成功信号就退出了：把最后一行日志带上，便于判断是令牌问题还是网络问题
                // 挑一条最有信息量的：优先带错误关键字的行，否则取最后一行
                let hint = tail_buf
                    .lock()
                    .ok()
                    .and_then(|g| {
                        let keys = ["not valid", "Unauthorized", "error", "failed", "invalid", "denied"];
                        g.iter()
                            .find(|l| keys.iter().any(|k| l.to_lowercase().contains(k)))
                            .or_else(|| g.last())
                            .cloned()
                    })
                    .unwrap_or_default();
                let hint: String = hint.trim().chars().take(160).collect();
                let msg = if hint.trim().is_empty() {
                    "隧道进程退出（没有输出日志）".to_string()
                } else {
                    format!("隧道连接失败：{}", hint.trim())
                };
                me2.set(&app2, "error", None, &msg);
            }
            found
        });

        {
            let mut g = self.inner.lock().unwrap();
            g.child = Some(child);
            #[cfg(windows)]
            {
                g.job = job;
            }
        }

        // 40 秒没拿到地址就判定失败
        let me3 = Arc::clone(self);
        let app3 = app.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(40);
            while Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(500));
                let status = {
                    let g = me3.inner.lock().unwrap();
                    g.status.clone()
                };
                if status == "running" || status == "idle" || status == "error" {
                    return;
                }
            }
            me3.set(&app3, "error", None, "隧道启动超时（40 秒），可能是网络无法访问 Cloudflare");
            me3.schedule_restart();
        });

        // 读线程结束 = 子进程退出
        let me4 = Arc::clone(self);
        let app4 = app.clone();
        std::thread::spawn(move || {
            let _ = reader.join();
            let mut g = me4.inner.lock().unwrap();
            g.child = None;
            let status = g.status.clone();
            drop(g);
            if status == "running" || status == "starting" {
                me4.set(&app4, "error", None, "隧道进程意外退出");
                me4.schedule_restart();
            }
        });

        Ok(())
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let mut g = self.inner.lock().unwrap();
        if let Some(mut child) = g.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        #[cfg(windows)]
        {
            g.job = None;
        }
        crate::crypto::set_key(&self.key, None);
        let was = g.status.clone();
        let mut g2 = g;
        g2.status = "idle".into();
        g2.url.clear();
        g2.qr.clear();
        g2.message = "已关闭远程模式".into();
        drop(g2);
        self.busy.store(false, Ordering::SeqCst);
        if was != "idle" {
            let _ = self.app.emit(EVENT, self.snapshot());
        }
    }

    /// 应用退出时确保子进程被清掉，不留孤儿
    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let mut g = self.inner.lock().unwrap();
        if let Some(mut child) = g.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        #[cfg(windows)]
        {
            g.job = None;
        }
        crate::crypto::set_key(&self.key, None);
    }
}

/* ------------------------------------------------------------ Job Object */

/// 把子进程放进一个「句柄关闭即杀进程」的 Job Object。
/// 这样即使应用被任务管理器强杀、或崩溃，cloudflared 也不会留在后台。
/// 保存为整数句柄：HANDLE 在 windows-sys 里是 `*mut c_void`，不实现 Send，
/// 而 Tunnel 会被多个线程共享；用 isize 存、用到时再转回去。
#[cfg(windows)]
struct JobGuard(isize);

#[cfg(windows)]
impl Drop for JobGuard {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0 as _) };
    }
}

#[cfg(windows)]
fn attach_job(child: &Child) -> Option<JobGuard> {
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            windows_sys::Win32::Foundation::CloseHandle(job);
            return None;
        }
        let process = child.as_raw_handle() as *mut core::ffi::c_void;
        if AssignProcessToJobObject(job, process) == 0 {
            // 已经在别的 job 里（Win8 之前不支持嵌套），退化为普通子进程
            windows_sys::Win32::Foundation::CloseHandle(job);
            return None;
        }
        Some(JobGuard(job as isize))
    }
}

fn bin_dir() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("localdanmu")
}

/// 下载源：**先走 GitHub 加速代理，最后才直连**。
///
/// 首次使用远程模式最容易失败的就是这一步：直连 GitHub release 在很多网络下会直接
/// 超时或中途断流（本机实测如此——当初装 rustup 和 NSIS 打包工具链，也是靠同样的
/// 代理才下下来的）。这里依次回退，并把每个源的结果都记下来，失败时一次性告诉用户。
fn download_sources() -> Vec<(&'static str, String)> {
    vec![
        ("ghfast.top 加速", format!("https://ghfast.top/{ASSET_URL}")),
        ("gh-proxy.com 加速", format!("https://gh-proxy.com/{ASSET_URL}")),
        ("moeyy 加速", format!("https://github.moeyy.xyz/{ASSET_URL}")),
        ("GitHub 直连", ASSET_URL.to_string()),
    ]
}

fn human_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    } else {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    }
}

/// curl 退出码 → 人能看懂的原因（只列常见的，其余回落）。
fn curl_reason(code: Option<i32>) -> &'static str {
    match code {
        Some(6) => "DNS 解析失败",
        Some(7) => "连不上服务器（可能被防火墙或代理拦住）",
        Some(18) => "传输中途中断",
        Some(22) => "服务器返回错误（HTTP 4xx/5xx）",
        Some(28) => "超时（网络太慢或连接卡住）",
        Some(35) => "TLS 握手失败（可能被中间设备拦截）",
        Some(56) => "连接被重置",
        Some(60) => "证书校验失败",
        Some(-1) | None => "无法启动 curl",
        _ => "网络错误",
    }
}

/// 校验文件确实是 Windows 可执行文件。
///
/// 这一步是新增的关键防线：网络被拦截、或代理/门户返回一个"状态码 200 的 HTML 错误页"
/// 时，下载看起来是成功的，存下来的却是文本。以前会直接拿它当 exe 启动，用户只看到
/// 一个完全看不懂的 spawn 错误，重试多少次都一样（因为坏文件在那儿，`is_file()` 就当它好了）。
pub fn validate_exe(path: &Path) -> Result<u64, String> {
    let len = std::fs::metadata(path)
        .map_err(|e| format!("读不到文件：{e}"))?
        .len();
    if len < MIN_EXE_BYTES {
        return Err(format!("只有 {}，明显不完整", human_size(len)));
    }
    let mut head = [0u8; 2];
    std::fs::File::open(path)
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut head))
        .map_err(|e| format!("读取文件头失败：{e}"))?;
    if &head != b"MZ" {
        return Err("内容不是 Windows 可执行文件（可能被网络拦截改写）".into());
    }
    Ok(len)
}

/// 从单个源下载，过程中持续把进度写进状态文案。
fn download_one(
    app: &AppHandle,
    t: &Tunnel,
    label: &str,
    url: &str,
    part: &Path,
) -> Result<(u64, PathBuf), String> {
    // 用"进程内唯一"的临时名，避免上一次残留的（可能还活着的）curl 把同一个文件写花。
    // 真正的安装动作在 install_binary 里做，文件名不影响最终结果。
    let part_path: PathBuf = {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        part.with_file_name(format!("cloudflared.{stamp}.part"))
    };
    let _ = std::fs::remove_file(&part_path);

    let mut child = Command::new("curl.exe")
        .args([
            "-L",
            "--fail",
            // Windows 的 schannel 在吊销服务器不可达时会直接失败（CRYPT_E_REVOCATION_OFFLINE）
            "--ssl-no-revoke",
            "--connect-timeout",
            "20",
            "--max-time",
            "900",
            // 30 秒内平均速度低于 2KB/s 就放弃，别卡在一条死连接上干等 15 分钟
            "--speed-limit",
            "2048",
            "--speed-time",
            "30",
            "--silent",
            "--show-error",
            "-o",
            &part_path.to_string_lossy(),
            url,
        ])
        .creation_flags(0x0800_0000)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法启动 curl：{e}（Windows 10 1803+ 自带 curl）"))?;

    // 关键：curl 也必须进 Job Object。cloudflared 早就被保护了，但下载用的 curl 之前没有——
    // 结果 app 一被强杀（或讲师直接关窗口），curl 就成了孤儿，继续往 .part 写，
    // 下次启动删不掉、下载内容还可能被两个进程写花。
    #[cfg(windows)]
    let _job = attach_job(&child);

    // 必须及时把 stderr 读走，否则子进程写满管道会卡住；顺便留下失败原因
    let reader = {
        let pipe = child.stderr.take();
        std::thread::spawn(move || {
            let mut buf = String::new();
            if let Some(mut s) = pipe {
                let _ = std::io::Read::read_to_string(&mut s, &mut buf);
            }
            buf
        })
    };

    let started = Instant::now();
    let mut last_emit = Instant::now()
        .checked_sub(Duration::from_secs(10))
        .unwrap_or_else(Instant::now);
    let mut last_bytes = 0u64;
    let mut last_tick = Instant::now();
    // 卡死检测：curl 的 --speed-limit 在"连接建立了但一个字节都不来"时并不可靠
    // （实测 ghfast.top 卡了 200 多秒都没被中止），所以自己盯着：只要一段时间内
    // 没有新数据进账，就杀掉换下一个源，而不是让讲师对着"正在连接…"干等。
    let mut last_progress = Instant::now();
    let mut best_bytes = 0u64;
    const STALL_SECS: u64 = 45;

    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {}
            Err(e) => return Err(format!("等待 curl 失败：{e}")),
        }

        if last_emit.elapsed() >= Duration::from_millis(600) {
            last_emit = Instant::now();
            let got = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
            if got > best_bytes {
                best_bytes = got;
                last_progress = Instant::now();
            } else if last_progress.elapsed() > Duration::from_secs(STALL_SECS) {
                let _ = child.kill();
                let _ = child.wait();
                let _ = std::fs::remove_file(&part_path);
                return Err(format!(
                    "{STALL_SECS} 秒内没有收到任何新数据（已收到 {}），换下一个源",
                    human_size(got)
                ));
            }
            let elapsed = last_tick.elapsed().as_secs_f64();
            let speed = if elapsed > 0.0 {
                (got.saturating_sub(last_bytes)) as f64 / elapsed
            } else {
                0.0
            };
            last_bytes = got;
            last_tick = Instant::now();

            let msg = if got == 0 {
                format!("正在连接 {label}…（已等待 {} 秒）", started.elapsed().as_secs())
            } else {
                let pct = (got as f64 / EXPECTED_BYTES as f64 * 100.0).min(100.0);
                format!(
                    "正在下载 cloudflared：{} / 约 {}（{pct:.0}%）· {}/s · 来源 {label}",
                    human_size(got),
                    human_size(EXPECTED_BYTES),
                    human_size(speed as u64)
                )
            };
            t.set(app, "downloading", None, &msg);
        }

        std::thread::sleep(Duration::from_millis(200));
    };

    let tail = reader.join().unwrap_or_default();
    if !status.success() {
        let _ = std::fs::remove_file(&part_path);
        let hint = curl_reason(status.code());
        let detail = tail.trim().lines().last().unwrap_or("").trim();
        return Err(if detail.is_empty() {
            format!("{hint}（curl 退出码 {:?}）", status.code())
        } else {
            format!("{hint}：{detail}")
        });
    }

    let len = validate_exe(&part_path)?;
    Ok((len, part_path))
}

/// 把下载好的临时文件"安装"成正式文件。
///
/// 为什么不能直接 rename：**Windows 上 rename 到已存在的目标会直接失败**，
/// 杀毒软件短暂占用句柄时也会失败。实测发现过"下载完成了 52MB、却因为改名失败
/// 而报错、下次又从头下"的残留（目录里躺着一个完整的 cloudflared.part），
/// 所以这里先删目标，失败再退化成复制。
fn install_binary(from: &Path, to: &Path) -> Result<(), String> {
    let _ = std::fs::remove_file(to);
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to).map_err(|e| format!("保存 cloudflared 失败：{e}"))?;
    let _ = std::fs::remove_file(from);
    Ok(())
}
/// 在几个"用户很可能已经把文件下到这儿"的目录里找现成的 cloudflared。
///
/// 实测反馈：自动下载失败时，人的第一反应就是用浏览器手动下载到「下载」文件夹。
/// 旧版本完全无视那个文件，非要自己再下一遍——于是用户只能手动改名、手动搬到
/// `%LOCALAPPDATA%\localdanmu\` 才能用。这里主动找一下，找到就直接复制进缓存。
fn find_nearby_cloudflared() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let p = PathBuf::from(profile);
        dirs.push(p.join("Downloads"));
        dirs.push(p.join("Desktop"));
    }
    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.to_path_buf())) {
        dirs.push(exe_dir);
    }

    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !name.starts_with("cloudflared") || !name.ends_with(".exe") {
                continue;
            }
            if validate_exe(&path).is_ok() {
                return Some(path);
            }
        }
    }
    None
}
/// 找到 cloudflared：优先用户手动指定的 → 缓存 → 依次尝试各下载源。
fn ensure_binary(
    app: &AppHandle,
    t: &Tunnel,
    override_path: Option<&str>,
) -> Result<PathBuf, String> {
    // 1) 手动指定的路径。这是"自动下载怎么都不行"时的逃生口——
    //    浏览器能下载、程序不能，几乎都是代理/证书环境的差异。
    crate::core::probe_log(&format!(
        "ensure_binary: 入口 override={:?} 目标={}",
        override_path,
        bin_dir().join("cloudflared.exe").display()
    ));
    if let Some(raw) = override_path.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(raw);
        return match validate_exe(&p) {
            Ok(_) => Ok(p),
            Err(e) => Err(format!(
                "设置里指定的 cloudflared 不可用（{e}）：{}\n请重新指定，或清空这项设置改回自动下载。",
                p.display()
            )),
        };
    }

    let dir = bin_dir();
    let path = dir.join("cloudflared.exe");

    // 2) 缓存。**必须校验**：以前只看文件在不在，于是半截文件/被改写的内容会被
    //    一直当成好 exe 用下去，重试多少次都失败，且错误信息毫无线索。
    crate::core::probe_log(&format!("ensure_binary: 缓存存在={}", path.is_file()));
    if path.is_file() {
        match validate_exe(&path) {
            Ok(_) => {
                crate::core::probe_log(&format!("ensure_binary: 缓存有效，直接用 {}", path.display()));
                return Ok(path)
            }
            Err(e) => {
                let bad = dir.join("cloudflared.exe.bad");
                let _ = std::fs::remove_file(&bad);
                let _ = std::fs::rename(&path, &bad);
                t.set(
                    app,
                    "downloading",
                    None,
                    &format!("已缓存的 cloudflared 不可用（{e}），将重新下载…"),
                );
            }
        }
    }

    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败：{e}"))?;
    // 清掉以前失败留下的分片：每份 50MB 上下，不清理会白白占空间
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.starts_with("cloudflared") && name.ends_with(".part") {
                let stale = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.elapsed().ok())
                    .map(|age| age.as_secs() > 3600)
                    .unwrap_or(true);
                if stale {
                    let _ = std::fs::remove_file(&p);
                }
            }
        }
    }

    // 2.5) 用户可能已经用浏览器手动下载好了（下载/桌面/exe 同级目录），先找一下。
    //      注意用 copy 而不是 move：不能把人家的原文件搬走。
    if let Some(found) = find_nearby_cloudflared() {
        crate::core::probe_log(&format!("ensure_binary: 发现现成文件 {}", found.display()));
        t.set(
            app,
            "downloading",
            None,
            &format!("发现已下载的 cloudflared，正在复制到缓存目录…（{}）", found.display()),
        );
        if std::fs::copy(&found, &path).is_ok() && validate_exe(&path).is_ok() {
            t.set(app, "starting", None, "cloudflared 已就绪（使用本机已有文件），正在建立隧道…");
            return Ok(path);
        }
        let _ = std::fs::remove_file(&path);
    }

    // 3) 依次尝试各个源
    let part = dir.join("cloudflared.part");
    let sources = download_sources();
    let mut failures: Vec<String> = Vec::new();

    for (i, (label, url)) in sources.iter().enumerate() {
        t.set(
            app,
            "downloading",
            None,
            &format!(
                "首次使用，正在下载 cloudflared（约 {}）——第 {}/{} 个源：{label}…",
                human_size(EXPECTED_BYTES),
                i + 1,
                sources.len()
            ),
        );

        crate::core::probe_log(&format!("ensure_binary: 尝试源 {label}"));
        match download_one(app, t, label, url, &part) {
            Ok((bytes, written)) => {
                // 用 download_one 实际写入的那个临时文件（名字带时间戳）来安装，
                // 不能再用这里的 part——两者不是同一个文件（这里踩过一次）。
                install_binary(&written, &path)?;
                t.set(
                    app,
                    "starting",
                    None,
                    &format!(
                        "cloudflared 已就绪（{}，来源 {label}），正在建立隧道…",
                        human_size(bytes)
                    ),
                );
                return Ok(path);
            }
            Err(e) => failures.push(format!("{label}：{e}")),
        }
    }

    let _ = std::fs::remove_file(&part);
    Err(format!(
        "下载 cloudflared 失败，{} 个源都试过了：\n{}\n\n\
         办法一：点面板上的「手动指定 cloudflared」选中你自己下载的 exe。\n\
         办法二：手动下载后放到这个路径（文件名必须是 cloudflared.exe）：\n{}\n\
         下载地址：{ASSET_URL}",
        failures.len(),
        failures
            .iter()
            .map(|f| format!("· {f}"))
            .collect::<Vec<_>>()
            .join("\n"),
        path.display()
    ))
}

#[cfg(windows)]
use std::os::windows::process::CommandExt;
