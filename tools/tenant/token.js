'use strict';
/**
 * TENANT：查看某条隧道的令牌（给讲师填进程序用的那串 eyJ...）。
 *
 * 用法：
 *   node tools/tenant/token.js --host syklong.teachergeng.space
 *   node tools/tenant/token.js --label "宋亚科-永久"
 *   node tools/tenant/token.js --list          # 列出所有隧道（不含令牌）
 *
 * 需要 CF_API_TOKEN（API 令牌，不是隧道令牌）。
 * 注意：令牌是凭据，只有本机和对方该知道；不要贴群里。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cf = require('./cf');

const STORE = process.env.LDM_TENANT_STORE || path.join(__dirname, 'tenants.json');
// 网页版保存过令牌就直接用，省得每次 export
const TOKEN_FILE = path.join(
  process.env.LOCALAPPDATA || os.homedir(),
  'localdanmu',
  'tenant-api-token.txt'
);
const ZONE_NAME = process.env.CF_ZONE_NAME || 'teachergeng.space';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(`--${name}`);

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch {
    return { tenants: [] };
  }
}

/** 台账里没有就按域名去 Cloudflare 反查隧道 */
async function findTunnel(accountId, target) {
  const store = loadStore();
  const rec = (store.tenants || []).find(
    (t) => t.hostname === target || t.label === target
  );
  if (rec && rec.tunnelId) return rec;

  const tunnels = await cf.call('GET', `/accounts/${accountId}/cfd_tunnel?is_deleted=false`);
  for (const t of tunnels || []) {
    try {
      const cfg = await cf.call('GET', `/accounts/${accountId}/cfd_tunnel/${t.id}/configurations`);
      const ingress = (cfg && cfg.config && cfg.config.ingress) || [];
      if (ingress.some((i) => i.hostname === target)) {
        return { label: target.split('.')[0], hostname: target, tunnelId: t.id, tunnelName: t.name };
      }
    } catch {
      /* 跳过 */
    }
  }
  return null;
}

(async () => {
  // --list 只读本地台账，不需要 API 令牌
  if (has('list')) {
    const store = loadStore();
    if ((store.tenants || []).length === 0) {
      console.log('本地还没有记录，可以先跑：node tools/tenant/recover.js --write');
      return;
    }
    console.log('label\t\t域名\t\t\t\t隧道 ID');
    for (const t of store.tenants || []) {
      console.log(`${t.label}\t${t.hostname}\t${t.tunnelId}`);
    }
    return;
  }

  const host = arg('host');
  const label = arg('label');
  if (!host && !label) {
    console.error('用法: node tools/tenant/token.js --host <域名> | --label <标签> | --list');
    process.exitCode = 1;
    return;
  }

  if (!process.env.CF_API_TOKEN) {
    try {
      const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (saved) process.env.CF_API_TOKEN = saved;
    } catch {
      /* 没有就没有，下面会报错提示 */
    }
  }

  const zone = await cf.resolveZone(ZONE_NAME);
  const accountId = await cf.resolveAccountId(process.env.CF_ACCOUNT_ID, zone.accountId);

  const target = host || label;
  const found = await findTunnel(accountId, host ? host : target);
  if (!found) throw new Error(`找不到 ${target} 对应的隧道`);

  if (!host) {
    // 用 label 时，先确认台账里只有这一条，避免重名取错
    const store = loadStore();
    const same = (store.tenants || []).filter((t) => t.label === label);
    if (same.length > 1) {
      console.error(`label「${label}」有 ${same.length} 条记录，请改用 --host：`);
      for (const s of same) console.error(`  ${s.hostname}`);
      process.exitCode = 1;
      return;
    }
  }

  const token = await cf.call('GET', `/accounts/${accountId}/cfd_tunnel/${found.tunnelId}/token`);
  console.log(`域名 : ${found.hostname}`);
  console.log(`隧道 : ${found.tunnelName || found.tunnelId}`);
  console.log(`令牌 : ${token}`);
  console.log('\n填进程序：设置与网络 → 固定隧道。令牌是凭据，别外传。');
})().catch((e) => {
  console.error('\n失败:', e.message);
  process.exitCode = 1;
});
