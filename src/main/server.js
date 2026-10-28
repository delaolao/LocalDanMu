'use strict';

/**
 * 内置 HTTP + WebSocket 服务（单端口）
 *
 * 设计要点：
 * - HTTP 与 WS 共用一个端口（升级请求走 upgrade 事件），二维码只暴露一个 URL。
 * - 观众必须带正确的房间口令才能进入页面 / 建立 WS：没有口令的人即使在同一局域网也发不了消息。
 * - 服务端只做三件事：校验、限流、转发。消息不写磁盘，全部留在内存里。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

const LIMITS = {
  text: 100, // 字符（按码点计，emoji 算 1 个）
  imageBase64: 900 * 1024, // ~660KB 原始图片
  imageBytes: 6 * 1024 * 1024,
  maxPayload: 2 * 1024 * 1024
};

const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

/** 弹幕文字允许的颜色（与手机端调色板一致）。只收白名单，避免传深色导致大屏上看不清。 */
const COLORS = ['#ffffff', '#ffe066', '#7ee787', '#7cc4ff', '#ffb4d1', '#ffa94d', '#b197fc', '#66e3d0'];

function normalizeColor(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return COLORS.includes(value) ? value : null;
}

/** 恒定时间比较，避免口令被逐字符试探。 */
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch (_) {
    return false;
  }
}

