'use strict';
/**
 * 验证远程模式的端到端加密。
 *
 * 用法：node tools/probe-e2e.js <隧道地址> <房间号> <#k 里的 base64url 密钥>
 * 例：  node tools/probe-e2e.js https://xxx.trycloudflare.com abcde123 <key>
 *
 * 断言：
 *  1. 带 &enc=1 连接后，收到的 hello 是密文信封，解开后 type=hello
 *  2. 发出的消息要加密才能被接受（明文会被拒绝，reason=bad_enc）
 *  3. 加密发送后能拿到 ack
 */
const { webcrypto } = require('node:crypto');
const { subtle } = webcrypto;

const base = (process.argv[2] || '').replace(/\/+$/, '');
const token = process.argv[3] || '';
const frag = process.argv[4] || '';

if (!base || !token || !frag) {
  console.error('用法: node tools/probe-e2e.js <https://xxx.trycloudflare.com> <房间号> <密钥>');
  process.exit(1);
}

const b64 = (buf) => Buffer.from(new Uint8Array(buf)).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

const raw = unb64(frag.replace(/-/g, '+').replace(/_/g, '/'));
if (raw.length !== 32) {
  console.error('密钥长度不对:', raw.length);
  process.exit(1);
}

const wsUrl = base.replace(/^http/, 'ws') + '/ws?t=' + encodeURIComponent(token) + '&enc=1';

(async () => {
  const key = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

  async function seal(obj) {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify(obj));
    const sealed = await subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return JSON.stringify({ type: 'enc', iv: b64(iv), data: b64(sealed) });
  }

  async function open(env) {
    const plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(env.iv) },
      key,
      unb64(env.data)
    );
    return JSON.parse(new TextDecoder().decode(plain));
  }

  const ws = new WebSocket(wsUrl);
  let sawEncryptedHello = false;
  let sawBadEncReject = false;

  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时（20 秒）')), 20000);

    ws.onopen = () => {
      console.log('WS 已连接（enc=1）');
      // 先故意发一条明文，服务端必须拒绝
      ws.send(JSON.stringify({ type: 'message', msgId: 'plain-1', contentType: 'text', payload: '明文应当被拒' }));
    };

    ws.onmessage = async (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.type === 'enc') {
        const inner = await open(msg).catch((e) => {
          console.error('解密失败:', e.message);
          return null;
        });
        if (!inner) return;
        if (inner.type === 'hello') {
          sawEncryptedHello = true;
          console.log('hello 是密文，解开后 type=hello ✅');
          console.log('  （信封里没有明文：', !ev.data.includes('"type":"hello"') ? '确认 ✅' : '失败 ❌', '）');
          // 加密发一条消息
          ws.send(
            await seal({
              type: 'message',
              msgId: 'enc-1',
              contentType: 'text',
              payload: '端到端加密测试',
              color: '#7ee787',
              clientId: 'e2e-probe'
            })
          );
        }
        return;
      }

      if (msg.type === 'ack') {
        if (msg.reason === 'bad_enc') {
          sawBadEncReject = true;
          console.log('明文消息被拒绝（reason=bad_enc）✅');
          return;
        }
        if (msg.status === 'ok') {
          console.log('加密消息被接受，seq =', msg.seq, '✅');
          clearTimeout(timer);
          if (!sawEncryptedHello) console.error('❌ hello 不是密文');
          if (!sawBadEncReject) console.error('❌ 明文没有被拒绝');
          resolve(sawEncryptedHello && sawBadEncReject);
        }
      }
    };

    ws.onerror = (e) => reject(new Error('WS 错误: ' + (e.message || e.type)));
  });

  const ok = await done;
  ws.close();
  console.log(ok ? '\n结论：端到端加密链路正常 ✅' : '\n结论：有问题 ❌');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
