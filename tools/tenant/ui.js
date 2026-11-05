'use strict';
/**
 * TENANT 的本地网页版：浏览器里填表开通，省得记命令行参数。
 *
 *   node tools/tenant/ui.js            # 打开浏览器，用真实 Cloudflare API
 *   node tools/tenant/ui.js --mock     # 体验模式：假 API，随便点，不会真的建东西
 *   node tools/tenant/ui.js --no-open  # 不自动开浏览器（调试用）
 *
 * 令牌保存在 %LOCALAPPDATA%\localdanmu\tenant-api-token.txt（仅本机，页面上可清除）。
 */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exec } = require('node:child_process');

const useMock = process.argv.includes('--mock');
const noOpen = process.argv.includes('--no-open');

// 允许用环境变量指定存储位置：自测/体验模式必须指向临时文件，
// 绝不能写坏真实记录（这个坑踩过一次，恢复很麻烦）
const STORE = process.env.LDM_TENANT_STORE || path.join(__dirname, 'tenants.json');
const TOKEN_FILE = path.join(
  process.env.LOCALAPPDATA || os.homedir(),
  'localdanmu',
  'tenant-api-token.txt'
);

const ZONE_NAME = process.env.CF_ZONE_NAME || 'teachergeng.space';
const SERVICE = 'http://localhost:18080';

function savedToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}
function saveToken(t) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t, { encoding: 'utf8', mode: 0o600 });
}
function clearToken() {
  fs.rmSync(TOKEN_FILE, { force: true });
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

function randomId(len = 6) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < len; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/* ------------------------------------------------------------------ 业务 */

async function apiState() {
  const hasToken = Boolean(process.env.CF_API_TOKEN || savedToken());
  const store = loadStore();
  let account = '';
  let error = '';
  if (hasToken) {
    try {
      const cf = getCf();
      const zone = await cf.resolveZone(ZONE_NAME);
      account = await cf.resolveAccountId(process.env.CF_ACCOUNT_ID, zone.accountId);
    } catch (e) {
      error = e.message;
    }
  }
  return {
    zone: ZONE_NAME,
    service: SERVICE,
    hasToken,
    account,
    error,
    mock: useMock,
    tenants: (store.tenants || []).map((t) => ({
      label: t.label,
      hostname: t.hostname,
      createdAt: t.createdAt
    }))
  };
}

let cfModule;
function getCf() {
  if (cfModule) return cfModule;
  try {
    cfModule = require('./cf');
  } catch (e) {
    throw new Error(e.message);
  }
  return cfModule;
}

async function provision(label, host, port) {
  const cf = getCf();
  const sub = (host || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(sub)) {
    throw new Error('域名标识只能用字母数字和连字符，且不能以连字符开头');
  }
  const hostname = `${sub}.${ZONE_NAME}`;
  // 程序端口固定 18080，这里默认跟随；一般不需要改
  const servicePort = Number(port) || 18080;
  if (!Number.isInteger(servicePort) || servicePort < 1024 || servicePort > 65535) {
    throw new Error('服务端口要在 1024–65535 之间');
  }
  const service = `http://localhost:${servicePort}`;
  const store = loadStore();
  if ((store.tenants || []).some((t) => t.hostname === hostname)) {
    throw new Error(`${hostname} 已经开通过了`);
  }

  const zone = await cf.resolveZone(ZONE_NAME);
  const accountId = await cf.resolveAccountId(process.env.CF_ACCOUNT_ID, zone.accountId);

  const slug =
    label
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'user';
  const tunnelName = `ldm-${slug}-${randomId(4)}`;

  const tunnel = await cf.createTunnel(accountId, tunnelName);
  await cf.setIngress(accountId, tunnel.id, hostname, service);
  const dnsRecordId = await cf.createDnsRecord(zone.id, hostname, tunnel.id);

  store.tenants = store.tenants || [];
  store.tenants.push({
    label,
    hostname,
    tunnelName,
    tunnelId: tunnel.id,
    dnsRecordId,
    servicePort,
    zoneName: ZONE_NAME,
    zoneId: zone.id,
    accountId,
    createdAt: new Date().toISOString()
  });
  saveStore(store);

  return { hostname, token: tunnel.token };
}

async function revoke(label) {
  const cf = getCf();
  const store = loadStore();
  const idx = (store.tenants || []).findIndex((t) => t.label === label);
  if (idx < 0) throw new Error('找不到这条记录，刷新页面再试');
  const t = store.tenants[idx];

  await cf.deleteDnsRecord(t.zoneId, t.dnsRecordId).catch(() => {});
  await cf.deleteTunnel(t.accountId, t.tunnelId);
  store.tenants.splice(idx, 1);
  saveStore(store);
  return { hostname: t.hostname };
}

/* ------------------------------------------------------------------ HTTP */

function json(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) reject(new Error('请求太大'));
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('请求体不是 JSON'));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const u = req.url.split('?')[0];
  try {
    if (u === '/' || u === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }
    if (u === '/api/state' && req.method === 'GET') return json(res, 200, await apiState());

    if (u === '/api/token' && req.method === 'POST') {
      const { token } = await readBody(req);
      const t = (token || '').trim();
      if (!t) throw new Error('令牌不能为空');
      if (t.startsWith('eyJ')) {
        throw new Error('这是隧道令牌（eyJ...），不是 API 令牌。API 令牌是 40 位随机串。');
      }
      process.env.CF_API_TOKEN = t;
      cfModule = undefined;
      const cf = getCf();
      const zone = await cf.resolveZone(ZONE_NAME); // 借它验证令牌
      saveToken(t);
      const account = await cf.resolveAccountId(process.env.CF_ACCOUNT_ID, zone.accountId);
      return json(res, 200, { ok: true, account, zone: zone.id });
    }

    if (u === '/api/token' && req.method === 'DELETE') {
      clearToken();
      delete process.env.CF_API_TOKEN;
      return json(res, 200, { ok: true });
    }

    if (u === '/api/provision' && req.method === 'POST') {
      const { label, host, port } = await readBody(req);
      if (!label || !label.trim()) throw new Error('标签不能为空');
      const out = await provision(label.trim(), host, port);
      return json(res, 200, { ok: true, ...out });
    }

    if (u === '/api/revoke' && req.method === 'POST') {
      const { label } = await readBody(req);
      return json(res, 200, { ok: true, ...(await revoke(label)) });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
});

