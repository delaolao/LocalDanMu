'use strict';
// 往正在运行的实例发一张测试图（参数：token、图片路径）
const fs = require('fs');
const WebSocket = require('ws');

const token = process.argv[2];
const file = process.argv[3] || 'scripts/out/magenta.png';
if (!token) {
  console.error('usage: node scripts/send-test-image.js <token> [file]');
  process.exit(1);
}
const b64 = fs.readFileSync(file).toString('base64');
const ws = new WebSocket(`ws://127.0.0.1:8080/ws?t=${token}`);
const timer = setTimeout(() => {
  console.error('timeout');
  process.exit(2);
}, 6000);

ws.on('open', () => {
  ws.send(
    JSON.stringify({
      type: 'message',
      msgId: `probe-${Date.now()}`,
      contentType: 'image',
      payload: `data:image/png;base64,${b64}`,
      clientId: 'probe-client'
    })
  );
});

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.type !== 'ack') return;
  clearTimeout(timer);
  console.log(JSON.stringify(msg));
  ws.close();
  process.exit(msg.status === 'ok' ? 0 : 1);
});

ws.on('error', (e) => {
  console.error('ws error:', e.message);
  process.exit(3);
});
