const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startMock } = require('./mock');

const STORE = path.join(__dirname, 'tenants.json');

const mock = startMock();
const TUNNEL_ID = mock.state.tunnelId;
const DNS_ID = mock.state.dnsId;
let port = 0;
function run(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, script), ...args], {
      env: {
        ...process.env,
        CF_API_TOKEN: 'fake-token',
        CF_API_BASE: `http://127.0.0.1:${port}`,
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
  port = await mock.listen();
  console.log(`mock 监听 ${port}\n`);

  let failed = 0;
  const check = (name, cond) => {
    console.log(`${cond ? '✅' : '❌'} ${name}`);
    if (!cond) failed += 1;
  };

  console.log('--- provision ---');
  await run('provision.js', ['--label', '测试讲师', '--host', 'u7f3k2']);

  check('创建了隧道', mock.state.hits.some((h) => h.method === 'POST' && h.url.endsWith('/cfd_tunnel')));
  const ingress = mock.state.hits.find((h) => h.method === 'PUT' && h.url.includes('/configurations'));
  check(
    '入口规则指向 http://localhost:8080',
    Boolean(ingress) && ingress.body.config.ingress[0].service === 'http://localhost:8080'
  );
  check(
    '入口规则主机名正确',
    Boolean(ingress) && ingress.body.config.ingress[0].hostname === 'u7f3k2.teachergeng.space'
  );
  const dns = mock.state.hits.find((h) => h.method === 'POST' && h.url.endsWith('/dns_records'));
  check('DNS 是 CNAME 指向 cfargotunnel', Boolean(dns) && dns.body.type === 'CNAME' && dns.body.content === `${TUNNEL_ID}.cfargotunnel.com`);
  check('DNS 走代理（橙云）', Boolean(dns) && dns.body.proxied === true);

  const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  check('tenants.json 记录了一条', store.tenants.length === 1);
  check('记录了 hostname', store.tenants[0].hostname === 'u7f3k2.teachergeng.space');
  check('记录了 tunnelId', store.tenants[0].tunnelId === TUNNEL_ID);
  check('没有把令牌写进文件', !JSON.stringify(store).includes('fake-tunnel-token'));

  console.log('\n--- revoke ---');
  await run('revoke.js', ['--label', '测试讲师']);
  check('删除了 DNS 记录', mock.state.dnsDeleted);
  check('删除了隧道', mock.state.tunnelDeleted);
  const after = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  check('记录已移除', after.tenants.length === 0);

  await mock.close();
  console.log(failed === 0 ? '\n全部通过' : `\n失败 ${failed} 项`);
  fs.rmSync(STORE, { force: true });
  process.exit(failed === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('FAIL', e.message);
  await mock.close();
  process.exit(1);
});
