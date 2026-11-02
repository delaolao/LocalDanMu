'use strict';

/**
 * 修复后的回归验证：把"手动测试报的六个问题"逐条用真 IPC 验一遍。
 *
 *   1. 投屏引导页（toggleJoin）不再卡死主线程
 *   2. 复制链接真的有内容进剪贴板（写完立刻读回）
 *   3. 弹幕层能收到 dm:cursor（图片悬停/点击放大的前提）
 *   4. 退出能真的退出
 *
 * 用法（鼠标移动由外面用 PowerShell 的 Start-Job 负责，这里只数事件）：
 *   node scripts\diag-verify.js
 */

const PORT = process.env.LDM_CDP_PORT || 9222;
const CURSOR_WINDOW_MS = Number(process.env.LDM_CURSOR_MS || 3000);
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
      return {
        ok: false,
        error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text
      };
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

const results = {};

(async () => {
  let targets = await listTargets();
  const control = targets.find((t) => (t.url || '').includes('control/index.html'));
  const danmaku = targets.find((t) => (t.url || '').includes('danmaku/index.html'));
  if (!control) throw new Error('control target not found');

  const ctl = new Cdp(control.webSocketDebuggerUrl);
  await ctl.ready;
  await ctl.send('Runtime.enable');
  await ctl.send('Log.enable');

  // ---------- 1. 复制链接 + 立刻读回剪贴板 ----------
  const copyRes = await ctl.evalJs(`window.api.copyLink()`);
  await sleep(300);
  results.copyLinkReturned = copyRes;
  // 剪贴板内容由 PowerShell 侧 Get-Clipboard 读（JS 侧读要 ACL 授权，而我们的 app
  // 本来就是从 Rust 侧写剪贴板，不需要开这个权限）。

  // ---------- 2. toggleJoin 不再卡死 ----------
  const before = (await listTargets()).length;
  let joinRes;
  try {
    joinRes = await ctl.evalJs(`window.api.toggleJoin()`, 12000);
    results.toggleJoin = { returned: true, value: joinRes };
  } catch (e) {
    results.toggleJoin = { returned: false, error: String(e.message || e) };
  }
  await sleep(1500);
  targets = await listTargets();
  const joinTarget = targets.find((t) => (t.url || '').includes('join/index.html'));
  results.joinWindowCreated = Boolean(joinTarget);
  results.targetCountBefore = before;
  results.targetCountAfter = targets.length;

  // 关掉引导页，恢复原状
  await ctl.evalJs(`window.api.toggleJoin()`, 12000);
  await sleep(800);

  // ---------- 3. 弹幕层是否收到 dm:cursor ----------
  const dk = new Cdp(danmaku.webSocketDebuggerUrl);
  await dk.ready;
  await dk.send('Runtime.enable');
  await dk.evalJs(`(() => {
    window.__diagCursor = 0; window.__diagItemFull = 0;
    window.__TAURI__.event.listen('dm:cursor', () => { window.__diagCursor += 1; });
    window.__TAURI__.event.listen('dm:item-full', () => { window.__diagItemFull += 1; });
    return true; })()`);
  await sleep(CURSOR_WINDOW_MS);
  const cursorCounts = await dk.evalJs(`(() => ({ cursor: window.__diagCursor, itemFull: window.__diagItemFull }))()`);
  results.danmakuEvents = cursorCounts.ok ? cursorCounts.value : cursorCounts;
  results.cursorEventsFlow = Boolean(results.danmakuEvents && results.danmakuEvents.cursor > 0);
  dk.close();

  // ---------- 4. 退出 ----------
  const fs = require('fs');
  const path = require('path');
  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'diag-verify.json');

  let quitRes;
  try {
    quitRes = await ctl.evalJs(`window.api.quit()`, 12000);
  } catch (e) {
    quitRes = { ok: false, error: String(e.message || e) };
  }
  await sleep(3000);
  let stillAlive = true;
  try {
    const after = await listTargets(3000);
    stillAlive = Array.isArray(after) && after.length > 0;
  } catch (_) {
    stillAlive = false;
  }
  results.quitInvoke = quitRes;
  results.stillAliveAfterQuit = stillAlive;
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf8');
  console.log('=== 结果已写入 ' + outFile + ' ===');
  console.log(JSON.stringify({
    copyLinkReturned: results.copyLinkReturned,
    toggleJoinReturned: results.toggleJoin && results.toggleJoin.returned,
    joinWindowCreated: results.joinWindowCreated,
    danmakuEvents: results.danmakuEvents,
    cursorEventsFlow: results.cursorEventsFlow,
    quitInvoke: results.quitInvoke,
    stillAliveAfterQuit: results.stillAliveAfterQuit
  }, null, 2));
  try {
    ctl.close();
  } catch (_) {
    /* ignore */
  }
})().catch((e) => {
  console.error('VERIFY FAILED:', e && (e.stack || e.message || e));
  process.exit(1);
});
