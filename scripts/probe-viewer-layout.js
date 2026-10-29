'use strict';
// 观众端在窄屏下的布局检查：按几种手机宽度截图，并量出色彩行的实际几何
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const TOKEN = process.argv[2] || 'layout';
const URL = `http://127.0.0.1:8080/j/${TOKEN}`;
const WIDTHS = process.argv[3] ? [Number(process.argv[3])] : [320, 360, 390, 414];

app.whenReady().then(async () => {
  for (const w of WIDTHS) {
    const win = new BrowserWindow({ width: w, height: 760, show: false, webPreferences: { offscreen: false } });
    try {
      await win.loadURL(URL);
    } catch (err) {
      console.log(w, 'load failed:', err.message);
      win.destroy();
    await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    await new Promise((r) => setTimeout(r, 900));
    const info = await win.webContents.executeJavaScript(`(() => {
      const row = document.querySelector('.colors');
      const sw = [...document.querySelectorAll('.swatch')];
      const r = row.getBoundingClientRect();
      return {
        vw: innerWidth,
        dpr: devicePixelRatio,
        rowWidth: Math.round(r.width),
        rowScrollWidth: row.scrollWidth,
        swatchBox: sw.map((el) => {
          const b = el.getBoundingClientRect();
          return Math.round(b.width) + 'x' + Math.round(b.height);
        })
      };
    })()`);
    console.log(w, JSON.stringify(info));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'out', `layout-${w}.png`), img.toPNG());
    win.destroy();
    await new Promise((r) => setTimeout(r, 250));
  }
  app.quit();
});
