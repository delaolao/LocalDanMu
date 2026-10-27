'use strict';
// 修正 release 的中文（Windows PowerShell 提交时按 ASCII 编码，变成了问号）
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OWNER = 'delaolao';
const REPO = 'LocalDanMu';
const TAG = 'v0.1.0';

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    cwd: ROOT
  }).toString();
  const m = out.match(/^password=(.+)$/m);
  if (!m) throw new Error('no credential');
  return m[1].trim();
}

async function main() {
  const t = token();
  const headers = {
    Authorization: `Bearer ${t}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'LocalDanMu-fix'
  };

  const relRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, { headers });
  if (!relRes.ok) throw new Error(`get release ${relRes.status}`);
  const rel = await relRes.json();

  const notes = fs.readFileSync(path.join(ROOT, 'scripts', 'release-notes.md'), 'utf8');
  const name = '培训弹幕 v0.1.0';

  const patch = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/${rel.id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ name, body: notes })
  });
  if (!patch.ok) throw new Error(`patch ${patch.status}: ${await patch.text()}`);
  const updated = await patch.json();

  console.log('name ok:', updated.name === name, '| name:', updated.name);
  console.log('body length:', updated.body.length, '| starts:', updated.body.slice(0, 20));
  console.log('assets:', updated.assets.map((a) => `${a.name} ${(a.size / 1048576).toFixed(1)}MB ${a.state}`).join(', '));
  console.log('url:', updated.html_url);
}

main().catch((e) => {
  console.error('FAIL', e.message);
  process.exit(1);
});
