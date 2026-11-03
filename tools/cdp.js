'use strict';
/**
 * 通过 WebView2 的 CDP 在 Tauri 页面里执行一段 JS。
 * 用法：node tools/cdp.js "<js>" [url 片段]
 * 前提：应用启动时带 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
 */
// Node 22+ 自带 WebSocket，不需要 ws 包
const expr = process.argv[2];
const match = process.argv[3] || 'control';

(async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json')).json();
  const page = list.find((t) => t.type === 'page' && (!match || t.url.includes(match))) || list[0];
  if (!page) throw new Error('没有可用的页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true, awaitPromise: true }
      })
    );
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id !== 1) return;
    if (msg.result && msg.result.exceptionDetails) {
      console.error('EXCEPTION:', JSON.stringify(msg.result.exceptionDetails));
    } else {
      console.log(JSON.stringify(msg.result.result.value, null, 2));
    }
    ws.close();
    process.exit(0);
  };
  setTimeout(() => {
    console.error('timeout');
    process.exit(2);
  }, 120000);
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
