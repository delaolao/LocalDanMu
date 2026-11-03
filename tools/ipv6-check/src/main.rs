//! 现场 IPv6 自检
//!
//! 目的：在一分钟之内回答一个问题——**手机用流量，能不能直接访问到这台笔记本？**
//!
//! 做法：
//! 1. 列出本机所有 IPv6 地址，找出公网地址（2000::/3）
//! 2. 在本机起一个临时 HTTP 服务，同时监听 IPv6 和 IPv4
//! 3. 把访问地址画成二维码（BMP，自动用系统看图程序打开）
//! 4. 手机**关掉 WiFi、用流量**扫码：能打开页面 → 入站可达，这条链路可用
//!
//! 用法：
//!   ipv6-check.exe                 # 默认端口 8099，跑 10 分钟
//!   ipv6-check.exe --port 8123
//!   ipv6-check.exe --minutes 3
//!   ipv6-check.exe --no-qr         # 不弹二维码，只打印链接

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv6Addr, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[cfg(windows)]
extern "system" {
    fn SetConsoleOutputCP(codepage: u32) -> i32;
}

fn main() {
    #[cfg(windows)]
    unsafe {
        // 让中文在 cmd / Windows Terminal 里正常显示
        SetConsoleOutputCP(65001);
    }

    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print_help();
        return;
    }

    let port = flag(&args, "--port").unwrap_or(8099).clamp(1, 65535) as u16;
    let minutes = flag(&args, "--minutes").unwrap_or(10);
    let want_qr = !args.iter().any(|a| a == "--no-qr");

    print_banner();

    // ---------- 1. 本机地址盘点 ----------
    let report = scan_addresses();
    report.print();

    let Some(global6) = report.global6.first().copied() else {
        println!("\n结论：这台机器现在**没有公网 IPv6 地址**，手机流量无法直连。");
        report.print_no_ipv6_help();
        // 仍然起一个 IPv4 服务，方便对比“局域网内能通、但流量进不来”
        serve(report, None, port, minutes, want_qr, false);
        return;
    };

    // ---------- 2. 出站 IPv6 连通性 ----------
    let outbound = check_outbound_v6();
    match outbound {
        true => println!("\n[出站] IPv6 能访问外网 ✅"),
        false => println!("\n[出站] IPv6 访问外网失败 ❌（多半是上游没真正开通，或 IPv6 网关不可达）"),
    }

    // ---------- 3. 起服务、出二维码 ----------
    serve(report, Some(global6), port, minutes, want_qr, outbound);
}

fn print_help() {
    println!(
        "现场 IPv6 自检\n\
         \n\
         用法: ipv6-check.exe [选项]\n\
         \n\
           --port <N>       HTTP 服务端口，默认 8099\n\
           --minutes <N>    运行分钟数，默认 10\n\
           --no-qr          不生成/打开二维码，只打印链接\n\
           -h, --help       显示帮助"
    );
}

fn flag(args: &[String], name: &str) -> Option<u32> {
    let i = args.iter().position(|a| a == name)?;
    args.get(i + 1).and_then(|v| v.parse().ok())
}

fn print_banner() {
    println!("==============================================");
    println!(" 现场 IPv6 自检  ·  LocalDanMu");
    println!(" 回答的问题：手机用流量，能不能直连这台电脑");
    println!("==============================================");
}

// ---------------------------------------------------------------- 地址扫描

struct AddressReport {
    global6: Vec<Ipv6Addr>,
    ula6: Vec<(String, Ipv6Addr)>,
    link6: Vec<(String, Ipv6Addr)>,
    v4: Vec<(String, std::net::Ipv4Addr)>,
}

fn is_global_v6(ip: &Ipv6Addr) -> bool {
    // 2000::/3 是当前的全球单播空间；排除文档/示例段和 Teredo
    let seg = ip.segments()[0];
    let global = (seg & 0xe000) == 0x2000;
    let doc = seg == 0x2001 && ip.segments()[1] == 0x0db8;
    let teredo = seg == 0x2001 && ip.segments()[1] == 0x0000;
    global && !doc && !teredo
}

