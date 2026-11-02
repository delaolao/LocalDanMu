'use strict';
/**
 * 点赞链路的小探针：A 发一条，B、C 各点一个赞，打印最终计数。
 * 用法：node scripts/probe-like.js <token> [文本]
 */
const WebSocket = require('ws');

const TOKEN = process.argv[2] || 'liketest';
const TEXT = process.argv[3] || '这条看看能收到几个赞';
const PORT = Number(process.argv[4] || process.env.LDM_PORT || 8080);
const URL = `ws://127.0.0.1:${PORT}/ws?t=${TOKEN}`;

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function waitAck(ws) {
  return new Promise((resolve) => {
    const onMessage = (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'ack' || m.type === 'like' || m.type === 'like-reject') {
        ws.off('message', onMessage);
        resolve(m);
      }
    };
    ws.on('message', onMessage);
  });
}

(async () => {
  const author = await connect();
  const wait = waitAck(author);
  author.send(
    JSON.stringify({
      type: 'message',
      msgId: 'probe-' + Date.now(),
      contentType: 'text',
      payload: TEXT,
      color: '#7ee787',
      clientId: 'author-1'
    })
  );
  const ack = await wait;
  console.log('发送:', JSON.stringify(ack));
  const seq = ack.seq;

  for (const cid of ['liker-1', 'liker-2']) {
    const ws = await connect();
    const p = waitAck(ws);
    ws.send(JSON.stringify({ type: 'like', seq, clientId: cid }));
    const res = await p;
    console.log(cid, '->', JSON.stringify(res));
    ws.close();
  }

  author.close();
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
