'use strict';
// 局域网明文链路回归：确认 E2E 改动没有影响普通连接。
// 用法：node tools/probe-lan.js <http://192.168.x.x:8080> <token>
const base = (process.argv[2] || '').replace(/\/+$/, '');
const token = process.argv[3] || '';
if (!base || !token) {
  console.error('用法: node tools/probe-lan.js http://192.168.3.6:8080 <token>');
  process.exit(1);
}
const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws?t=' + encodeURIComponent(token));

ws.onopen = () => {
  ws.send(
    JSON.stringify({
      type: 'message',
      msgId: 'lan-' + Date.now(),
      contentType: 'text',
      payload: '局域网明文回归',
      color: '#7ee787',
      clientId: 'lan-probe'
    })
  );
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === 'hello') {
    if (msg.type === 'enc') {
      console.error('❌ 局域网连接不该收到密文');
      process.exit(1);
    }
    console.log('hello 是明文 ✅');
  }
  if (msg.type === 'ack') {
    console.log(msg.status === 'ok' ? '明文消息被接受 ✅' : '❌ 被拒绝: ' + msg.reason);
    ws.close();
    process.exit(msg.status === 'ok' ? 0 : 1);
  }
};

ws.onerror = (e) => {
  console.error('WS 错误:', e.message || e.type);
  process.exit(1);
};
setTimeout(() => {
  console.error('超时');
  process.exit(2);
}, 12000);