fn is_ula(ip: &Ipv6Addr) -> bool {
    (ip.segments()[0] & 0xfe00) == 0xfc00
}

fn scan_addresses() -> AddressReport {
    let mut report = AddressReport {
        global6: Vec::new(),
        ula6: Vec::new(),
        link6: Vec::new(),
        v4: Vec::new(),
    };

    if let Ok(list) = if_addrs::get_if_addrs() {
        for itf in list {
            match itf.addr {
                if_addrs::IfAddr::V6(v6) => {
                    if v6.ip.is_loopback() || v6.ip.is_unspecified() {
                        continue;
                    }
                    if v6.ip.is_unicast_link_local() {
                        report.link6.push((itf.name.clone(), v6.ip));
                    } else if is_global_v6(&v6.ip) {
                        report.global6.push(v6.ip);
                    } else if is_ula(&v6.ip) {
                        report.ula6.push((itf.name.clone(), v6.ip));
                    }
                }
                if_addrs::IfAddr::V4(v4) => {
                    if v4.ip.is_loopback() || v4.ip.is_link_local() {
                        continue;
                    }
                    report.v4.push((itf.name.clone(), v4.ip));
                }
            }
        }
    }

    report
}

impl AddressReport {
    fn print(&self) {
        println!("\n[地址]");
        if self.global6.is_empty() {
            println!("  公网 IPv6 : （无）");
        } else {
            for ip in &self.global6 {
                println!("  公网 IPv6 : {ip}");
            }
        }
        for (name, ip) in &self.ula6 {
            println!("  私有 IPv6 : {ip}  ({name})");
        }
        if !self.v4.is_empty() {
            for (name, ip) in &self.v4 {
                println!("  IPv4      : {ip}  ({name})");
            }
        }
    }

    fn print_no_ipv6_help(&self) {
        println!("\n可能原因（按常见程度排序）：");
        println!("  1. 路由器的 IPv6 没开：进管理页 → 上网设置 → IPv6 → 开启（动态 IP / DHCPv6）");
        println!("  2. 路由器没下发前缀：局域网设置 → IPv6 地址分配 → 开启（SLAAC/RA）");
        println!("  3. 这个 Wi-Fi 是访客网络，本身只有 IPv4（会议室很常见）");
        println!("  4. 网线插的是只开 IPv4 的口，换一个口试试");
        if !self.link6.is_empty() {
            println!("\n（本机有链路本地地址 {} 个，说明网卡支持 IPv6，只是没拿到公网前缀）", self.link6.len());
        }
        println!("\n提示：可以先用手机连同一个 Wi-Fi 打开 https://test-ipv6.com 看有没有 IPv6 评分。");
        println!("下面仍然会起一个服务，用来看局域网内是否正常。");
    }
}

/// 出站 IPv6 探测：能不能连上外网的 IPv6 地址
fn check_outbound_v6() -> bool {
    let targets: [&str; 2] = ["www.baidu.com:80", "www.qq.com:80"];
    for t in targets {
        if let Ok(addrs) = t.to_socket_addrs() {
            for addr in addrs {
                if !addr.is_ipv6() {
                    continue;
                }
                if let Ok(stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(3)) {
                    drop(stream);
                    return true;
                }
            }
        }
    }
    false
}

// ---------------------------------------------------------------- 服务

