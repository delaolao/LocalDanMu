'use strict';
/**
 * TENANT 自测：用本地 mock 服务器跑通 provision / revoke 的完整流程。
 *
 * 不需要真的 Cloudflare 账号，验证的是：
 *   - 请求路径与请求体是否符合 Cloudflare API 的约定
 *   - tenants.json 是否按预期写入/移除
 *   - revoke 是否按记录删 DNS 与隧道
 *
 * 用法：node tools/tenant/selftest.js
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const STORE = path.join(__dirname, 'tenants.json');
const ACCOUNT = 'acct-test-1';
const ZONE = 'zone-test-1';
const TUNNEL_ID = '11111111-2222-3333-4444-555555555555';
const DNS_ID = 'dns-test-1';

let hits = [];
let tunnelDeleted = false;
let dnsDeleted = false;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    hits.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
    const send = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const ok = (result) => send(200, { success: true, result });
    const u = req.url.split('?')[0];

    // 故意返回空：细粒度令牌本来就列不出账号，逼脚本走 zone.account.id 的回退\n    if (u === '/accounts' && req.method === 'GET') return ok([]);
    if (u === '/zones' && req.method === 'GET') {
      return ok([{ id: ZONE, name: 'teachergeng.space', account: { id: ACCOUNT } }]);
    }
    if (u.endsWith('/cfd_tunnel') && req.method === 'POST') {
      return ok({ id: TUNNEL_ID, name: JSON.parse(body).name });
    }
    if (u.endsWith(`/cfd_tunnel/${TUNNEL_ID}/token`) && req.method === 'GET') {
      return ok('fake-tunnel-token');
    }
    if (u.endsWith(`/cfd_tunnel/${TUNNEL_ID}/configurations`) && req.method === 'PUT') {
      return ok({});
    }
    if (u.endsWith('/dns_records') && req.method === 'POST') return ok({ id: DNS_ID });
    if (u.endsWith(`/dns_records/${DNS_ID}`) && req.method === 'DELETE') {
      dnsDeleted = true;
      return ok({ id: DNS_ID });
    }
    if (u.endsWith(`/cfd_tunnel/${TUNNEL_ID}`) && req.method === 'DELETE') {
      tunnelDeleted = true;
      return ok({ id: TUNNEL_ID });
    }
    return send(404, { success: false, errors: [{ message: `unexpected ${req.method} ${u}` }] });
  });
});

// 必须用异步 spawn：spawnSync 会阻塞本进程的事件循环，mock 服务器就没法回包了
function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, script), ...args], {
      env: {
        ...process.env,
        CF_API_TOKEN: 'fake-token',
        CF_API_BASE: `http://127.0.0.1:${server.address().port}`,
        CF_ZONE_NAME: 'teachergeng.space'
      },
      stdio: 'inherit'
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} 退出码 ${code}`));
    });
    child.on('error', reject);
  });
}

(async () => {
  fs.rmSync(STORE, { force: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  console.log(`mock 监听 ${server.address().port}\n`);

  let failed = 0;
  const check = (name, cond) => {
    console.log(`${cond ? '✅' : '❌'} ${name}`);
    if (!cond) failed += 1;
  };

  console.log('--- provision ---');
  await run('provision.js', ['--label', '测试讲师', '--host', 'u7f3k2']);

  check('创建了隧道', hits.some((h) => h.method === 'POST' && h.url.endsWith('/cfd_tunnel')));
  const ingress = hits.find((h) => h.method === 'PUT' && h.url.includes('/configurations'));
  check(
    '入口规则指向 http://localhost:8080',
    Boolean(ingress) && ingress.body.config.ingress[0].service === 'http://localhost:8080'
  );
  check(
    '入口规则主机名正确',
    Boolean(ingress) && ingress.body.config.ingress[0].hostname === 'u7f3k2.teachergeng.space'
  );
  const dns = hits.find((h) => h.method === 'POST' && h.url.endsWith('/dns_records'));
  check('DNS 是 CNAME 指向 cfargotunnel', Boolean(dns) && dns.body.type === 'CNAME' && dns.body.content === `${TUNNEL_ID}.cfargotunnel.com`);
  check('DNS 走代理（橙云）', Boolean(dns) && dns.body.proxied === true);

  const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  check('tenants.json 记录了一条', store.tenants.length === 1);
  check('记录了 hostname', store.tenants[0].hostname === 'u7f3k2.teachergeng.space');
  check('记录了 tunnelId', store.tenants[0].tunnelId === TUNNEL_ID);
  check('没有把令牌写进文件', !JSON.stringify(store).includes('fake-tunnel-token'));

  console.log('\n--- revoke ---');
  await run('revoke.js', ['--label', '测试讲师']);
  check('删除了 DNS 记录', dnsDeleted);
  check('删除了隧道', tunnelDeleted);
  const after = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  check('记录已移除', after.tenants.length === 0);

  server.close();
  console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`);
  fs.rmSync(STORE, { force: true });
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FAIL', e.message);
  server.close();
  process.exit(1);
});
