'use strict';

/**
 * 创建 / 更新 GitHub Release（文案取自 scripts/release-notes.md）
 *
 * 注意：不要用 Windows PowerShell 直接发中文 JSON，它会按 ASCII 编码，中文全变问号。
 * 这里用 Node 拼 UTF-8，绕开这个问题。
 *
 * 用法：
 *   node scripts/publish-release.js            # 用 package.json 的版本，tag v<版本号>
 *   node scripts/publish-release.js v0.2.0     # 指定 tag
 *
 * 安装包上传见 scripts/upload-release-asset.ps1（大文件用 curl 更稳）。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OWNER = 'delaolao';
const REPO = 'LocalDanMu';

function token() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    cwd: ROOT
  }).toString();
  const m = out.match(/^password=(.+)$/m);
  if (!m) throw new Error('没有取到 GitHub 凭据（先手动 git push 一次让凭据管理器记住）');
  return m[1].trim();
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const tag = process.argv[2] || `v${pkg.version}`;
  const name = `培训弹幕 ${tag}`;
  const notes = fs.readFileSync(path.join(ROOT, 'scripts', 'release-notes.md'), 'utf8');

  const t = token();
  const headers = {
    Authorization: `Bearer ${t}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'LocalDanMu-release'
  };

  const getRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${tag}`, { headers });
  let release;
  if (getRes.ok) {
    const existing = await getRes.json();
    const patch = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/${existing.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ name, body: notes })
    });
    if (!patch.ok) throw new Error(`更新失败 ${patch.status}: ${await patch.text()}`);
    release = await patch.json();
    console.log('已更新 release:', release.html_url);
  } else {
    const create = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: 'main',
        name,
        body: notes,
        draft: false,
        prerelease: false
      })
    });
    if (!create.ok) throw new Error(`创建失败 ${create.status}: ${await create.text()}`);
    release = await create.json();
    console.log('已创建 release:', release.html_url);
  }

  console.log('标题:', release.name);
  console.log(
    '附件:',
    release.assets.map((a) => `${a.name} ${(a.size / 1048576).toFixed(1)}MB ${a.state}`).join(', ') || '（还没有）'
  );
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
