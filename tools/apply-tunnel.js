'use strict';
/**
 * 把本地令牌文件里的固定隧道配置写进正在运行的应用，并开启隧道。
 * 令牌不经过命令行参数，只从文件读、通过 CDP 送进页面。
 *
 * 用法：node tools/apply-tunnel.js [域名] [令牌文件]
 *   默认域名：dm.teachergeng.space
 *   默认文件：%LOCALAPPDATA%\localdanmu\tunnel-token.txt
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const host = process.argv[2] || 'dm.teachergeng.space';
const tokenFile =
  process.argv[3] || path.join(process.env.LOCALAPPDATA || os.homedir(), 'localdanmu', 'tunnel-token.txt');

if (!fs.existsSync(tokenFile)) {
  console.error('找不到令牌文件:', tokenFile);
  process.exit(1);
}
const token = fs.readFileSync(tokenFile, 'utf8').trim();
if (!token.startsWith('eyJ')) {
  console.error('令牌格式看起来不对（应以 eyJ 开头），长度', token.length);
  process.exit(1);
}

const PORT = Number(process.env.CDP_PORT || 9222);

async function evaluate(expr) {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes('control')) || list[0];
  if (!page) throw new Error('没有找到控制面板页面');

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('CDP 超时'));
    }, 30000);
    ws.onopen = () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      if (msg.result && msg.result.exceptionDetails) {
        return reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
      }
      resolve(msg.result.result.value);
    };
    ws.onerror = () => reject(new Error('CDP 连接失败'));
  });
}

(async () => {
  const patch = JSON.stringify({ tunnelHost: host, tunnelToken: token });
  const cfg = await evaluate(`window.api.setConfig(${patch}).then(() => 'ok')`);
  console.log('配置已写入:', cfg, '| 域名:', host);

  const started = await evaluate('window.api.tunnelStart()');
  console.log('启动结果:', started.status, started.message || '');

  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await evaluate('window.api.tunnelState()');
    if (st.status === 'running') {
      console.log('隧道已就绪:', st.url.replace(/#k=.*/, '#k=***'));
      process.exit(0);
    }
    if (st.status === 'error') {
      console.error('隧道失败:', st.message);
      process.exit(1);
    }
  }
  console.error('等待超时');
  process.exit(1);
})();
