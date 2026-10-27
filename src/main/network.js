'use strict';

/**
 * 网络环境探测
 *
 * 关键点：Windows 上装了 Hyper-V / WSL / VMware / Tailscale / 各类 VPN 之后，
 * os.networkInterfaces() 里会多出一堆手机永远连不上的虚拟网卡。
 * 因此不能"取第一个 192.168"，而要打分排序，并允许用户在界面上手动指定。
 */

const os = require('os');
const dgram = require('dgram');
const { execFile } = require('child_process');

const VIRTUAL_RE =
  /(vethernet|vmware|virtualbox|vboxnet|hyper-v|docker|wsl|tailscale|zerotier|tap-|wintun|wireguard|vpn|radmin|hamachi|bluetooth|loopback|npcap|clash|singbox|virtual|vEthernet)/i;
const WIFI_RE = /(wi-?fi|wlan|wlp|无线)/i;
const ETH_RE = /(ethernet|以太网|本地连接|^en|^eth|以太网\s*\d)/i;

/** 通过 UDP connect 拿到默认路由使用的本机地址（不会真的发包，断网也可用）。 */
function defaultRouteAddress() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      try {
        sock.close();
      } catch (_) {
        /* ignore */
      }
      resolve(val);
    };
    sock.once('error', () => finish(null));
    const timer = setTimeout(() => finish(null), 800);
    if (timer.unref) timer.unref();
    try {
      sock.connect(9, '8.8.8.8', () => {
        let addr = null;
        try {
          addr = sock.address().address;
        } catch (_) {
          addr = null;
        }
        finish(addr);
      });
    } catch (_) {
      finish(null);
    }
  });
}

function scoreCandidate(iface, addr, defaultAddr) {
  let score = 0;
  const name = String(iface || '');

  if (VIRTUAL_RE.test(name)) score -= 120;
  if (WIFI_RE.test(name)) score += 30;
  else if (ETH_RE.test(name)) score += 20;

  if (addr === defaultAddr) score += 200;

  if (/^192\.168\./.test(addr)) score += 90;
  else if (/^10\./.test(addr)) score += 70;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) score += 50;
  else if (/^169\.254\./.test(addr)) score -= 80;
  else if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr)) score -= 40; // 运营商级 NAT / Tailscale
  else score += 10;

  return score;
}

/** 返回所有 IPv4 候选，按可用性从高到低排序。 */
async function listCandidates() {
  const defaultAddr = await defaultRouteAddress();
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs || []) {
      if (!a || a.family !== 'IPv4' || a.internal) continue;
      if (/^127\./.test(a.address)) continue;
      out.push({
        name,
        address: a.address,
        netmask: a.netmask,
        score: scoreCandidate(name, a.address, defaultAddr),
        isDefaultRoute: a.address === defaultAddr,
        virtual: VIRTUAL_RE.test(name)
      });
    }
  }
  out.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name));
  return out;
}

/** 选中一个地址：优先用户指定，其次排序最高且非虚拟网卡，最后兜底。 */
async function pick(preferredIp) {
  const list = await listCandidates();
  if (preferredIp) {
    const hit = list.find((c) => c.address === preferredIp);
    if (hit) return { ...hit, list, fallback: false };
  }
  const best = list.find((c) => !c.virtual) || list[0];
  if (!best) {
    return { name: '-', address: '127.0.0.1', list, fallback: true };
  }
  return { ...best, list, fallback: false };
}

/**
 * 读取 Windows 网络位置（公用/专用）。公用网络下 Windows 防火墙默认禁止入站，
 * 这是"手机扫码打不开"的第二大原因，需要在界面上给出提示。
 */
function connectionProfiles() {
  return new Promise((resolve) => {
    const ps =
      'Get-NetConnectionProfile | Select-Object InterfaceAlias,Name,NetworkCategory | ConvertTo-Json -Compress';
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 256 },
      (err, stdout) => {
        if (err) {
          if (process.env.LDM_NET_DEBUG) {
            console.error('[net] powershell failed:', err.message, '| stderr:', String(err.stderr || '').slice(0, 500));
          }
          return resolve([]);
        }
        try {
          const raw = String(stdout).trim();
          if (!raw) return resolve([]);
          const parsed = JSON.parse(raw);
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch (_) {
          resolve([]);
        }
      }
    );
    if (child && child.stdin) child.stdin.end();
  });
}

module.exports = { listCandidates, pick, connectionProfiles, defaultRouteAddress };
