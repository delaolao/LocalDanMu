'use strict';
/**
 * TENANT：改一条已开通隧道的「服务端口」。
 *
 * 固定隧道的入口规则（Public Hostname → http://localhost:8080）存在 Cloudflare 侧，
 * 本机换端口就必须同步改它。这个命令只改入口规则，**不重建隧道、不换令牌**，
 * 所以对方不用重新填。
 *
 * 用法：
 *   node tools/tenant/port.js --host syklong.teachergeng.space --port 18080
 *   node tools/tenant/port.js --label "宋亚科-永久" --port 18080
 *
 * 域名在本地台账里找不到时，会直接去 Cloudflare 列隧道、按入口规则匹配。
 */

const fs = require('node:fs');
const path = require('node:path');
const cf = require('./cf');

const STORE = process.env.LDM_TENANT_STORE || path.join(__dirname, 'tenants.json');
const ZONE_NAME = process.env.CF_ZONE_NAME || 'teachergeng.space';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch {
    return { tenants: [] };
  }
}
function saveStore(s) {
  fs.writeFileSync(STORE, JSON.stringify(s, null, 2) + '\n', 'utf8');
}

/** 从 Cloudflare 侧找出 hostname 对应哪条隧道、当前入口是什么 */
async function lookupByHostname(accountId, hostname) {
  const tunnels = await cf.call('GET', `/accounts/${accountId}/cfd_tunnel?is_deleted=false`);
  for (const t of tunnels || []) {
    if (!String(t.name || '').startsWith('ldm-')) continue;
    try {
      const cfg = await cf.call('GET', `/accounts/${accountId}/cfd_tunnel/${t.id}/configurations`);
      const ingress = (cfg && cfg.config && cfg.config.ingress) || [];
      const hit = ingress.find((i) => i.hostname === hostname);
      if (hit) return { tunnel: t, ingress, current: hit.service };
    } catch {
      /* 没有远端配置就跳过 */
    }
  }
  return null;
}

(async () => {
  const port = Number(arg('port'));
  const host = arg('host');
  const label = arg('label');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error('用法: node tools/tenant/port.js --host <域名>|--label <标签> --port <1024-65535>');
    process.exitCode = 1;
    return;
  }

  const store = loadStore();
  let rec = store.tenants.find(
    (t) => (host && t.hostname === host) || (label && t.label === label)
  );
  // 台账里没有就按域名去 Cloudflare 找
  let target = rec;
  const zone = await cf.resolveZone(ZONE_NAME);
  const accountId = await cf.resolveAccountId(process.env.CF_ACCOUNT_ID, zone.accountId);

  if (!target) {
    const hostname = host || (label ? label.toLowerCase() : '');
    if (!hostname) throw new Error('要指定 --host 或 --label');
    const found = await lookupByHostname(accountId, hostname.includes('.') ? hostname : `${hostname}.${ZONE_NAME}`);
    if (!found) throw new Error(`账号里找不到入口为 ${hostname} 的隧道`);
    target = {
      label: label || hostname.split('.')[0],
      hostname: hostname.includes('.') ? hostname : `${hostname}.${ZONE_NAME}`,
      tunnelName: found.tunnel.name,
      tunnelId: found.tunnel.id,
      accountId,
      zoneId: zone.id,
      zoneName: ZONE_NAME,
      dnsRecordId: '',
      createdAt: found.tunnel.created_at
    };
    rec = target;
  }

  const service = `http://localhost:${port}`;
  const cfg = await cf.call(
    'GET',
    `/accounts/${accountId}/cfd_tunnel/${target.tunnelId}/configurations`
  );
  const ingress = (cfg && cfg.config && cfg.config.ingress) || [];
  const idx = ingress.findIndex((i) => i.hostname === target.hostname);
  if (idx < 0) throw new Error(`隧道 ${target.tunnelId} 里没有 ${target.hostname} 这条入口`);

  const before = ingress[idx].service;
  ingress[idx].service = service;
  await cf.call('PUT', `/accounts/${accountId}/cfd_tunnel/${target.tunnelId}/configurations`, {
    config: { ingress }
  });

  // 台账里有就顺手更新
  if (store.tenants.includes(rec)) {
    rec.servicePort = port;
    saveStore(store);
  }

  console.log(`入口已更新：${target.hostname}`);
  console.log(`  ${before}  →  ${service}`);
  console.log('\n隧道没重建、令牌没变，对方不用重新填。');
  console.log('记得把程序「设置与网络 → 服务端口」也改成同一个值，然后重启程序。');
})().catch((e) => {
  console.error('\n失败:', e.message);
  process.exitCode = 1;
});
