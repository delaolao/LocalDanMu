//! 网卡探测与地址选择。与旧版 `src/main/network.js` 打分规则逐条对齐。
//!
//! 关键点：Windows 上装了 Hyper-V / WSL / VMware / Tailscale / 各类 VPN 之后，
//! 枚举出来的网卡里会多出一堆手机永远连不上的虚拟网卡。
//! 因此不能"取第一个 192.168"，而要打分排序，并允许用户在界面上手动指定。

use std::io::Read;
use std::net::{Ipv4Addr, UdpSocket};
use std::process::{Command, Stdio};
use std::time::Duration;

/// 虚拟网卡特征（命中即大幅减分）。
const VIRTUAL_HINTS: &[&str] = &[
    "vethernet", "vmware", "virtualbox", "vboxnet", "hyper-v", "docker", "wsl", "tailscale",
    "zerotier", "tap-", "wintun", "wireguard", "vpn", "radmin", "hamachi", "bluetooth", "loopback",
    "npcap", "clash", "singbox", "virtual",
];
const WIFI_HINTS: &[&str] = &["wi-fi", "wifi", "wlan", "wlp", "无线"];
const ETH_HINTS: &[&str] = &["ethernet", "以太网", "本地连接"];

#[derive(Debug, Clone)]
pub struct Candidate {
    pub name: String,
    pub address: Ipv4Addr,
    pub netmask: Option<Ipv4Addr>,
    pub score: i32,
    pub is_default_route: bool,
    pub is_virtual: bool,
}

#[derive(Debug, Clone)]
pub struct Picked {
    pub name: String,
    pub address: Ipv4Addr,
    pub is_virtual: bool,
    pub fallback: bool,
    pub list: Vec<Candidate>,
}

/// 通过 UDP connect 拿到默认路由使用的本机地址（不会真的发包，断网时也会失败返回 None）。
pub fn default_route_address() -> Option<Ipv4Addr> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.set_write_timeout(Some(Duration::from_millis(200))).ok()?;
    // 只为了触发路由选择，不真的发数据
    if sock.connect("8.8.8.8:80").is_err() {
        return None;
    }
    match sock.local_addr().ok()? {
        std::net::SocketAddr::V4(a) if !a.ip().is_loopback() => Some(*a.ip()),
        _ => None,
    }
}

fn name_matches(name: &str, hints: &[&str]) -> bool {
    let lower = name.to_lowercase();
    hints.iter().any(|h| lower.contains(h))
}

/// 打分：与旧版 `scoreCandidate` 同分同权重。
pub fn score_candidate(name: &str, addr: Ipv4Addr, default_addr: Option<Ipv4Addr>) -> i32 {
    let mut score = 0;

    if name_matches(name, VIRTUAL_HINTS) {
        score -= 120;
    }
    if name_matches(name, WIFI_HINTS) {
        score += 30;
    } else if name_matches(name, ETH_HINTS) {
        score += 20;
    }

    if Some(addr) == default_addr {
        score += 200;
    }

    let o = addr.octets();
    if o[0] == 192 && o[1] == 168 {
        score += 90;
    } else if o[0] == 10 {
        score += 70;
    } else if o[0] == 172 && (16..=31).contains(&o[1]) {
        score += 50;
    } else if o[0] == 169 && o[1] == 254 {
        score -= 80;
    } else if o[0] == 100 && (64..=127).contains(&o[1]) {
        // 运营商级 NAT / Tailscale
        score -= 40;
    } else {
        score += 10;
    }

    score
}

/// 所有 IPv4 候选，按可用性从高到低排序。
pub fn list_candidates() -> Vec<Candidate> {
    let default_addr = default_route_address();
    let mut out = Vec::new();

    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        for iface in interfaces {
            let if_addrs::IfAddr::V4(v4) = iface.addr else {
                continue;
            };
            let ip = v4.ip;
            if ip.is_loopback() || ip.is_unspecified() {
                continue;
            }
            let is_virtual = name_matches(&iface.name, VIRTUAL_HINTS);
            out.push(Candidate {
                name: iface.name.clone(),
                address: ip,
                netmask: Some(v4.netmask),
                score: score_candidate(&iface.name, ip, default_addr),
                is_default_route: Some(ip) == default_addr,
                is_virtual,
            });
        }
    }

    out.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.name.cmp(&b.name)));
    out
}

