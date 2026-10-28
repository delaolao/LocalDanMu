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
    ['这个工具是免费的吗', '#b197fc', 'c7'],
    ['希望课后能把资料发群里', '#66e3d0', 'c8'],
    ['刚才那个表格能再放一遍吗', '#7cc4ff', 'c9'],
    ['讲得很好，受益匪浅', '#ffe066', 'c10'],
    ['第三个案例和我们业务很像', '#7ee787', 'c11'],
    ['能不能演示一下实际操作', '#ffb4d1', 'c12'],
    ['这套方案大概多少钱', '#ffa94d', 'c13'],
    ['线上会有回放吗', '#b197fc', 'c14']
  ];
  for (const [text, color, cid, kind] of demo) {
    await send(text, color, cid, kind).catch((e) => console.log('skip', text, e.message));
    await sleep(420);
  }

  const win = new BrowserWindow({
    width: 420,
    height: 900,
    show: true,
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
  await sleep(900);
  const after = await win.webContents.executeJavaScript(
    "({count: document.querySelectorAll('#feedList .msg').length, last: (document.querySelector('#feedList .msg:last-child .msg-bubble')||{}).textContent})"
  );
  console.log('实时追加后:', JSON.stringify(after));
  const shot2 = path.join(__dirname, 'out', 'feed-live.png');
  const img2 = await win.webContents.capturePage();
  require('fs').writeFileSync(shot2, img2.toPNG());

  // 翻到顶部后再来新消息：应出现 "↓ N 条新消息" 且不自动滚回底部
  await win.webContents.executeJavaScript(
    "(() => { const l = document.getElementById('feedList'); l.scrollTop = 0; l.dispatchEvent(new Event('scroll')); return l.scrollTop; })()"
  );
  await sleep(200);
  await send('翻上去之后的新消息', '#ffe066', 'c9');
  await sleep(700);
  const pill = await win.webContents.executeJavaScript(`(() => {
    const l = document.getElementById('feedList');
    const n = document.getElementById('feedNew');
    return { pillHidden: n.hidden, pillText: n.textContent, scrollTop: l.scrollTop };
  })()`);
  console.log('翻到顶部后:', JSON.stringify(pill));

  console.log('截图:', shot1, shot2);
  app.quit();
});
