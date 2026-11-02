'use strict';

/**
 * 用 CDP 连上运行中的 WebView2，直接把渲染层的真实状态问出来。
 *
 * 起因：手动测试报告"控制面板按钮点击无反应、下拉列表自动收起、无法退出"，
 * 一次性六个症状，靠猜没用。这个脚本做的是：
 *   1. 列出所有可调试的窗口（Tauri 每个 WebViewWindow 一个 target）；
 *   2. 连上控制面板，收集 console 报错与未捕获异常；
 *   3. 在页面里真跑一遍 `window.api.*`，把每个方法的成功/异常打出来；
 *   4. 统计 N 秒内收到多少个 `state` 事件（怀疑是状态推送风暴把下拉框冲掉）。
 *
 * 用法：
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222'
 *   .\src-tauri\target\release\localdanmu.exe
 *   node scripts\diag-cdp.js
 */

const PORT = process.env.LDM_CDP_PORT || 9222;
const LISTEN_MS = Number(process.env.LDM_DIAG_MS || 2500);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchTargets(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      if (Array.isArray(list) && list.length) return list;
    } catch (_) {
      /* 还没起来 */
    }
    await sleep(400);
  }
  throw new Error(`CDP 端点没起来（端口 ${PORT}）。确认程序启动时带了 --remote-debugging-port`);
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || 'unknown'))));
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 15000);
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      return {
        ok: false,
        error:
          (result.exceptionDetails.exception && result.exceptionDetails.exception.description) ||
          result.exceptionDetails.text
      };
    }
    return { ok: true, value: result.result && result.result.value };
  }

  close() {
    try {
      this.ws.close();
    } catch (_) {
      /* ignore */
    }
  }
}

(async () => {
  const targets = await fetchTargets();
  console.log('=== CDP targets ===');
  for (const t of targets) {
    console.log(`  [${t.type}] ${t.title || '(no title)'}  ${t.url}`);
  }

  const page =
    targets.find((t) => (t.url || '').includes('control/index.html')) ||
    targets.find((t) => t.type === 'page' && (t.title || '').includes('培训弹幕')) ||
    targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没找到控制面板 target');

  console.log(`\n=== 连接到: ${page.title} ===`);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  // ---- 1. 基础环境 ----
  const base = await cdp.evaluate(`(() => ({
    hasTauri: typeof window.__TAURI__,
    hasApi: typeof window.api,
    hasDm: typeof window.dm,
    apiKeys: window.api ? Object.keys(window.api) : [],
    url: location.href,
    readyState: document.readyState
  }))()`);
  console.log('\n=== 渲染层环境 ===');
  console.log(JSON.stringify(base, null, 2));

  // ---- 2. 逐个 API 实测（只测只读/幂等的） ----
  const calls = [
    ['getState', 'window.api.getState()'],
    ['getHistory', 'window.api.getHistory()']
  ];
  console.log('\n=== IPC 实测 ===');
  for (const [name, expr] of calls) {
    const r = await cdp.evaluate(
      `(async () => { try { const v = await ${expr}; return { ok: true, sample: JSON.stringify(v).slice(0, 160) }; } catch (e) { return { ok: false, error: String(e && (e.message || e)) }; } })()`
    );
    console.log(`  ${name}: ${JSON.stringify(r.ok ? r.value : r)}`);
  }

  // ---- 3. state 事件风暴检测 ----
  await cdp.evaluate(`(() => {
    window.__diagStateCount = 0;
    window.__diagItems = 0;
    window.__TAURI__.event.listen('state', () => { window.__diagStateCount += 1; });
    window.__TAURI__.event.listen('dm:item', () => { window.__diagItems += 1; });
    window.__TAURI__.event.listen('dm:item-full', () => { window.__diagItems += 1; });
    return true;
  })()`);
  await sleep(LISTEN_MS);
  const counts = await cdp.evaluate(
    `(() => ({ stateEvents: window.__diagStateCount, itemEvents: window.__diagItems }))()`
  );
  console.log(`\n=== ${LISTEN_MS}ms 内事件数 ===`);
  console.log('  ' + JSON.stringify(counts.value || counts));

  // ---- 4. console 报错 / 异常 ----
  const errors = [];
  for (const ev of cdp.events) {
    if (ev.method === 'Runtime.exceptionThrown') {
      const d = ev.params.exceptionDetails;
      errors.push('EXCEPTION: ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
    } else if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
      errors.push('console.error: ' + ev.params.args.map((a) => a.value || a.description || a.type).join(' '));
    } else if (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error') {
      errors.push('log: ' + ev.params.entry.text);
    }
  }
  console.log('\n=== 渲染层报错（本次连接期间） ===');
  if (!errors.length) console.log('  （无）');
  for (const e of errors.slice(0, 20)) console.log('  ' + e);

  cdp.close();
})().catch((err) => {
  console.error('DIAG FAILED:', err && (err.stack || err.message || err));
  process.exit(1);
});