/// 选中一个地址：优先用户指定 → 排序最高且非虚拟网卡 → 兜底列表第一个 → 最后回环。
pub fn pick(preferred_ip: Option<&str>) -> Picked {
    let list = list_candidates();

    if let Some(pref) = preferred_ip {
        if let Some(hit) = list.iter().find(|c| c.address.to_string() == pref) {
            return Picked {
                name: hit.name.clone(),
                address: hit.address,
                is_virtual: hit.is_virtual,
                fallback: false,
                list,
            };
        }
    }

    let best = list
        .iter()
        .find(|c| !c.is_virtual)
        .or_else(|| list.first())
        .cloned();

    match best {
        Some(b) => Picked {
            name: b.name,
            address: b.address,
            is_virtual: b.is_virtual,
            fallback: false,
            list,
        },
        None => Picked {
            name: "-".into(),
            address: Ipv4Addr::new(127, 0, 0, 1),
            is_virtual: false,
            fallback: true,
            list,
        },
    }
}

/* ------------------------------------------------- 网络位置（公用/专用） */

#[derive(Debug, Clone, Default)]
pub struct ConnectionProfile {
    pub interface_alias: String,
    pub name: String,
    /// 0 = 公用，1 = 专用，2 = 域
    pub network_category: i64,
}

impl ConnectionProfile {
    pub fn is_public(&self) -> bool {
        self.network_category == 0
    }
}

/// 读 Windows 网络位置。公用网络下防火墙默认拦截入站，这是"手机扫码打不开"的第二大原因。
///
/// 保留 PowerShell 方案（旧版同款）：走 WinRT/COM 的网络列表 API 需要额外 COM 绑定，
/// 而这一个查询每次开机只跑一两次，成本可以忽略。
pub fn connection_profiles() -> Vec<ConnectionProfile> {
    let script = "Get-NetConnectionProfile | Select-Object InterfaceAlias,Name,NetworkCategory | ConvertTo-Json -Compress";

    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-NoLogo",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());

    // 关键：不加这个，每 15 秒跳一次黑框，现场会很难看
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let Ok(mut child) = cmd.spawn() else {
        return Vec::new();
    };
    let mut buf = String::new();
    if let Some(stdout) = child.stdout.as_mut() {
        let _ = stdout.read_to_string(&mut buf);
    }
    let _ = child.wait();

    let trimmed = buf.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return Vec::new();
    };

    let items: Vec<serde_json::Value> = match value {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Object(_) => vec![value],
        _ => Vec::new(),
    };

    items
        .into_iter()
        .map(|v| ConnectionProfile {
            interface_alias: v
                .get("InterfaceAlias")
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string(),
            name: v.get("Name").and_then(|x| x.as_str()).unwrap_or_default().to_string(),
            // ConvertTo-Json 会把枚举序列化成数字：0=公用 1=专用 2=域
            network_category: v
                .get("NetworkCategory")
                .and_then(|x| x.as_i64().or_else(|| x.as_str().map(|s| match s {
                    "Public" => 0,
                    "Private" => 1,
                    "DomainAuthenticated" => 2,
                    _ => -1,
                })))
                .unwrap_or(-1),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> Ipv4Addr {
        s.parse().unwrap()
    }

    #[test]
    fn private_ranges_score_higher_than_public() {
        let d = Some(ip("192.168.1.5"));
        let wifi_private = score_candidate("WLAN", ip("192.168.1.5"), d);
        let eth_public = score_candidate("Ethernet", ip("203.0.113.9"), d);
        assert!(wifi_private > eth_public, "{wifi_private} vs {eth_public}");
    }

    #[test]
    fn default_route_wins_over_everything() {
        let d = Some(ip("10.0.0.7"));
        let default_eth = score_candidate("Ethernet", ip("10.0.0.7"), d);
        let wifi_192 = score_candidate("WLAN", ip("192.168.1.5"), d);
        assert!(default_eth > wifi_192, "默认路由 +200 应当压过 WiFi +30");
    }

    #[test]
    fn virtual_adapters_are_penalised() {
        let d = None;
        let wsl = score_candidate("vEthernet (WSL)", ip("172.25.0.1"), d);
        let plain = score_candidate("Ethernet", ip("172.25.1.1"), d);
        assert!(wsl < plain - 100, "虚拟网卡应当被扣到最底");
    }

    #[test]
    fn link_local_addresses_are_penalised() {
        assert!(score_candidate("Ethernet", ip("169.254.10.1"), None) < 0);
    }

    #[test]
    fn cgnat_range_is_penalised() {
        assert!(score_candidate("Tailscale", ip("100.100.1.1"), None) < 0);
    }

    #[test]
    fn pick_never_returns_empty_on_real_machine() {
        let picked = pick(None);
        // 无论有没有网，pick 都必须给出一个地址，绝不能 panic
        assert!(!picked.name.is_empty() || picked.fallback);
    }

    #[test]
    fn pick_respects_preferred_address() {
        let all = list_candidates();
        if let Some(first) = all.first() {
            let want = first.address.to_string();
            let picked = pick(Some(&want));
            assert_eq!(picked.address.to_string(), want);
            assert!(!picked.fallback);
        }
    }
}
