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
}

pub struct Tunnel {
    inner: Mutex<Inner>,
    busy: AtomicBool,
}

impl Tunnel {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                status: "idle".into(),
                ..Default::default()
            }),
            busy: AtomicBool::new(false),
        })
    }

    pub fn snapshot(&self) -> Value {
        let g = self.inner.lock().unwrap();
        json!({
            "status": g.status,
            "url": g.url,
            "qr": g.qr,
            "message": g.message,
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
    pub fn start(self: &Arc<Self>, app: AppHandle, port: u16, token: String) {
        if self.busy.swap(true, Ordering::SeqCst) {
            return; // 已经在启动/运行
        }
        let me = Arc::clone(self);
        let app2 = app.clone();
        self.set(&app, "starting", None, "正在准备隧道…");

        std::thread::spawn(move || {
            let result = me.run(&app2, port, &token);
            me.busy.store(false, Ordering::SeqCst);
            if let Err(err) = result {
                me.set(&app2, "error", None, &err);
            }
        });
    }

    fn run(self: &Arc<Self>, app: &AppHandle, port: u16, token: &str) -> Result<(), String> {
        let bin = ensure_binary(app, self)?;
        self.set(app, "starting", None, "正在建立隧道…");

        let mut child = Command::new(&bin)
            .args([
                "tunnel",
                "--url",
                &format!("http://127.0.0.1:{port}"),
                "--no-autoupdate",
                "--loglevel",
                "info",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW：不弹黑框
            .spawn()
            .map_err(|e| format!("启动 cloudflared 失败：{e}"))?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // 起两个读线程，避免管道写满导致子进程卡住
        if let Some(out) = stdout {
            std::thread::spawn(move || {
                for _line in BufReader::new(out).lines().map_while(Result::ok) {}
            });
        }

        let me2 = Arc::clone(self);
        let app2 = app.clone();
        let token = token.to_string();
        let url_re = regex::Regex::new(r"https://[a-z0-9-]+\.trycloudflare\.com").unwrap();

        let reader = std::thread::spawn(move || {
            let mut found = false;
            if let Some(err) = stderr {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    if !found {
                        if let Some(m) = url_re.find(&line) {
                            found = true;
                            let base = m.as_str().to_string();
                            let join = format!("{base}/j/{token}");
                            me2.set(&app2, "running", Some(join), "隧道已就绪，手机用流量可访问");
                        }
                    }
                    // 明显的失败信号
                    if line.contains("failed to request quick Tunnel") || line.contains("ERR ") {
                        me2.set(&app2, "error", None, "隧道建立失败，检查网络后重试");
                    }
                }
            }
            found
        });

        {
            let mut g = self.inner.lock().unwrap();
            g.child = Some(child);
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
                me4.set(&app4, "error", None, "隧道进程已退出");
            }
        });

        Ok(())
    }

    pub fn stop(&self, app: &AppHandle) {
        let mut g = self.inner.lock().unwrap();
        if let Some(mut child) = g.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
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
        let mut g = self.inner.lock().unwrap();
        if let Some(mut child) = g.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
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
