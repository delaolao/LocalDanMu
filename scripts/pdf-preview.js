'use strict';
// 用 Electron 内置 PDF 查看器打开生成的 PDF，截第 1 页做目检
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pdf = path.resolve(ROOT, process.argv[2] || 'docs/architecture.pdf');
const out = pdf.replace(/\.pdf$/, '-p1.png');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1000,
    height: 1400,
    show: false,
    webPreferences: { plugins: true, webSecurity: false }
  });
  await win.loadURL(`file:///${pdf.replace(/\\/g, '/')}`);
  await new Promise((r) => setTimeout(r, 2500));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('saved', out, img.getSize());
  app.quit();
});
