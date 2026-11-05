'use strict';
/**
 * TENANT：吊销一个用户的固定隧道。
 *
 * 用法：
 *   node tools/tenant/revoke.js --label 张三-2026春季
 *   node tools/tenant/revoke.js --host u7f3k2.dm.teachergeng.space
 *   node tools/tenant/revoke.js --list
 *
 * 做的事：删 DNS 记录 → 删隧道（force，断开正在跑的连接器）→ 从 tenants.json 移除。
 * 删完之后对方手里的令牌立即失效。
 */

const fs = require('node:fs');
const path = require('node:path');
const cf = require('./cf');

// 允许用环境变量指定存储位置：自测/体验模式必须指向临时文件，
// 绝不能写坏真实记录（这个坑踩过一次，恢复很麻烦）
const STORE = process.env.LDM_TENANT_STORE || path.join(__dirname, 'tenants.json');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(`--${name}`);

function loadStore() {
  if (!fs.existsSync(STORE)) return { tenants: [] };
  return JSON.parse(fs.readFileSync(STORE, 'utf8'));
}
function saveStore(store) {
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

(async () => {
  const store = loadStore();

  if (has('list')) {
    if (store.tenants.length === 0) {
      console.log('还没有开通任何租户。');
      return;
    }
    console.log('label\t\t\thostname\t\ttunnelId\tcreatedAt');
    for (const t of store.tenants) {
      console.log(`${t.label}\t${t.hostname}\t${t.tunnelId}\t${t.createdAt}`);
    }
    return;
  }

  const label = arg('label');
  const host = arg('host');
  if (!label && !host) {
    console.error(
      '用法: node tools/tenant/revoke.js --label <标识> | --host <域名> | --list'
    );
    process.exit(1);
  }

  const idx = store.tenants.findIndex(
    (t) => (label && t.label === label) || (host && t.hostname === host)
  );
  if (idx < 0) {
    console.error('没找到对应的租户记录，检查 --label / --host');
    process.exit(1);
  }
  const t = store.tenants[idx];
  console.log(`吊销: ${t.label} / ${t.hostname} / ${t.tunnelId}`);

  process.stdout.write('[1/2] 删除 DNS 记录 … ');
  try {
    await cf.deleteDnsRecord(t.zoneId, t.dnsRecordId);
    console.log('ok');
  } catch (e) {
    console.log(`跳过（${e.message}）`);
  }

  process.stdout.write('[2/2] 删除隧道 … ');
  try {
    await cf.deleteTunnel(t.accountId, t.tunnelId);
    console.log('ok');
  } catch (e) {
    console.log(`失败（${e.message}）——可能需要到控制台手动删除`);
    process.exit(1);
  }

  store.tenants.splice(idx, 1);
  saveStore(store);
  console.log('\n完成。对方手里的令牌已失效。');
})().catch((e) => {
  console.error('\n失败:', e.message);
  process.exitCode = 1;
});