/* ------------------------------------------------------------------ 页面 */

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TENANT · 多讲师开通</title>
<style>
  :root {
    --bg:#0f1512; --card:#17201c; --line:#26332d; --text:#e8f3ee; --muted:#8aa79b;
    --accent:#34d399; --accent-ink:#04120d; --danger:#f87171; --warn:#fbbf24;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:760px;margin:0 auto;padding:28px 20px 60px}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:var(--muted);font-size:13px;margin-bottom:22px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}
  .card h2{font-size:14px;margin:0 0 4px;display:flex;align-items:center;gap:8px}
  .hint{color:var(--muted);font-size:12.5px;margin:0 0 12px}
  label{display:block;font-size:12.5px;color:var(--muted);margin:12px 0 6px}
  input{width:100%;background:#0c1310;border:1px solid var(--line);border-radius:9px;color:var(--text);
        padding:9px 11px;font-size:14px;font-family:inherit}
  input:focus{outline:none;border-color:var(--accent)}
  .row{display:flex;gap:8px}
  .row input{flex:1}
  button{background:var(--accent);color:var(--accent-ink);border:0;border-radius:9px;padding:9px 14px;
         font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit}
  button.ghost{background:transparent;color:var(--text);border:1px solid var(--line);font-weight:400}
  button.danger{background:transparent;color:var(--danger);border:1px solid #472626;font-weight:400;padding:5px 10px;font-size:12px}
  button:disabled{opacity:.5;cursor:default}
  .preview{font-family:Consolas,monospace;font-size:13px;color:var(--accent);margin-top:8px;word-break:break-all}
  .res{margin-top:14px;border:1px dashed var(--line);border-radius:10px;padding:12px;display:none}
  .res.show{display:block}
  .kv{display:flex;gap:8px;align-items:center;margin:6px 0;font-family:Consolas,monospace;font-size:12.5px;word-break:break-all}
  .kv b{color:var(--muted);font-weight:400;flex:0 0 auto;font-family:inherit}
  .warn{color:var(--warn);font-size:12px;margin-top:8px}
  ul.tenants{list-style:none;padding:0;margin:0}
  ul.tenants li{display:flex;justify-content:space-between;align-items:center;gap:10px;
                padding:9px 0;border-bottom:1px solid var(--line)}
  ul.tenants li:last-child{border-bottom:0}
  .empty{color:var(--muted);font-size:13px}
  .badge{font-size:11px;padding:1px 7px;border-radius:99px;background:#1f3a2f;color:var(--accent)}
  .toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#241a1a;color:#ffb4b4;
         border:1px solid #472626;padding:9px 16px;border-radius:10px;font-size:13px;opacity:0;transition:.2s}
  .toast.show{opacity:1}
</style>
</head>
<body>
<div class="wrap">
  <h1>TENANT · 多讲师开通</h1>
  <div class="sub" id="sub">给每个讲师开一条独立隧道，域名形如 <code>名字.teachergeng.space</code></div>

  <div class="card" id="tokenCard">
    <h2>① Cloudflare API 令牌</h2>
    <p class="hint">
      到 <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" style="color:var(--accent)">我的个人资料 → API 令牌</a>
      创建自定义令牌，权限勾选：<b>账户 → Cloudflare Tunnel → 编辑</b>、
      <b>区域 → DNS → 编辑</b>、<b>区域 → 区域 → 读取</b>。
      <br>注意别填成隧道令牌（<code>eyJ...</code> 开头的那种）。
    </p>
    <div id="tokenForm">
      <div class="row">
        <input id="tokenInput" type="password" placeholder="粘贴 40 位 API 令牌" autocomplete="off">
        <button id="saveToken">保存并验证</button>
      </div>
    </div>
    <div id="tokenSaved" style="display:none">
      <div class="kv"><b>令牌</b><span>已保存 <span class="badge">本机</span></span>
        <button class="ghost" id="clearToken" style="margin-left:auto;padding:4px 10px;font-size:12px">清除</button>
      </div>
      <div class="kv"><b>账号</b><span id="accountId">—</span></div>
    </div>
  </div>

  <div class="card">
    <h2>② 开通新讲师</h2>
    <p class="hint">标签只给自己看（方便回头找人）；域名标识会拼成 <code>&lt;标识&gt;.teachergeng.space</code>，可以改。</p>
    <p class="hint" style="color:var(--warn)">程序固定监听 18080，这里默认跟随。
      程序固定用 18080，这里一般不用动。</p>
    <label>标签</label>
    <input id="label" placeholder="例如：张三-2026春季">
    <label>域名标识</label>
    <div class="row">
      <input id="host" placeholder="例如：zhangsan">
      <button class="ghost" id="regen" title="换一个随机标识">🎲 换一个</button>
    </div>
    <label>服务端口（要和程序「设置与网络 → 服务端口」一致）</label>
    <input id="port" type="number" min="1024" max="65535" value="18080">
    <div class="preview" id="preview">—</div>
    <div style="margin-top:14px"><button id="go">开通</button></div>

    <div class="res" id="result">
      <div class="kv"><b>公开域名</b><span id="resHost"></span><button class="ghost" data-copy="resHost" style="padding:3px 9px;font-size:11px">复制</button></div>
      <div class="kv"><b>隧道令牌</b><span id="resToken"></span><button class="ghost" data-copy="resToken" style="padding:3px 9px;font-size:11px">复制</button></div>
      <div class="warn">令牌只在这里显示一次。把它和域名一起私聊发给对方，让他填进「设置与网络 → 固定隧道」。</div>
    </div>
  </div>

  <div class="card">
    <h2>③ 已开通</h2>
    <ul class="tenants" id="tenants"></ul>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const $ = (id) => document.getElementById(id);
let state = {};

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3200);
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

function render() {
  $('sub').innerHTML = state.mock
    ? '⚠️ 体验模式（假 API）：随便点，不会真的建东西'
    : '给每个讲师开一条独立隧道，域名形如 <code>名字.' + state.zone + '</code>';

  if (state.hasToken) {
    $('tokenForm').style.display = 'none';
    $('tokenSaved').style.display = 'block';
    $('accountId').textContent = state.account || '—';
  } else {
    $('tokenForm').style.display = 'block';
    $('tokenSaved').style.display = 'none';
  }

  const list = $('tenants');
  list.innerHTML = '';
  if (!state.tenants || state.tenants.length === 0) {
    list.innerHTML = '<li class="empty">还没有开通任何讲师</li>';
    return;
  }
  for (const t of state.tenants) {
    const li = document.createElement('li');
    li.innerHTML = '<div><div>' + t.label + '</div><div class="hint" style="margin:0">' +
      t.hostname + '</div></div>';
    const btn = document.createElement('button');
    btn.className = 'danger';
    btn.textContent = '吊销';
    btn.onclick = async () => {
      if (!confirm('吊销「' + t.label + '」？\\n会删掉 ' + t.hostname + ' 的 DNS 记录和隧道，对方令牌立即失效。')) return;
      btn.disabled = true;
      try { await api('/api/revoke', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ label: t.label }) }); await refresh(); toast('已吊销'); }
      catch (e) { toast(e.message); btn.disabled = false; }
    };
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function refresh() {
  state = await api('/api/state');
  render();
}

function updatePreview() {
  const v = ($('host').value || '').trim().toLowerCase();
  $('preview').textContent = v ? v + '.' + state.zone : '—';
}

function randomId(len) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < (len || 6); i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

$('regen').onclick = () => { $('host').value = randomId(6); updatePreview(); };
$('host').oninput = updatePreview;

$('saveToken').onclick = async () => {
  const t = $('tokenInput').value.trim();
  if (!t) return toast('先粘贴令牌');
  $('saveToken').disabled = true;
  try {
    await api('/api/token', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ token: t }) });
    $('tokenInput').value = '';
    await refresh();
    toast('令牌有效，已保存');
  } catch (e) { toast(e.message); }
  finally { $('saveToken').disabled = false; }
};

