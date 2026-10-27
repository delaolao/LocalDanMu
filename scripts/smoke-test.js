'use strict';

/**
 * 服务端冒烟测试（不需要 Electron）：
 * 校验房间口令、限流、内容校验、图片格式、健康检查、结束通知。
 *
 * 运行：node scripts/smoke-test.js
 */

const assert = require('assert');
const WebSocket = require('ws');
const path = require('path');
const { createBridge } = require('../src/main/server');
const { createFilter } = require('../src/main/filter');

const STATIC_DIR = path.join(__dirname, '..', 'src', 'web');
const TOKEN = 'testroom1';

let filterImpl = createFilter({ level: 'block' });

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error('use checkAsync');
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

function wrap(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (_) {
      return;
    }
    if (waiters.length) waiters.shift()(msg);
    else queue.push(msg);
  });
  return {
    next(timeout = 4000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待消息超时')), timeout);
        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    send(obj) {
      ws.send(JSON.stringify(obj));
    }
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const config = { intervalSec: 10, paused: false };
  const received = [];
  let stats = { online: 0 };

  const bridge = createBridge({
    staticDir: STATIC_DIR,
    token: TOKEN,
    getConfig: () => config,
    onMessage: (m) => received.push(m),
    filter: (text) => filterImpl.check(text),
    onStats: (s) => {
      stats = s;
    },
    onLog: () => {}
  });

  const port = await bridge.listen(0);
  const base = `http://127.0.0.1:${port}`;
  console.log(`\n服务已启动 ${base}，房间口令 ${TOKEN}\n`);

  console.log('HTTP');

  await checkAsync('GET /healthz 返回 ok', async () => {
    const res = await fetch(`${base}/healthz`);
    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.strictEqual(json.ok, true);
  });

  await checkAsync('GET /j/<正确口令> 返回观众页', async () => {
    const res = await fetch(`${base}/j/${TOKEN}`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('/assets/app.js'), '页面应引用 app.js');
  });

  await checkAsync('GET /j/<错误口令> 返回 403', async () => {
    const res = await fetch(`${base}/j/wrongtoken`);
    assert.strictEqual(res.status, 403);
  });

  await checkAsync('GET / 返回引导页', async () => {
    const res = await fetch(`${base}/`);
    assert.strictEqual(res.status, 200);
    assert.ok((await res.text()).includes('二维码'));
  });

  await checkAsync('静态资源可访问', async () => {
    const res = await fetch(`${base}/assets/app.js`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('cache-control'), 'no-store, no-cache, must-revalidate');
  });

  await checkAsync('目录穿越被拦截', async () => {
    const res = await fetch(`${base}/assets/..%2F..%2Fpackage.json`);
    assert.strictEqual(res.status, 404);
  });

  console.log('\nWebSocket');

  await checkAsync('错误口令无法建立连接', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=nope`);
    const status = await new Promise((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.on('open', () => resolve('open'));
      ws.on('error', () => resolve('error'));
    });
    assert.notStrictEqual(status, 'open');
    ws.terminate();
  });

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${TOKEN}`);
  const client = wrap(ws);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  await checkAsync('连接后收到 hello（含限流间隔）', async () => {
    const hello = await client.next();
    assert.strictEqual(hello.type, 'hello');
    assert.strictEqual(hello.intervalSec, 10);
  });

  await checkAsync('在线人数统计为 1', async () => {
    await sleep(120);
    assert.strictEqual(stats.online, 1);
  });

  await checkAsync('空文本被拒绝', async () => {
    client.send({ type: 'message', msgId: 'a1', contentType: 'text', payload: '   ' });
    const ack = await client.next();
    assert.strictEqual(ack.status, 'invalid');
    assert.strictEqual(ack.reason, 'empty');
  });

  await checkAsync('超过 100 字被拒绝', async () => {
    client.send({ type: 'message', msgId: 'a2', contentType: 'text', payload: '弹'.repeat(101) });
    const ack = await client.next();
    assert.strictEqual(ack.status, 'invalid');
    assert.strictEqual(ack.reason, 'too_long');
  });

  await checkAsync('emoji 按 1 个字符计（100 个 emoji 允许）', async () => {
    config.intervalSec = 0.001;
    client.send({ type: 'message', msgId: 'a3', contentType: 'text', payload: '😀'.repeat(100) });
    const ack = await client.next();
    assert.strictEqual(ack.status, 'ok', JSON.stringify(ack));
    config.intervalSec = 10;
  });

  await checkAsync('data:text/html 伪装图片被拒绝', async () => {
    client.send({
      type: 'message',
      msgId: 'a4',
      contentType: 'image',
      payload: 'data:text/html;base64,PHNjcmlwdD4='
    });
    const ack = await client.next();
    assert.strictEqual(ack.reason, 'bad_image');
  });

  await checkAsync('超长文本按字符数校验后拒绝', async () => {
    client.send({ type: 'message', msgId: 'a5', contentType: 'text', payload: 'x'.repeat(500) });
    const ack = await client.next();
    assert.strictEqual(ack.status, 'invalid');
  });

  await checkAsync('正常文本发送成功并收到 seq', async () => {
    await sleep(1100); // 上一条（emoji 测试）之后要等冷却
    config.intervalSec = 1;
    client.send({ type: 'message', msgId: 'b1', contentType: 'text', payload: '大家好' });
    const ack = await client.next();
    assert.strictEqual(ack.status, 'ok', JSON.stringify(ack));
    assert.ok(ack.seq >= 1);
    assert.ok(ack.retryAfter >= 1000);
  });

  await checkAsync('消息被转发到主进程钩子', async () => {
    await sleep(50);
    assert.ok(received.length >= 1);
    assert.strictEqual(received[received.length - 1].payload, '大家好');
  });

  await checkAsync('连发第二条被限流', async () => {
    client.send({ type: 'message', msgId: 'b2', contentType: 'text', payload: '再来一条' });
    const ack = await client.next();
    assert.strictEqual(ack.status, 'rate_limited');
    assert.ok(ack.retryAfter > 0 && ack.retryAfter <= 1000, `retryAfter=${ack.retryAfter}`);
  });

  await checkAsync('冷却后可以继续发', async () => {
    await sleep(1100);
    client.send({ type: 'message', msgId: 'b3', contentType: 'text', payload: '第三条' });
    const ack = await client.next();
    assert.strictEqual(ack.status, 'ok');
  });

  await checkAsync('相同 msgId 重发不会重复上屏', async () => {
    await sleep(1100);
    const before = received.length;
    client.send({ type: 'message', msgId: 'b3', contentType: 'text', payload: '第三条' });
    const ack = await client.next();
    assert.strictEqual(ack.status, 'ok');
    assert.strictEqual(ack.duplicate, true);
    assert.strictEqual(received.length, before);
  });

  await checkAsync('图片消息可以正常通过', async () => {
    await sleep(1100);
    client.send({
      type: 'message',
      msgId: 'c1',
      contentType: 'image',
      payload: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
    });
    const ack = await client.next();
    assert.strictEqual(ack.status, 'ok');
  });

  await checkAsync('手机号被过滤拦截（不占发送额度）', async () => {
    client.send({ type: 'message', msgId: 'f1', contentType: 'text', payload: '有事打我电话 13800138000' });
    const ack = await client.next();
    assert.strictEqual(ack.status, 'invalid');
    assert.strictEqual(ack.reason, 'filtered');
  });

  await checkAsync('mark 模式放行但打上标记', async () => {
    filterImpl = createFilter({ level: 'mark' });
    await sleep(1100);
    client.send({ type: 'message', msgId: 'f2', contentType: 'text', payload: '你这人真傻逼' });
    const ack = await client.next();
    assert.strictEqual(ack.status, 'ok');
    assert.strictEqual(received[received.length - 1].flagged, true);
    filterImpl = createFilter({ level: 'block' });
  });

  await checkAsync('颜色白名单外的值会被清空', async () => {
    await sleep(1100);
    client.send({ type: 'message', msgId: 'g1', contentType: 'text', payload: '颜色测试', color: '#123456' });
    const ack = await client.next();
    assert.strictEqual(ack.status, 'ok');
    assert.strictEqual(received[received.length - 1].color, null);
  });

  await checkAsync('白名单颜色原样保留（大小写归一）', async () => {
    await sleep(1100);
    client.send({ type: 'message', msgId: 'g2', contentType: 'text', payload: '颜色测试2', color: '#FFE066' });
    const ack = await client.next();
    assert.strictEqual(ack.status, 'ok');
    assert.strictEqual(received[received.length - 1].color, '#ffe066');
  });

  await checkAsync('超大 payload 被 ws 层拒绝（连接断开）', async () => {
    const big = `data:image/png;base64,${'A'.repeat(3 * 1024 * 1024)}`;
    const closed = new Promise((resolve) => {
      const probe = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${TOKEN}`);
      probe.on('open', () => probe.send(JSON.stringify({ type: 'message', contentType: 'image', payload: big })));
      probe.on('close', () => resolve(true));
      probe.on('error', () => resolve(true));
    });
    assert.strictEqual(await closed, true);
  });

  console.log('\n结束流程');

  await checkAsync('shutdown 会通知客户端 session_end', async () => {
    const probe = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${TOKEN}`);
    const probeClient = wrap(probe);
    await new Promise((resolve) => probe.once('open', resolve));
    await probeClient.next(); // hello
    const event = probeClient.next();
    await bridge.shutdown('ended');
    const msg = await event;
    assert.strictEqual(msg.type, 'session_end');
    probe.terminate();
  });

  ws.terminate();

  console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试异常:', err);
  process.exit(1);
});
