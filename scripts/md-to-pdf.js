'use strict';

/**
 * Markdown → PDF
 *
 * 用 Electron 自带的 Chromium 排版和打印，中文/表格/等宽图都能正确渲染，
 * 不依赖 pandoc / wkhtmltopdf。
 *
 * 用法：node_modules\electron\dist\electron.exe scripts\md-to-pdf.js docs\architecture.md docs\architecture.pdf
 */

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const ROOT = path.join(__dirname, '..');
const SRC = path.resolve(ROOT, process.argv[2] || 'docs/architecture.md');
const OUT = path.resolve(ROOT, process.argv[3] || 'docs/architecture.pdf');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const CSS = `
  :root {
    --ink: #1b2b26;
    --muted: #5f7a71;
    --accent: #0f9f78;
    --line: #d6e4de;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 10pt/1.62 "Microsoft YaHei", "Segoe UI", "PingFang SC", sans-serif;
    color: var(--ink);
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; color: #0d2b23; }
  h2 {
    font-size: 14.5pt;
    margin: 18pt 0 8pt;
    padding-bottom: 4pt;
    border-bottom: 1px solid var(--line);
  }
  h3 { font-size: 11.5pt; margin: 13pt 0 5pt; }
  h4 { font-size: 10.5pt; margin: 10pt 0 4pt; }
  p, li { orphans: 2; widows: 2; }
  ul, ol { padding-left: 18pt; }
  li { margin: 2pt 0; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 8.6pt;
    margin: 7pt 0 10pt;
    line-height: 1.45;
  }
  th, td { border: 1px solid var(--line); padding: 4pt 6pt; vertical-align: top; text-align: left; }
  th { background: #f2f7f4; font-weight: 600; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  code {
    font-family: Consolas, "Cascadia Mono", "Courier New", monospace;
    font-size: 8.6pt;
    background: #f4f7f5;
    padding: 0 2pt;
    border-radius: 2pt;
  }
  pre {
    background: #f6f9f7;
    border: 1px solid var(--line);
    border-radius: 4pt;
    padding: 7pt 9pt;
    margin: 8pt 0;
    font-size: 7.3pt;
    line-height: 1.28;
    break-inside: avoid;
    page-break-inside: avoid;
    overflow: hidden;
  }
  pre code { background: none; padding: 0; font-size: inherit; }
  blockquote {
    margin: 8pt 0;
    padding: 5pt 10pt;
    border-left: 3px solid var(--accent);
    background: #f7fbf9;
    color: var(--muted);
  }
  blockquote p { margin: 2pt 0; }
  a { color: var(--accent); text-decoration: none; }
  hr { border: none; border-top: 1px solid var(--line); margin: 14pt 0; }

  /* 屏幕上按 A4 版心留白，方便截图目检；打印时由 printToPDF 的 margins 负责 */
  @media screen {
    body { padding: 0.65in 0.55in; }
    .cover { height: 9.2in; }
  }

  /* 封面 */
  .cover {
    height: 245mm;
    display: flex;
    flex-direction: column;
    justify-content: center;
    page-break-after: always;
    break-after: page;
  }
  .cover .kicker { color: var(--accent); font-size: 10pt; letter-spacing: 2pt; margin-bottom: 10pt; }
  .cover h1 {
    font-size: 30pt;
    margin: 0 0 6pt;
    letter-spacing: 2pt;
  }
  .cover .sub { font-size: 15pt; color: var(--muted); margin-bottom: 28pt; }
  .cover .rule { width: 60mm; height: 3pt; background: var(--accent); margin-bottom: 24pt; }
  .cover dl { margin: 0; font-size: 10pt; color: var(--muted); }
  .cover dt { float: left; width: 28mm; clear: left; color: #8aa79d; }
  .cover dd { margin: 0 0 7pt 28mm; color: var(--ink); }
`;