fn serve(
    report: AddressReport,
    global6: Option<Ipv6Addr>,
    port: u16,
    minutes: u32,
    want_qr: bool,
    outbound_ok: bool,
) {
    let open_qr = std::env::args().all(|a| a != "--no-open");
    // 优先双栈监听 [::]，Windows 上默认同时接受 IPv4
    let listener = match TcpListener::bind(SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), port)) {
        Ok(l) => l,
        Err(err) => {
            println!("\n端口 {port} 绑定失败（{err}），换一个端口试试：--port 8123");
            return;
        }
    };

    let url_v6 = global6.map(|ip| format!("http://[{ip}]:{port}/"));
    // 挑一个“最像现场局域网”的 IPv4：192.168 > 10 > 172.16-31，排除 CGNAT/Tailscale
    let v4 = report
        .v4
        .iter()
        .max_by_key(|(name, ip)| v4_score(*ip) + iface_penalty(name))
        .map(|(_, ip)| *ip);
    let url_v4 = v4.map(|ip| format!("http://{ip}:{port}/"));

    println!("\n[服务] 已监听 [::]:{port}（同时接受 IPv4）");
    if let Some(u) = &url_v6 {
        println!("  手机流量地址 : {u}");
    }
    if let Some(u) = &url_v4 {
        println!("  局域网地址   : {u}");
    }

    if want_qr {
        if let Some(u) = url_v6.as_ref().or(url_v4.as_ref()) {
            match write_qr_bmp(u) {
                Ok(path) => {
                    println!("  二维码已生成 : {}", path.display());
                    if open_qr {
                        open_file(&path);
                    }
                }
                Err(err) => println!("  二维码生成失败（{err}），请手动输入上面的地址"),
            }
        }
    }

    println!("\n[操作] 手机**关闭 WiFi、改用移动数据**，扫上面的二维码（或手输地址）。");
    println!("       页面能打开 = 入站可达 ✅；打不开 = 路由器/防火墙拦了 ❌");
    println!("[提示] 首次运行 Windows 会弹防火墙提示，必须勾选并允许。");
    println!("       运行 {minutes} 分钟后自动退出（Ctrl+C 可提前结束）。\n");

    let hits = Arc::new(AtomicU64::new(0));
    let deadline = Instant::now() + Duration::from_secs(minutes as u64 * 60);

    // 让 accept 可以被超时打断：设置非阻塞 + 轮询
    listener.set_nonblocking(true).ok();

    while Instant::now() < deadline {
        match listener.accept() {
            Ok((stream, addr)) => {
                let n = hits.fetch_add(1, Ordering::SeqCst) + 1;
                handle(stream, addr, n);
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(_) => break,
        }
    }

    let total = hits.load(Ordering::SeqCst);
    println!("\n[结束] 共收到 {total} 次访问。");
    if total == 0 {
        println!("\n一次都没进来，基本可以判定：");
        println!("  · 路由器 IPv6 防火墙拦了入站（最常见），或");
        println!("  · 上游运营商没给公网 IPv6（出站 {}）", if outbound_ok { "通，但入站不通" } else { "也不通" });
        println!("\n处理顺序：");
        println!("  1. 路由器 → 安全设置 → IPv6 防火墙 → 关闭，或给本机 IPv6 加一条允许入站规则");
        println!("  2. 再试一次；仍然不通就退回局域网 + Cloudflare Tunnel 方案");
    } else {
        println!("\n入站可达 ✅ 这条链路可以用：手机流量能直接连到这台电脑。");
    }
}

