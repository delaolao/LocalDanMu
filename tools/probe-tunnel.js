'use strict';
// 远程模式下测一次「握手 + 发消息」的往返时延，用来判断现场能不能用。
// 用法：node tools/probe-tunnel.js <https://xxx.trycloudflare.com> <token>

const base = (process.argv[2] || '').replace(/\/+$/, '');
const token = process.argv[3] || '';
if (!base || !token) {
  console.error('用法: node tools/probe-tunnel.js https://xxx.trycloudflare.com <token>');
  process.exit(1);
}

const wsUrl = base.replace(/^http/, 'ws') + '/ws?t=' + encodeURIComponent(token);

function now() {
  return Number(process.hrtime.bigint() / 1000n) / 1000; // ms
}

const t0 = now();
let tHello = 0;
const ws = new WebSocket(wsUrl);

ws.onopen = () => {
  console.log(`WS 已连接: ${(now() - t0).toFixed(0)} ms`);
};

ws.onerror = (e) => {
  console.error('WS 错误:', e.message || e.type);
  process.exit(1);
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.type === 'hello') {
    tHello = now();
    console.log(`收到 hello: ${(tHello - t0).toFixed(0)} ms（协议 ${msg.proto}）`);
    ws.send(
      JSON.stringify({
        type: 'message',
        msgId: 'tunnel-probe-' + Date.now(),
        contentType: 'text',
        payload: '远程模式时延测试',
        color: '#7ee787',
        clientId: 'tunnel-probe'
      })
    );
    return;
  }
  if (msg.type === 'ack') {
    console.log(`收到 ack: ${(now() - t0).toFixed(0)} ms（seq ${msg.seq}）`);
    console.log(`单程估算: ${((now() - tHello) / 2).toFixed(0)} ms`);
    ws.close();
    process.exit(0);
  }
};

setTimeout(() => {
  console.error('超时（15 秒）');
  process.exit(2);
}, 15000);
