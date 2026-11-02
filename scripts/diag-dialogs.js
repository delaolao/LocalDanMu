'use strict';

/**
 * 验证"导入词表 / 导出"这类**会弹系统对话框**的命令不会把 app 弄死，
 * 同时验证图片消息能完整送到弹幕层（dm:item-full，图片正文在 payload 里）。
 *
 * 关键判据：对话框弹出期间 app 会被系统模态挡住（这是正常的），
 * 但我们关心的是**取消之后能不能恢复**——所以流程是：
 *   1. 记一次 getState 作为基准；
 *   2. 触发 importWords（不 await），等 1.5s 让对话框出来；
 *   3. 由外面 PowerShell 按 Esc 取消；
 *   4. 再 getState 一次，必须正常返回，且 importWords 的 promise 必须结束（返回 null）。
 *
 * 用法（需要 --remote-debugging-port=9222）：
 *   node scripts\diag-dialogs.js
 */

const PORT = process.env.LDM_CDP_PORT || 9222;
const WS_TIMEOUT = 8000;
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
  const control = targets.find((t) => (t.url || '').includes('control/index.html'));
  const danmaku = targets.find((t) => (t.url || '').includes('danmaku/index.html'));
  if (!control) throw new Error('control target not found');

  const ctl = new Cdp(control.webSocketDebuggerUrl);
  await ctl.ready;
  await ctl.send('Runtime.enable');

  const out = {};

  // ---------- A. 图片消息能否完整到达弹幕层 ----------
  if (danmaku) {
    const dk = new Cdp(danmaku.webSocketDebuggerUrl);
    await dk.ready;
    await dk.send('Runtime.enable');
    await dk.evalJs(`(() => {
      window.__imgItems = 0; window.__lastKind = '';
      window.__TAURI__.event.listen('dm:item-full', (e) => {
        window.__imgItems += 1;
        window.__lastKind = e.payload && e.payload.contentType;
        window.__lastHasPayload = !!(e.payload && e.payload.payload && e.payload.payload.indexOf('data:image') === 0);
      });
      return true; })()`);

    // 用一个 1x1 的 PNG 当图片弹幕，从"观众端"发进去
    const png1x1 =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const sessionFile = require('path').join(require('os').tmpdir(), 'localdanmu-debug', 'session.json');
    let session = null;
    try {
      session = JSON.parse(require('fs').readFileSync(sessionFile, 'utf8'));
    } catch (_) {
      /* LDM_PROBE 没开就没有这个文件 */
    }

    if (session) {
      const wsUrl = `ws://127.0.0.1:${session.port}/ws?t=${session.token}`;
      const vws = new WebSocket(wsUrl);
      await new Promise((res, rej) => {
        vws.addEventListener('open', () => res());
        vws.addEventListener('error', () => rej(new Error('viewer ws connect failed')));
        setTimeout(() => rej(new Error('viewer ws timeout')), WS_TIMEOUT);
      });
      vws.send(
        JSON.stringify({
          type: 'message',
          msgId: 'img-1',
          contentType: 'image',
          payload: png1x1,
          clientId: 'diag-device'
        })
      );
      await sleep(1200);
      try {
        vws.close();
      } catch (_) {
        /* ignore */
      }
    } else {
      out.imageTestSkipped = 'session.json 不存在（需要 LDM_PROBE=1 启动）';
    }

    const imgState = await dk.evalJs(
      `(() => ({ items: window.__imgItems, kind: window.__lastKind, hasPayload: !!window.__lastHasPayload }))()`
    );
    out.imageItemDelivery = imgState.value || imgState;
    dk.close();
  }

  // ---------- B. 导入词表：弹对话框 → 取消 → 必须恢复 ----------
  const base = await ctl.evalJs(`window.api.getState().then(() => 'ok')`, 8000);
  out.baselineResponsive = base.ok && base.value === 'ok';

  await ctl.evalJs(
    `(() => { window.__importDone = 'pending';
       window.api.importWords()
         .then((v) => { window.__importDone = v === null ? 'null' : JSON.stringify(v); })
         .catch((e) => { window.__importDone = 'error:' + String((e && (e.message || e)) || e); });
       return 'fired'; })()`,
    6000
  );
  await sleep(1500);

  // 等外面按 Esc（PowerShell 负责），这里多等一会
  await sleep(4000);

  const importState = await ctl.evalJs(`(() => ({ done: window.__importDone }))()`, 8000);
  out.importWordsPromise = importState.ok ? importState.value : importState;

  const after = await ctl.evalJs(`window.api.getState().then(() => 'ok')`, 8000);
  out.responsiveAfterDialog = after.ok && after.value === 'ok';

  const outFile = require('path').join(__dirname, 'out', 'diag-dialogs.json');
  require('fs').mkdirSync(require('path').join(__dirname, 'out'), { recursive: true });
  require('fs').writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
  console.log(JSON.stringify(out, null, 2));
  ctl.close();
})().catch((e) => {
  console.error('DIAG FAILED:', e && (e.stack || e.message || e));
  process.exit(1);
});
