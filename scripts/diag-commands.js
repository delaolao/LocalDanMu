'use strict';

/**
 * 逐个实测"手动测试说没反应"的那些按钮，把每个 IPC 命令的**原始报错**打出来。
 *
 * 用法（需要先带 --remote-debugging-port=9222 启动程序）：
 *   node scripts\diag-commands.js
 */

const PORT = process.env.LDM_CDP_PORT || 9222;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      if (Array.isArray(list) && list.length) return list;
    } catch (_) {
      /* not up yet */
    }
    await sleep(400);
  }
  throw new Error('CDP endpoint not available');
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
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
      } else if (m.method === 'Log.entryAdded') {
        this.logs.push(m.params.entry.text);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.logs.push('EXC ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error('timeout ' + method));
        }
      }, 20000);
    });
  }
  async evalJs(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (r.exceptionDetails) {
      return {
        ok: false,
        error:
          (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text
      };
    }
    return { ok: true, value: r.result && r.result.value };
  }
}

(async () => {
  const list = await targets();
  const page = list.find((t) => (t.url || '').includes('control/index.html'));
  if (!page) throw new Error('control window target not found');

  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  // 这些是手动测试报告"点了没反应"的按钮，逐一真实调用，看 IPC 到底返回什么。
  // 放在最后面的才是会阻塞/退出的（弹窗、quit），避免它把前面的测试打断。
  const cases = [
    ['copyLink   (复制链接)', 'window.api.copyLink()'],
    ['toggleJoin (投屏引导页)', 'window.api.toggleJoin()'],
    ['toggleJoin (再关一次)', 'window.api.toggleJoin()'],
    ['toggleOverlay', 'window.api.toggleOverlay()'],
    ['toggleOverlay (恢复)', 'window.api.toggleOverlay()'],
    ['setDisplay', 'window.api.setDisplay("__nope__")'],
    ['refreshNetwork', 'window.api.refreshNetwork()'],
    ['replay(1)', 'window.api.replay(1)'],
    ['setConfig(theme)', 'window.api.setConfig({ theme: "dark" })'],
    ['setConfig(theme back)', 'window.api.setConfig({ theme: "system" })']
  ];

  console.log('=== 逐个 IPC 实测 ===');
  for (const [label, expr] of cases) {
    const r = await cdp.evalJs(
      `(async () => { try { const v = await ${expr}; return { ok: true, value: typeof v === "object" ? JSON.stringify(v).slice(0,120) : String(v) }; } catch (e) { return { ok: false, error: String((e && (e.message || e)) || e) }; } })()`
    );
    const detail = r.ok ? JSON.stringify(r.value) : JSON.stringify(r);
    console.log(`  ${label}: ${detail}`);
    await sleep(400);
  }

  // 剪贴板实际内容（如果 copyLink 成功，这里应当能读回 URL）
  const clip = await cdp.evalJs(
    `(async () => { try { const { invoke } = window.__TAURI__.core; const t = await invoke('plugin:clipboard-manager|read_text'); return String(t); } catch (e) { return 'READ_FAILED: ' + String((e && (e.message||e))||e); } })()`
  );
  console.log('\n=== 剪贴板读回（验证复制是否真的写进去了） ===');
  console.log('  ' + (clip.ok ? JSON.stringify(clip.value) : JSON.stringify(clip)));

  console.log('\n=== 页面日志（本次连接期间） ===');
  if (!cdp.logs.length) console.log('  （无）');
  for (const l of cdp.logs.slice(0, 20)) console.log('  ' + l);

  console.log('\n=== 现在测试 quit（程序会退出，这是最后一步） ===');
  const q = await cdp.evalJs(
    `(async () => { try { await window.api.quit(); return 'quit resolved'; } catch (e) { return 'quit error: ' + String((e && (e.message||e))||e); } })()`
  );
  console.log('  ' + JSON.stringify(q));
  await sleep(2500);
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const after = await res.json();
    console.log(`  退出后仍需存在的 target 数: ${Array.isArray(after) ? after.length : '?'}（0 = 已退出）`);
  } catch (_) {
    console.log('  退出后 CDP 端点已消失（程序确实退出了）');
  }
  try {
    cdp.ws.close();
  } catch (_) {
    /* ignore */
  }
})().catch((e) => {
  console.error('DIAG FAILED:', e && (e.stack || e.message || e));
  process.exit(1);
});
