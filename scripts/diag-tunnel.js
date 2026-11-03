'use strict';

/**
 * 远程模式下载链路诊断：开启隧道并持续打印 tunnel:state 的每一次变化。
 *
 * 重点看两件事：
 *   1. 下载期间 message 是否在动（进度、来源、速度）——以前只有一条静态文案；
 *   2. 失败时 message 是否说清了"哪个源、什么原因、下一步怎么办"。
 *
 * 用法（程序需带 --remote-debugging-port 启动）：
 *   node scripts\diag-tunnel.js [超时秒数]
 */

const PORT = process.env.LDM_CDP_PORT || 9222;
const TIMEOUT_S = Number(process.argv[2] || 180);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      if (Array.isArray(list) && list.length) return list;
    } catch (_) {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error('CDP endpoint not available');
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(new Error('ws: ' + (e.message || 'error'))));
    });
    this.ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    });
  }
  send(method, params, timeoutMs = 15000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error('TIMEOUT ' + method));
        }
      }, timeoutMs);
    });
  }
  async evalJs(expression, timeoutMs = 15000) {
    const r = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      timeoutMs
    );
    if (r.exceptionDetails) {
      return { ok: false, error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    }
    return { ok: true, value: r.result && r.result.value };
  }
}

(async () => {
  const targets = await listTargets();
  const control = targets.find((t) => (t.url || '').includes('control/index.html'));
  if (!control) throw new Error('control target not found');

  const cdp = new Cdp(control.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  console.log('=== 触发 tunnelStart() ===');
  const started = await cdp.evalJs(`window.api.tunnelStart().then(s => JSON.stringify(s))`);
  console.log('  返回: ' + (started.ok ? started.value : JSON.stringify(started)));

  const deadline = Date.now() + TIMEOUT_S * 1000;
  let last = '';
  let lastMessage = '';
  let changed = 0;
  let finalState = null;

  while (Date.now() < deadline) {
    const r = await cdp.evalJs(`window.api.tunnelState().then(s => JSON.stringify(s))`);
    if (r.ok && r.value) {
      const st = JSON.parse(r.value);
      finalState = st;
      const line = `[${st.status}] ${st.message || ''}`;
      if (st.message !== lastMessage) {
        changed += 1;
        lastMessage = st.message || '';
        console.log(`  ${line}`);
      }
      last = st.status;
      if (st.status === 'running' || st.status === 'error') {
        if (st.status === 'running') {
          console.log(`  URL: ${st.url}`);
        }
        break;
      }
    }
    await sleep(700);
  }

  console.log('');
  console.log('=== 结论 ===');
  console.log(`  最终状态      : ${last}`);
  console.log(`  message 变化次数: ${changed}  (>1 说明进度/来源确实在更新)`);
  if (finalState && finalState.status === 'running') {
    console.log(`  隧道地址      : ${finalState.url}`);
  }

  // 收尾：关掉隧道，别把 cloudflared 留在后台
  await cdp.evalJs(`window.api.tunnelStop().then(s => JSON.stringify(s))`).catch(() => {});
  await sleep(1200);
  try {
    cdp.ws.close();
  } catch (_) {
    /* ignore */
  }
})().catch((e) => {
  console.error('DIAG FAILED:', e && (e.stack || e.message || e));
  process.exit(1);
});
