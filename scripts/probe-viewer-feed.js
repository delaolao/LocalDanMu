'use strict';
/**
 * 观众端「现场流」观感验证：
 * 1) 开几个 WS 客户端发若干条（含一条图片）
 * 2) 另开一个隐藏窗口加载观众页，截图看回填效果
 * 3) 再发一条，验证实时追加
 *
 * 用法（先起 dev 应用，LDM_TOKEN=feedtest）：
 *   node_modules\electron\dist\electron.exe scripts\probe-viewer-feed.js feedtest
 */
const { app, BrowserWindow } = require('electron');
const WebSocket = require('ws');
const path = require('path');

const TOKEN = process.argv[2] || 'feedtest';
const URL = `http://127.0.0.1:8080/j/${TOKEN}`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function send(text, color, clientId, kind) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:8080/ws?t=${TOKEN}`);
    ws.on('open', () => {
      const msg = {
        type: 'message',
        msgId: `probe-${Math.random().toString(36).slice(2)}`,
        contentType: kind === 'image' ? 'image' : 'text',
        payload: kind === 'image' ? null : text,
        color: kind === 'image' ? null : color,
        clientId,
        ts: Date.now()
      };
      if (kind === 'image') {
        // 1x1 透明 PNG，只为占位显示
        msg.payload =
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      }
      ws.send(JSON.stringify(msg));
    });
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'ack') {
        ws.close();
        resolve(m);
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
}

app.whenReady().then(async () => {
  const demo = [
    ['刚才那个案例，我们公司去年也遇到过', '#7cc4ff', 'c1'],
    ['能不能把第三步再讲一遍', '#ffe066', 'c2'],
    ['图片', null, 'c3', 'image'],
    ['同意楼上，这块确实容易踩坑', '#7ee787', 'c4'],
    ['老师语速有点快，跟不上了', '#ffb4d1', 'c5'],
    ['下课能不能留十分钟答疑', '#ffa94d', 'c6'],
    ['这个工具是免费的吗', '#b197fc', 'c7']
  ];
  for (const [text, color, cid, kind] of demo) {
    await send(text, color, cid, kind);
    await sleep(120);
  }

  const win = new BrowserWindow({
    width: 420,
    height: 900,
    show: false,
    webPreferences: { offscreen: false }
  });
  await win.loadURL(URL);
  await sleep(1200);
  const before = await win.webContents.executeJavaScript(
    "({count: document.querySelectorAll('#feedList .msg').length, empty: document.getElementById('feedEmpty').hidden})"
  );
  console.log('回填后:', JSON.stringify(before));

  const shot1 = path.join(__dirname, 'out', 'feed-backfill.png');
  const img1 = await win.webContents.capturePage();
  require('fs').writeFileSync(shot1, img1.toPNG());

  // 实时追加
  await send('这条是页面打开之后发的', '#66e3d0', 'c8');
  await sleep(600);
  const after = await win.webContents.executeJavaScript(
    "({count: document.querySelectorAll('#feedList .msg').length, last: (document.querySelector('#feedList .msg:last-child .msg-bubble')||{}).textContent})"
  );
  console.log('实时追加后:', JSON.stringify(after));
  const shot2 = path.join(__dirname, 'out', 'feed-live.png');
  const img2 = await win.webContents.capturePage();
  require('fs').writeFileSync(shot2, img2.toPNG());

  console.log('截图:', shot1, shot2);
  app.quit();
});
