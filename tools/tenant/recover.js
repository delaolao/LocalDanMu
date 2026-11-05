'use strict';
/**
 * TENANT：从 Cloudflare 侧恢复 tenants.json。
 *
 * 场景：本地记录丢了（误删、换机器），但账号里的隧道和 DNS 还在。
 * 这个脚本会列出账号下所有 ldm-* 隧道，读它们的入口规则拿到域名，
 * 再从 DNS 记录里找到对应记录 ID，重建本地台账。
 *
 * 用法：
 *   $env:CF_API_TOKEN = "你的 API 令牌"
 *   node tools/tenant/recover.js            # 只打印，不写文件
 *   node tools/tenant/recover.js --write    # 写回 tenants.json（会先备份旧文件）
 */

const fs = require('node:fs');
const path = require('node:path');
const cf = require('./cf');

const STORE = process.env.LDM_TENANT_STORE || path.join(__dirname, 'tenants.json');
const ZONE_NAME = process.env.CF_ZONE_NAME || 'teachergeng.space';
const write = process.argv.includes('--write');

function shortId(s) {
  return s.replace(/-/g, '').slice(0, 8);
}

(async () => {
  const zone = await cf.resolveZone(ZONE_NAME);
  const accountId = await cf.resolveAccountId(process.env.CF_ACCOUNT_ID, zone.accountId);
  console.log(`账号 ${accountId} / zone ${zone.id} (${ZONE_NAME})`);

  const tunnels = await cf.call('GET', `/accounts/${accountId}/cfd_tunnel?is_deleted=false`);
  const mine = (tunnels || []).filter((t) => String(t.name || '').startsWith('ldm-'));
  console.log(`找到 ${mine.length} 条 ldm-* 隧道`);

  const dns = await cf.call('GET', `/zones/${zone.id}/dns_records?type=CNAME&per_page=100`);
  const dnsByTarget = new Map();
  for (const r of dns || []) {
    if (r.content && r.content.endsWith('.cfargotunnel.com')) {
      dnsByTarget.set(r.content, r);
    }
  }

  const rebuilt = [];
  for (const t of mine) {
    let hostname = '';
    let servicePort = 8080;
    try {
      const cfg = await cf.call('GET', `/accounts/${accountId}/cfd_tunnel/${t.id}/configurations`);
      const ingress = (cfg && cfg.config && cfg.config.ingress) || [];
      const pub = ingress.find((i) => i.hostname);
      if (pub) {
        hostname = pub.hostname;
        const m = /:(\d+)\s*$/.exec(pub.service || '');
        if (m) servicePort = Number(m[1]);
      }
    } catch {
      /* 没有远端配置就跳过域名 */
    }
    if (!hostname) continue;
    const rec = dnsByTarget.get(`${t.id}.cfargotunnel.com`);
    rebuilt.push({
      label: hostname.split('.')[0],
      hostname,
      tunnelName: t.name,
      tunnelId: t.id,
      dnsRecordId: rec ? rec.id : '',
      servicePort,
      zoneName: ZONE_NAME,
      zoneId: zone.id,
      accountId,
      createdAt: t.created_at || new Date().toISOString(),
      recoveredAt: new Date().toISOString()
    });
  }

  console.log(`\n可恢复 ${rebuilt.length} 条：`);
  for (const r of rebuilt) {
    console.log(
      `  ${r.hostname}\t隧道 ${shortId(r.tunnelId)}\tDNS ${r.dnsRecordId ? shortId(r.dnsRecordId) : '（缺失）'}\t端口 ${r.servicePort}`
    );
  }

  if (!write) {
    console.log('\n（只看不改。确认无误后加 --write 写回）');
    return;
  }

  if (fs.existsSync(STORE)) {
    const backup = `${STORE}.bak-${Date.now()}`;
    fs.copyFileSync(STORE, backup);
    console.log(`\n旧文件已备份到 ${backup}`);
  }
  fs.writeFileSync(STORE, JSON.stringify({ tenants: rebuilt }, null, 2) + '\n', 'utf8');
  console.log(`已写入 ${STORE}（${rebuilt.length} 条）`);
  console.log('label 是按域名前缀猜的，可以自己改。');
})().catch((e) => {
  console.error('\n失败:', e.message);
  process.exitCode = 1;
});
