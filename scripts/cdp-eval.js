'use strict';
// 通过 CDP 在弹幕层里执行一段 JS（调试用）
const WebSocket = require('ws');

const expr = process.argv[2];
if (!expr) {
  console.error('usage: node scripts/cdp-eval.js "<js>"');
  process.exit(1);
}

(async () => {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = targets.find((t) => t.url.includes('danmaku/index.html'));
  if (!page) throw new Error('没有找到弹幕层页面');

  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  ws.on('open', () => {
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true, awaitPromise: true }
      })
    );
  });
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id !== 1) return;
    if (msg.result && msg.result.exceptionDetails) {
      console.log('EXCEPTION:', JSON.stringify(msg.result.exceptionDetails.text));
      console.log(JSON.stringify(msg.result.result, null, 2));
    } else {
      console.log(JSON.stringify(msg.result.result.value, null, 2));
    }
    ws.close();
    process.exit(0);
  });
  setTimeout(() => {
    console.error('timeout');
    process.exit(2);
  }, 8000);
})();