$('clearToken').onclick = async () => {
  await api('/api/token', { method: 'DELETE' });
  await refresh();
  toast('已清除');
};

$('go').onclick = async () => {
  const label = $('label').value.trim();
  const host = $('host').value.trim();
  if (!label) return toast('标签不能为空');
  if (!host) return toast('域名标识不能为空');
  const btn = $('go');
  btn.disabled = true;
  btn.textContent = '开通中…';
  try {
    const r = await api('/api/provision', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ label, host, port: Number($('port').value) }) });
    $('resHost').textContent = r.hostname;
    $('resToken').textContent = r.token;
    $('result').classList.add('show');
    $('label').value = '';
    $('host').value = randomId(6);
    updatePreview();
    await refresh();
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = '开通'; }
};

document.querySelectorAll('[data-copy]').forEach((b) => {
  b.onclick = async () => {
    const text = $(b.dataset.copy).textContent;
    try { await navigator.clipboard.writeText(text); toast('已复制'); }
    catch { toast('复制失败，请手动选中'); }
  };
});

$('host').value = randomId(6);
api('/api/state').then((s) => { state = s; render(); updatePreview(); }).catch((e) => toast(e.message));
</script>
</body>
</html>`;

/* ------------------------------------------------------------------ 启动 */

(async () => {
  if (!process.env.CF_API_TOKEN && savedToken()) {
    process.env.CF_API_TOKEN = savedToken();
  }

  let mock = null;
  if (useMock) {
    const { startMock } = require('./mock');
    mock = startMock();
    const port = await mock.listen();
    process.env.CF_API_BASE = `http://127.0.0.1:${port}`;
    process.env.CF_API_TOKEN = 'fake-token';
    cfModule = undefined;
  }

  const start = (port) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve(port));
    });

  // 端口挑在 17000 段：Windows 的"保留端口"经常落在 7000–9000（Hyper-V/WSL 会动态占用），
  // 7788 这种常见端口反而容易绑定失败。
  server.setMaxListeners(0);
  let port = 17888;
  for (let i = 0; i < 20; i += 1) {
    try {
      await start(port);
      break;
    } catch {
      port += 1;
    }
  }

  const url = `http://127.0.0.1:${port}/`;
  console.log(`TENANT 界面已启动：${url}`);
  if (useMock) console.log('（体验模式：假 API）');
  console.log('关闭这个窗口即可停止。');
  if (!noOpen) exec(`start "" "${url}"`);

  process.on('SIGINT', async () => {
    if (mock) await mock.close();
    process.exit(0);
  });
})();