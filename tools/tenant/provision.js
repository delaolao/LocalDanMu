'use strict';
/**
 * TENANT：给一个用户单独开一条固定隧道。
 *
 * 用法：
 *   set CF_API_TOKEN=xxx
 *   node tools/tenant/provision.js --label 张三-2026春季 [--host u7f3k2] [--dry-run]
 *
 * 做的事：
 *   1. 在账号下建一条隧道 ldm-<label>-<rand>
 *   2. 配置入口规则：<host>.dm.<zone> → http://localhost:8080
 *   3. 建 CNAME 记录指向 <tunnel-id>.cfargotunnel.com
 *   4. 把结果写进 tools/tenant/tenants.json（含隧道令牌，切勿外传）
 *
 * 注意：隧道令牌是凭据。一个人一把，泄露只影响他自己，删掉隧道即可吊销。
 */

const fs = require('node:fs');
const path = require('node:path');
const cf = require('./cf');

const STORE = path.join(__dirname, 'tenants.json');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

function loadStore() {
  if (!fs.existsSync(STORE)) return { tenants: [] };
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch (e) {
    throw new Error(`tenants.json 解析失败：${e.message}`);
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

function randomSuffix(len = 6) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789'; // 去掉易混的 l/o/0/1
  let out = '';
  for (let i = 0; i < len; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

(async () => {
  const label = arg('label');
  if (!label) {
    console.error('用法: node tools/tenant/provision.js --label <标识> [--host <子域>] [--dry-run]');
    process.exit(1);
  }
  const zoneName = process.env.CF_ZONE_NAME || 'teachergeng.space';
  const sub = arg('host') || `u${randomSuffix()}`;
  const hostname = sub.includes('.') ? sub : `${sub}.dm.${zoneName}`;
  const dryRun = has('dry-run');

  console.log(`账号 zone : ${zoneName}`);
  console.log(`公开主机名: ${hostname}`);
  if (dryRun) {
    console.log('\n[dry-run] 将要执行：');
    console.log('  1. POST /accounts/<id>/cfd_tunnel  { name: ldm-…, config_src: cloudflare }');
    console.log(`  2. PUT  /accounts/<id>/cfd_tunnel/<tid>/configurations → ${hostname} → http://localhost:8080`);
    console.log(`  3. POST /zones/<zid>/dns_records  CNAME ${hostname} → <tid>.cfargotunnel.com`);
    console.log('  4. 写入 tools/tenant/tenants.json');
    return;
  }

  const accountId = await cf.resolveAccountId(process.env.CF_ACCOUNT_ID);
  const zoneId = await cf.resolveZoneId(zoneName);
  console.log(`account   : ${accountId}`);
  console.log(`zone      : ${zoneId}`);

  // 中文名会被过滤成空串，退回 "user" 而不是留下 `ldm--xxxx` 这种怪名字
  const slug = label.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'user';
  const tunnelName = `ldm-${slug}-${randomSuffix(4)}`;
  process.stdout.write(`\n[1/3] 创建隧道 ${tunnelName} … `);
  const tunnel = await cf.createTunnel(accountId, tunnelName);
  console.log(`ok (${tunnel.id})`);

  process.stdout.write('[2/3] 配置入口规则 … ');
  await cf.setIngress(accountId, tunnel.id, hostname, 'http://localhost:8080');
  console.log('ok');

  process.stdout.write('[3/3] 创建 DNS 记录 … ');
  const dnsRecordId = await cf.createDnsRecord(zoneId, hostname, tunnel.id);
  console.log('ok');

  const store = loadStore();
  const record = {
    label,
    hostname,
    tunnelName,
    tunnelId: tunnel.id,
    dnsRecordId,
    zoneName,
    zoneId,
    accountId,
    createdAt: new Date().toISOString()
  };
  store.tenants.push(record);
  saveStore(store);

  console.log('\n================ 交给讲师的信息 ================');
  console.log(`公开域名 : ${hostname}`);
  console.log(`隧道令牌 : ${tunnel.token}`);
  console.log('================================================');
  console.log('\n把上面两行填进程序：设置与网络 → 固定隧道。');
  console.log('令牌请通过私聊发送，不要公开；吊销用 revoke.js。');
  console.log(`\n已记录到 ${STORE}`);
})().catch((e) => {
  console.error('\n失败:', e.message);
  process.exit(1);
});