fn handle(mut stream: TcpStream, addr: SocketAddr, n: u64) {
    stream.set_read_timeout(Some(Duration::from_secs(3))).ok();
    let mut buf = [0u8; 1024];
    let read = stream.read(&mut buf).unwrap_or(0);
    let head = String::from_utf8_lossy(&buf[..read]);
    let path = head.split_whitespace().nth(1).unwrap_or("/");

    let ip_tag = if addr.is_ipv6() { "IPv6" } else { "IPv4" };
    println!(
        "  [{n}] {ip_tag} {}  {}",
        addr.ip(),
        if path == "/favicon.ico" { "（图标）" } else { "← 手机打开了页面" }
    );

    if path == "/favicon.ico" {
        let _ = stream.write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n");
        return;
    }

    let body = format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <title>通了</title><style>\
         body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;\
         background:#06100e;color:#edfdf7;font-family:-apple-system,\"PingFang SC\",\"Microsoft YaHei\",sans-serif}}\
         .box{{text-align:center;padding:28px 22px;max-width:520px}}\
         .ok{{font-size:64px;line-height:1}}\
         h1{{font-size:24px;margin:14px 0 6px}}\
         p{{color:#9db5ac;font-size:14px;line-height:1.7;margin:6px 0}}\
         code{{color:#34d399;word-break:break-all}}\
         </style></head><body><div class=\"box\">\
         <div class=\"ok\">✅</div><h1>入站可达</h1>\
         <p>手机已经通过 <b>{ip_tag}</b> 直接访问到这台电脑。</p>\
         <p>你的地址：<code>{ip}</code></p>\
         <p>服务器时间：{time}</p>\
         <p>这条链路可以承载弹幕：把地址填进程序，让学员用这个二维码入场即可。</p>\
         </div></body></html>",
        ip_tag = ip_tag,
        ip = addr.ip(),
        time = chrono_like_now(),
    );

    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

/// 虚拟网卡（VMware / Hyper-V / WSL / Tailscale）不是现场的真网卡，降权
fn iface_penalty(name: &str) -> i32 {
    let n = name.to_lowercase();
    let virtual_hints = [
        "vmware", "virtualbox", "vethernet", "hyper-v", "loopback", "tailscale", "zerotier", "wsl", "docker",
    ];
    if virtual_hints.iter().any(|h| n.contains(h)) {
        -120
    } else {
        0
    }
}

fn v4_score(ip: std::net::Ipv4Addr) -> i32 {
    let o = ip.octets();
    if o[0] == 192 && o[1] == 168 {
        90
    } else if o[0] == 10 {
        70
    } else if o[0] == 172 && (16..=31).contains(&o[1]) {
        50
    } else if o[0] == 100 && (64..=127).contains(&o[1]) {
        -100 // 运营商级 NAT / Tailscale
    } else if o[0] == 169 && o[1] == 254 {
        -100
    } else {
        0
    }
}

fn chrono_like_now() -> String {
    // 不引时间库：用 SystemTime 转成本地时区的粗略表示（只用于展示）
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = now / 86400;
    let secs = now % 86400;
    // 简化：按 UTC+8 显示，日期用 1970 起的天数换算
    let (y, m, d) = civil_from_days(days as i64 + 8 * 3600 / 86400);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", (secs / 3600 + 8) % 24, (secs / 60) % 60, secs % 60)
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ---------------------------------------------------------------- 二维码

/// 生成 BMP 二维码（不引 image 库，BMP 手写最简单且 Windows 原生能开）
fn write_qr_bmp(text: &str) -> std::io::Result<PathBuf> {
    let code = qrcode::QrCode::new(text.as_bytes()).map_err(std::io::Error::other)?;
    let modules = code.width();
    let quiet = 4usize;
    let scale = 10usize; // 屏幕上要便于手机远距离扫描
    let side = (modules + quiet * 2) * scale;

    let colors = code.to_colors();
    let mut px = vec![255u8; side * side]; // 白底
    for y in 0..modules {
        for x in 0..modules {
            if colors[y * modules + x] == qrcode::Color::Dark {
                for dy in 0..scale {
                    for dx in 0..scale {
                        let px_x = (x + quiet) * scale + dx;
                        let px_y = (y + quiet) * scale + dy;
                        px[px_y * side + px_x] = 0;
                    }
                }
            }
        }
    }

    // 24 位 BMP：行自下而上、每行 4 字节对齐、像素 BGR
    let row_bytes = side * 3;
    let pad = (4 - row_bytes % 4) % 4;
    let stride = row_bytes + pad;
    let pixel_bytes = stride * side;
    let file_size = 14 + 40 + pixel_bytes;

    let mut out = Vec::with_capacity(file_size);
    out.extend_from_slice(b"BM");
    out.extend_from_slice(&(file_size as u32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&54u32.to_le_bytes());
    out.extend_from_slice(&40u32.to_le_bytes());
    out.extend_from_slice(&(side as i32).to_le_bytes());
    out.extend_from_slice(&(side as i32).to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&24u16.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&(pixel_bytes as u32).to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&2835i32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());

    for y in (0..side).rev() {
        for x in 0..side {
            let v = px[y * side + x];
            out.extend_from_slice(&[v, v, v]);
        }
        out.extend(std::iter::repeat(0u8).take(pad));
    }

    let path = std::env::temp_dir().join("localdanmu-ipv6-qr.bmp");
    std::fs::write(&path, out)?;
    Ok(path)
}

fn open_file(path: &std::path::Path) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "", &path.to_string_lossy()])
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = path;
    }
}