function countChars(s) {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** 清洗文本：去控制字符、零宽字符、方向覆写符（可用于伪装文字），压缩空白。 */
function cleanText(raw) {
  return String(raw)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; base-uri 'none'; form-action 'none'"
};

function createBridge(options) {
  const {
    staticDir,
    token,
    getConfig,
    onMessage,
    onStats,
    filter = null,
    onLog = () => {}
  } = options;

  const clients = new Set();
  const rateByIp = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxPayload, perMessageDeflate: false });
  let server = null;
  let seq = 0;
  let heartbeat = null;
  let globalBucket = { tokens: 12, last: Date.now() };
  let closed = false;

  // 观众端「现场流」用的最近消息（只存轻量副本，图片不存原图）
  const RECENT_MAX = 24;
  const recentItems = [];

  function broadcastRaw(obj) {
    const data = JSON.stringify(obj);
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(data);
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  /* ------------------------------------------------------------------ HTTP */

  function baseHeaders(extra) {
    return {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      ...extra
    };
  }

  function reply(res, status, body, headers) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    res.writeHead(status, baseHeaders({ 'Content-Type': 'text/plain; charset=utf-8', ...headers }));
    if (res.req && res.req.method === 'HEAD') return res.end();
    res.end(buf);
  }

  function serveFile(res, filePath) {
    fs.readFile(filePath, (err, data) => {
      if (err) return reply(res, 404, 'Not Found');
      const ext = path.extname(filePath).toLowerCase();
      reply(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    });
  }

  function pageRoot(res) {
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>培训互动</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0f1117;color:#e8eaef;font:16px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;text-align:center;padding:24px}
h1{font-size:20px;margin:0 0 12px}p{color:#98a0b0;margin:0}</style></head>
<body><div><h1>请用手机扫描大屏上的二维码</h1><p>本页面只接受带房间口令的链接</p></div></body></html>`;
    reply(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
  }

  function pageInvalid(res, status) {
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>链接无效</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0f1117;color:#e8eaef;font:16px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;text-align:center;padding:24px}
h1{font-size:20px;margin:0 0 12px}p{color:#98a0b0;margin:0;max-width:22em}</style></head>
<body><div><h1>链接已失效</h1><p>请重新扫描大屏上的二维码，或向讲师索取当前链接。</p></div></body></html>`;
    reply(res, status, html, { 'Content-Type': 'text/html; charset=utf-8' });
  }

  function onRequest(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, 'Method Not Allowed');

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (_) {
      return reply(res, 400, 'Bad Request');
    }

    if (url.pathname === '/healthz') {
      return reply(res, 200, JSON.stringify({ ok: true, ts: Date.now() }), {
        'Content-Type': 'application/json; charset=utf-8'
      });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') return pageRoot(res);

    const room = url.pathname.match(/^\/j\/([^/]+)\/?$/);
    if (room) {
      if (!timingSafeEqual(room[1], token)) return pageInvalid(res, 403);
      return serveFile(res, path.join(staticDir, 'index.html'));
    }

    if (url.pathname.startsWith('/assets/')) {
      const rel = decodeURIComponent(url.pathname.slice('/assets/'.length));
      const assetsDir = path.join(staticDir, 'assets');
      const filePath = path.join(assetsDir, rel);
      if (!filePath.startsWith(assetsDir + path.sep)) return reply(res, 404, 'Not Found');
      return serveFile(res, filePath);
    }

    return reply(res, 404, 'Not Found');
  }

  /* ------------------------------------------------------------- WebSocket */

  function send(ws, obj) {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch (err) {
      onLog('send-error', err && err.message);
    }
  }

  function ack(ws, msgId, status, extra) {
    send(ws, { type: 'ack', msgId, status, ...(extra || {}) });
  }

  function tooFast(ws, msgId, retryAfter) {
    ack(ws, msgId, 'rate_limited', { retryAfter });
  }

  function ipBucket(ip) {
    let b = rateByIp.get(ip);
    const now = Date.now();
    if (!b) {
      b = { tokens: 8, last: now };
      rateByIp.set(ip, b);
    }
    const elapsed = (now - b.last) / 1000;
    b.tokens = Math.min(8, b.tokens + elapsed * 0.8); // 0.8 条/秒，突发 8 条
    b.last = now;
    return b;
  }

  function takeGlobal() {
    const now = Date.now();
    globalBucket.tokens = Math.min(12, globalBucket.tokens + ((now - globalBucket.last) / 1000) * 4);
    globalBucket.last = now;
    if (globalBucket.tokens < 1) return false;
    globalBucket.tokens -= 1;
    return true;
  }

  function validate(payload) {
    if (!payload || typeof payload !== 'object') return { ok: false, reason: 'bad_request' };
    const type = payload.contentType;

    if (type === 'text') {
      if (typeof payload.payload !== 'string') return { ok: false, reason: 'bad_request' };
      const text = cleanText(payload.payload);
      if (!text) return { ok: false, reason: 'empty' };
      if (countChars(text) > LIMITS.text) return { ok: false, reason: 'too_long' };
      return { ok: true, contentType: 'text', payload: text, color: normalizeColor(payload.color) };
    }

    if (type === 'image') {
      if (typeof payload.payload !== 'string') return { ok: false, reason: 'bad_request' };
      const data = payload.payload;
      if (data.length > LIMITS.imageBase64) return { ok: false, reason: 'too_large' };
      if (!IMAGE_DATA_URL.test(data)) return { ok: false, reason: 'bad_image' };
      return { ok: true, contentType: 'image', payload: data, color: null };
    }

    return { ok: false, reason: 'bad_request' };
  }

  function onConnection(ws, req) {
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    const client = {
      id: crypto.randomBytes(5).toString('hex'),
      ip,
      alive: true,
      lastSentAt: 0,
      msgIds: new Set()
    };
    clients.add(client);
    ws.isAlive = true;

    send(ws, {
      type: 'hello',
      proto: 1, // 协议版本：手机端缓存了旧页面时用来提示刷新
      intervalSec: Number(getConfig().intervalSec) || 5,
      paused: Boolean(getConfig().paused),
      // 新进来的观众先看到最近几条，避免一片空白
      recent: recentItems.slice(-12),
      serverTs: Date.now()
    });

    notifyStats();

    ws.on('pong', () => {
      client.alive = true;
      ws.isAlive = true;
    });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) return ack(ws, null, 'invalid', { reason: 'binary' });

      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch (_) {
        return ack(ws, null, 'invalid', { reason: 'json' });
      }
      if (!msg || msg.type !== 'message') return ack(ws, null, 'invalid', { reason: 'type' });

      const msgId = typeof msg.msgId === 'string' ? msg.msgId.slice(0, 64) : null;
      if (msgId && client.msgIds.has(msgId)) {
        // 手机端重连后重发：幂等返回，不重复上屏
        return ack(ws, msgId, 'ok', { duplicate: true });
      }

      const verified = validate(msg);
      if (!verified.ok) return ack(ws, msgId, 'invalid', { reason: verified.reason });

      // 内容过滤在校验之后、限流之前：被拦下的消息不占额度，也不上屏
      let verdict = null;
      if (verified.contentType === 'text' && typeof filter === 'function') {
        try {
          verdict = filter(verified.payload);
        } catch (_) {
          verdict = null;
        }
        if (verdict && verdict.blocked) {
          return ack(ws, msgId, 'invalid', { reason: 'filtered' });
        }
      }

      const cfg = getConfig();
      const interval = Math.max(1000, (Number(cfg.intervalSec) || 5) * 1000);
      const now = Date.now();
      const wait = interval - (now - client.lastSentAt);
      if (client.lastSentAt && wait > 0) return tooFast(ws, msgId, wait);

      const bucket = ipBucket(client.ip);
      if (bucket.tokens < 1) return tooFast(ws, msgId, Math.ceil(((1 - bucket.tokens) / 0.8) * 1000));

      if (!takeGlobal()) return tooFast(ws, msgId, 1200);

      bucket.tokens -= 1;
      client.lastSentAt = now;
      if (msgId) {
        client.msgIds.add(msgId);
        if (client.msgIds.size > 40) client.msgIds.delete(client.msgIds.values().next().value);
      }

      seq += 1;
      const out = {
        seq,
        contentType: verified.contentType,
        payload: verified.payload,
        color: verified.color || null,
        flagged: Boolean(verdict && verdict.flagged),
        flagCategory: (verdict && verdict.category) || null,
        ts: now,
        clientId: typeof msg.clientId === 'string' ? msg.clientId.slice(0, 40) : null
      };

      ack(ws, msgId, 'ok', { seq, retryAfter: interval });

      // 广播给所有观众端：文本带正文，图片只给占位（不把原图推给所有人）
      const brief = {
        seq,
        kind: verified.contentType === 'image' ? 'image' : 'text',
        text: verified.contentType === 'text' ? verified.payload : '',
        color: verified.color || null,
        clientId: out.clientId,
        ts: now
      };
      recentItems.push(brief);
      if (recentItems.length > RECENT_MAX) recentItems.shift();
      broadcastRaw({ type: 'item', ...brief });

      try {
        onMessage(out);
      } catch (err) {
        onLog('dispatch-error', err && err.message);
      }
    });

    ws.on('close', () => {
      clients.delete(client);
      notifyStats();
    });

    ws.on('error', () => {
      clients.delete(client);
      notifyStats();
    });
  }

  let statsTimer = null;
  function notifyStats() {
    if (statsTimer || closed) return;
    statsTimer = setTimeout(() => {
      statsTimer = null;
      onStats({ online: clients.size });
    }, 50);
  }

  server = http.createServer(onRequest);
  server.keepAliveTimeout = 5000;

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (_) {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/ws' || !timingSafeEqual(url.searchParams.get('t') || '', token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', onConnection);

  function startHeartbeat() {
    heartbeat = setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.isAlive === false) {
          try {
            ws.terminate();
          } catch (_) {
            /* ignore */
          }
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch (_) {
          /* ignore */
        }
      }
    }, 20000);
    if (heartbeat.unref) heartbeat.unref();
  }

  return {
    /** 监听端口；EADDRINUSE 时抛错，由调用方换端口重试。 */
    listen(port) {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          startHeartbeat();
          resolve(server.address().port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '0.0.0.0');
      });
    },

    broadcast(obj) {
      broadcastRaw(obj);
    },

    online() {
      return clients.size;
    },

    /** 结束一场：先通知客户端，再断开，最后关服务器。 */
    shutdown(reason) {
      if (closed) return Promise.resolve();
      closed = true;
      if (statsTimer) clearTimeout(statsTimer);
      if (heartbeat) clearInterval(heartbeat);
      this.broadcast({ type: 'session_end', reason: reason || 'ended' });
      for (const ws of wss.clients) {
        try {
          ws.close(1001, 'session ended');
        } catch (_) {
          /* ignore */
        }
      }
      return new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const guard = setTimeout(done, 1500);
        if (guard.unref) guard.unref();
        try {
          wss.close(() => {
            server.close(() => done());
          });
        } catch (_) {
          done();
        }
      });
    },

    address() {
      return server.address();
    }
  };
}

module.exports = { createBridge, LIMITS, cleanText, countChars };