function buildHtml(markdown) {
  // 去掉原文的一级标题与紧随的引言块，封面已经承载
  const body = markdown.replace(/^#\s+.*\n+/, '').replace(/^(>\s.*\n)+/, '');
  const rendered = marked.parse(body, { gfm: true, breaks: false, headerIds: false, mangle: false });
  const today = new Date();
  const stamp = `${today.getFullYear()} 年 ${today.getMonth() + 1} 月 ${today.getDate()} 日`;

  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>培训弹幕 · 实现文档</title><style>${CSS}</style></head>
<body>
  <section class="cover">
    <div class="kicker">LOCALDANMU</div>
    <h1>培训弹幕</h1>
    <div class="sub">实现文档 · 架构与模块说明</div>
    <div class="rule"></div>
    <dl>
      <dt>对应需求</dt><dd>《线下培训弹幕互动平台（自建私密版）需求方案 v1.0》</dd>
      <dt>代码版本</dt><dd>v${pkg.version}</dd>
      <dt>代码仓库</dt><dd>github.com/delaolao/LocalDanMu</dd>
      <dt>生成日期</dt><dd>${stamp}</dd>
    </dl>
  </section>
  ${rendered}
</body></html>`;
}

app.whenReady().then(async () => {
  const markdown = fs.readFileSync(SRC, 'utf8');
  const html = buildHtml(markdown);
  const tmp = path.join(require('os').tmpdir(), `ldm-doc-${process.pid}.html`);
  fs.writeFileSync(tmp, html, 'utf8');

  const win = new BrowserWindow({
    show: false,
    width: 1000,
    height: 1400,
    webPreferences: { offscreen: false }
  });
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 700));

  // 版心宽度自检：代码块/表格有没有横向溢出（打印时会被裁掉）
  const overflow = await win.webContents.executeJavaScript(`(() => {
    const maxOver = (nodes) => Math.max(0, ...[...nodes].map((n) => n.scrollWidth - n.clientWidth));
    return {
      pre: maxOver(document.querySelectorAll('pre')),
      table: maxOver(document.querySelectorAll('table')),
      body: document.body.scrollWidth - document.body.clientWidth,
      preCount: document.querySelectorAll('pre').length,
      tableCount: document.querySelectorAll('table').length
    };
  })()`);
  console.log('版心自检:', JSON.stringify(overflow));

  const pdf = await win.webContents.printToPDF({
    pageSize: 'A4',
    printBackground: true,
    margins: { top: 0.6, bottom: 0.65, left: 0.55, right: 0.55 },
    displayHeaderFooter: true,
    headerTemplate: '<div style="width:100%;font-size:8px;color:#9db5ac;padding:0 15mm;text-align:right;">培训弹幕 · 实现文档</div>',
    footerTemplate:
      '<div style="width:100%;font-size:8px;color:#9db5ac;text-align:center;">第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</div>'
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, pdf);
  fs.unlinkSync(tmp);

  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(`PDF: ${OUT} (${kb} KB)`);

  if (process.argv.includes('--shot')) {
    const shot = OUT.replace(/\.pdf$/, '-preview.png');
    win.showInactive();
    await new Promise((r) => setTimeout(r, 300));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(shot, img.toPNG());
    console.log('preview:', shot);
  }

  // 按 A4 的 CSS 像素尺寸截图，用来目检排版（和打印结果同一套样式）
  if (process.argv.includes('--shots')) {
    win.setContentSize(794, 1123);
    win.showInactive();
    await new Promise((r) => setTimeout(r, 400));
    const offsets = [0, 1123, 2246, 6738];
    for (let i = 0; i < offsets.length; i += 1) {
      await win.webContents.executeJavaScript(`window.scrollTo(0, ${offsets[i]}); true`);
      await new Promise((r) => setTimeout(r, 350));
      const img = await win.webContents.capturePage();
      const file = OUT.replace(/\.pdf$/, `-shot${i + 1}.png`);
      fs.writeFileSync(file, img.toPNG());
      console.log('shot:', file);
    }
  }

  app.quit();
});
