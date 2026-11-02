'use strict';

/**
 * 验证这次三个修复里能量化的两个：
 *
 *   A. dm:cursor 的坐标单位：必须是**窗口内 CSS 像素**。
 *      本机 150% 缩放，所以物理 (600,450) 应当报成 CSS (400,300)。
 *      旧代码直接推物理像素，页面按 CSS 像素做命中测试 → 整体偏 1.5 倍，
 *      表现就是"鼠标滑过图片毫无反应"。
 *
 *   B. 置顶守护不该在你正操作控制面板时去 SetWindowPos。
 *      Rust 侧在真的调用 force_top(control) 时会往 probe.log 写一行；
 *      控制面板是前台窗口时计数应当为 0，换别的前台窗口后应当 > 0。
 *
 * 光标位置由外面 PowerShell 设置（这里只能读事件）。
 *
 * 用法：node scripts\diag-cursor.js
 */

const PORT = process.env.LDM_CDP_PORT || 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = require('fs');
const path = require('path');
const os = require('os');

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
  send(method, params, timeoutMs = 10000) {
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
  async evalJs(expression, timeoutMs = 10000) {
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
  close() {
    try {
      this.ws.close();
    } catch (_) {
      /* ignore */
    }
  }
}

(async () => {
  const targets = await listTargets();
  const danmaku = targets.find((t) => (t.url || '').includes('danmaku/index.html'));
  if (!danmaku) throw new Error('danmaku target not found');

  const dk = new Cdp(danmaku.webSocketDebuggerUrl);
  await dk.ready;
  await dk.send('Runtime.enable');

  // ---------- A. 光标坐标单位 ----------
  await dk.evalJs(`(() => {
    window.__cursors = [];
    window.__TAURI__.event.listen('dm:cursor', (e) => {
      if (window.__cursors.length < 60) window.__cursors.push([e.payload.x, e.payload.y]);
    });
    return true; })()`);

  const env = await dk.evalJs(
    `(() => ({ dpr: window.devicePixelRatio, innerW: window.innerWidth, innerH: window.innerHeight }))()`
  );

  // 等外面把光标挪到已知位置
  await sleep(Number(process.env.LDM_WAIT_MS || 4000));

  const cursors = await dk.evalJs(`(() => window.__cursors)()`);
  const list = (cursors.value || []).slice();
  const last = list.length ? list[list.length - 1] : null;

  const out = {
    viewport: env.value,
    cursorSamples: list.length,
    lastCursor: last,
    targetPhysical: process.env.LDM_TARGET_PHYSICAL || '(not set)',
    expectedCss: process.env.LDM_EXPECTED_CSS || '(not set)'
  };
  dk.close();

  // ---------- B. 置顶守护是否还去戳前台窗口 ----------
  const probeLog = path.join(os.tmpdir(), 'localdanmu-debug', 'probe.log');
  let guardCount = 0;
  try {
    const text = fs.readFileSync(probeLog, 'utf8');
    guardCount = (text.match(/guard: force_top\(control\)/g) || []).length;
  } catch (_) {
    /* no log */
  }
  out.guardForceTopCount = guardCount;

  const outFile = path.join(__dirname, 'out', 'diag-cursor.json');
  fs.mkdirSync(path.join(__dirname, 'out'), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
})().catch((e) => {
  console.error('DIAG FAILED:', e && (e.stack || e.message || e));
  process.exit(1);
});
