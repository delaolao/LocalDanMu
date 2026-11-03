//! 远程模式（测试版）：用 Cloudflare Quick Tunnel 把本机的会话服务暴露到公网，
//! 让学员在场地 WiFi 不可用时，用手机流量也能进入。
//!
//! 设计取舍（这是"测试版"，刻意保持最小）：
//! - 不内置 cloudflared（40MB，会毁掉整个应用 5MB 的体积优势），首次使用时下载到
//!   `%LOCALAPPDATA%\localdanmu\cloudflared.exe` 并缓存
//! - 用 Quick Tunnel（随机域名、免账号），每场重新生成即可；正式版再考虑 Named Tunnel
//! - **没有端到端加密**：消息在 Cloudflare 边缘是明文，界面上必须如实提示
//!
//! 进程生命周期：start 起子进程并读 stderr 找公网地址；stop / 应用退出时 kill。

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::qr;

const DOWNLOAD_URL: &str =
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe";

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
}

impl Tunnel {
    pub fn new(key: crate::crypto::RemoteKey) -> Arc<Self> {
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
        })
    }

    pub fn auto(&self) -> bool {
        self.auto.load(Ordering::SeqCst)
    }

    pub fn set_auto(&self, on: bool) {
        self.auto.store(on, Ordering::SeqCst);
    }

    /// 意外掉线后排队重连：延迟后复用上一次的端口与口令重新开隧道。
    fn schedule_restart(self: &Arc<Self>, app: &AppHandle) {
        if !self.auto.load(Ordering::SeqCst) || self.stopped.load(Ordering::SeqCst) {
            return;
        }
        if self.retrying.swap(true, Ordering::SeqCst) {
            return;
        }
        let me = Arc::clone(self);
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            me.retrying.store(false, Ordering::SeqCst);
            if !me.auto.load(Ordering::SeqCst) || me.stopped.load(Ordering::SeqCst) {
                return;
            }
            let target = me.last.lock().ok().and_then(|g| g.clone());
            if let Some(args) = target {
                me.set(&app, "starting", None, "隧道断开，正在自动重连…");
                me.start(app.clone(), args);
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
        let _ = app.emit(EVENT, self.snapshot());
    }

    /// 启动隧道。`port` 是本机会话服务端口，`token` 是房间口令。
    pub fn start(self: &Arc<Self>, app: AppHandle, args: StartArgs) {
        if self.busy.swap(true, Ordering::SeqCst) {
            return; // 已经在启动/运行
        }
        self.stopped.store(false, Ordering::SeqCst);
        if let Ok(mut g) = self.last.lock() {
            *g = Some(args.clone());
        }
        let me = Arc::clone(self);
        let app2 = app.clone();
        let fixed = !args.tunnel_token.is_empty();
        self.set(
            &app,
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
                me.schedule_restart(&app2);
            }
        });
    }

    fn run(self: &Arc<Self>, app: &AppHandle, args: StartArgs) -> Result<(), String> {
        let bin = ensure_binary(app, self)?;
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
            me3.schedule_restart(&app3);
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
                me4.schedule_restart(&app4);
            }
        });

        Ok(())
    }

    pub fn stop(&self, app: &AppHandle) {
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
            let _ = app.emit(EVENT, self.snapshot());
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

/// 找到 cloudflared；没有就下载一次并缓存
fn ensure_binary(app: &AppHandle, t: &Tunnel) -> Result<PathBuf, String> {
    let dir = bin_dir();
    let path = dir.join("cloudflared.exe");
    if path.is_file() {
        return Ok(path);
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败：{e}"))?;
    t.set(app, "downloading", None, "首次使用，正在下载 cloudflared（约 40MB）…");

    let part = dir.join("cloudflared.part");
    let _ = std::fs::remove_file(&part);

    let status = Command::new("curl.exe")
        .args([
            "-L",
            "--fail",
            "--retry",
            "2",
            "--connect-timeout",
            "20",
            // Windows 的 schannel 在吊销服务器不可达时会直接失败（CRYPT_E_REVOCATION_OFFLINE）
            "--ssl-no-revoke",
            "-o",
            &part.to_string_lossy(),
            DOWNLOAD_URL,
        ])
        .creation_flags(0x0800_0000)
        .status()
        .map_err(|e| format!("调用 curl 失败：{e}（Windows 10 1803+ 自带 curl）"))?;

    if !status.success() {
        let _ = std::fs::remove_file(&part);
        return Err(format!(
            "下载 cloudflared 失败（curl 退出码 {:?}）。可手动下载后放到：{}",
            status.code(),
            path.display()
        ));
    }

    std::fs::rename(&part, &path).map_err(|e| format!("保存 cloudflared 失败：{e}"))?;
    Ok(path)
}

#[cfg(windows)]
use std::os::windows::process::CommandExt;
