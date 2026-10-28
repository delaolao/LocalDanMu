'use strict';

/**
 * 主进程
 *
 * 职责：生命周期、窗口、托盘、全局快捷键、IPC、导出。
 * 网络与消息校验全部在 server.js，配置在 store.js，网卡探测在 network.js。
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  globalShortcut,
  clipboard,
  dialog,
  nativeImage,
  nativeTheme,
  shell
} = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const QRCode = require('qrcode');

const network = require('./network');
const { createBridge } = require('./server');
const { createStore } = require('./store');
const { createFilter } = require('./filter');
const { forceTop, isLeftButtonDown } = require('./topmost');

const APP_DIR = path.join(__dirname, '..', '..');
const WEB_DIR = path.join(APP_DIR, 'src', 'web');
const RENDERER_DIR = path.join(APP_DIR, 'src', 'renderer');
const ASSETS_DIR = path.join(APP_DIR, 'assets');

const IS_SMOKE = process.argv.includes('--smoke');
const IS_DEV = process.argv.includes('--dev');
// 临时诊断：用真实鼠标事件验证"悬停→接管点击→点开大图"这条链路
const IS_PROBE = process.env.LDM_CLICKPROBE === '1';
const SESSION_DIR = path.join(os.tmpdir(), `localdanmu-${process.pid}`);
// 打包后 asar 是只读的，冒烟产物写到临时目录
const OUT_DIR = app.isPackaged ? path.join(os.tmpdir(), 'localdanmu-smoke') : path.join(APP_DIR, 'scripts', 'out');

/**
 * 便携模式（绿色版）：所有用户数据写在 exe 旁边，不碰 AppData、不写注册表。
 * - 单文件便携版：electron-builder 会设置 PORTABLE_EXECUTABLE_DIR
 * - 解压即用版：目录里放一个 portable.txt 作为标记
 * 目录不可写（例如解压到 Program Files）时自动退回默认的 AppData。
 */
const PORTABLE_DIR = (() => {
  if (!app.isPackaged) return null;
  const candidates = [];
  if (process.env.PORTABLE_EXECUTABLE_DIR) candidates.push(process.env.PORTABLE_EXECUTABLE_DIR);
  try {
    const exeDir = path.dirname(app.getPath('exe'));
    if (fs.existsSync(path.join(exeDir, 'portable.txt'))) candidates.push(exeDir);
  } catch (_) {
    /* ignore */
  }
  for (const dir of candidates) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (_) {
      /* 换下一个候选 */
    }
  }
  return null;
})();

const HISTORY_MAX_TEXT = 300;
const HISTORY_MAX_IMAGE = 20;

// 绿色版：用户数据（settings.json 等）跟着 exe 走；正常安装版仍用 AppData。
try {
  if (PORTABLE_DIR) app.setPath('userData', PORTABLE_DIR);
  // Chromium 的缓存/存储统一挪到临时目录，退出后清掉，避免消息内容残留
  app.setPath('sessionData', SESSION_DIR);
  app.commandLine.appendSwitch('disk-cache-size', '1');
} catch (_) {
  /* ignore */
}

/* --------------------------------------------------------------- 单实例 */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap() {
  let store;
  let bridge = null;
  let controlWin = null;
  let overlayWin = null;
  let joinWin = null;
  let cloudWin = null;
  let filterImpl = null;
  let tray = null;
  let quitting = false;

  let session = null; // { port, token, url, ip, nicName }
  let paused = false;
  let ended = false;
  let online = 0;
  let total = 0;
  let qrDataUrl = '';
  let warnings = [];
  let displays = [];
  let overlayVisible = true;
  let shortcutReport = {};

  const history = []; // 仅内存，结束即清空
  const rendererLogs = [];
  const probeLog = [];

  // 不让主进程异常弹出 "A JavaScript error occurred" 对话框吓到讲师，记录后继续。
  process.on('uncaughtException', (err) => {
    console.error('[uncaught]', (err && err.stack) || err);
    rendererLogs.push('uncaught: ' + (err && err.message));
  });
  process.on('unhandledRejection', (err) => {
    console.error('[unhandled]', (err && err.stack) || err);
    rendererLogs.push('unhandled: ' + (err && err.message));
  });

  const log = (...args) => {
    if (IS_DEV || IS_SMOKE) console.log('[main]', ...args);
  };

  /* ------------------------------------------------------------- 生命周期 */

  app.on('second-instance', () => {
    showControl();
  });

  app.whenReady().then(async () => {
    cleanupStaleSessions();
    store = createStore(path.join(app.getPath('userData'), 'settings.json'));
    rebuildFilter();
    registerIpc();
    hookRendererDiagnostics();
    createControlWindow();
    createOverlay();
    startCursorWatch();
    createTray();
    registerShortcuts();
    applyThemeBackground();
    nativeTheme.on('updated', () => {
      if (store.get().theme === 'system') applyThemeBackground();
    });
    screen.on('display-added', onDisplaysChanged);
    screen.on('display-removed', onDisplaysChanged);
    screen.on('display-metrics-changed', onDisplaysChanged);

    // 先起服务：网卡选择很快，不必等 PowerShell 查网络位置
    try {
      await startSession();
      if (IS_PROBE) runClickProbe();
    } catch (err) {
      warnings = [
        {
          level: 'error',
          text: `服务启动失败：${err.message}。请点「重新检测」重试，或检查端口是否被占用。`,
          action: 'refresh'
        }
      ];
      pushState(true);
    }
    // 慢的检测（网络位置/防火墙提示）放到后台，不挡二维码；冒烟模式下等它完成再截图
    if (IS_SMOKE) await refreshNetwork();
    else refreshNetwork().catch(() => {});

    // 网络变化时重算地址（IP 变了二维码要跟着变）
    setInterval(() => {
      if (!session) return;
      refreshNetwork().catch(() => {});
    }, 15000);

    // 置顶守卫：WPS/PPT 放映会把自己的全屏窗口设成置顶并激活，
    // Electron 的 setAlwaysOnTop 这时是空操作，必须用 native 的 SetWindowPos 重新压上去。
    setInterval(() => {
      if (store.get().mode === 'cloud') {
        forceTop(cloudWin);
        forceTop(controlWin);
        return;
      }
      if (joinWin && !joinWin.isDestroyed() && joinWin.isVisible()) {
        forceTop(joinWin);
        forceTop(controlWin);
        return;
      }
      if (overlayVisible) forceTop(overlayWin);
      forceTop(controlWin);
    }, 350);

    pushState();

    if (IS_SMOKE) {
      setTimeout(() => feedSmokeItems(), 800);
      setTimeout(() => {
        finishSmoke().catch((err) => {
          console.error('smoke failed:', err);
          process.exitCode = 1;
          app.quit();
        });
      }, 3200);
    }
  });

  app.on('browser-window-focus', () => {
    if (overlayWin && !overlayWin.isDestroyed() && overlayVisible) {
      overlayWin.moveTop();
      if (controlWin && !controlWin.isDestroyed() && controlWin.isVisible()) controlWin.moveTop();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (controlWin && !controlWin.isDestroyed()) controlWin.show();
  });

  app.on('will-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    if (bridge) {
      bridge.shutdown('quit');
      bridge = null;
    }
  });

  app.on('quit', () => {
    try {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    } catch (_) {
      /* 临时目录，交给系统清理 */
    }
  });

  function cleanupStaleSessions() {
    try {
      const tmp = os.tmpdir();
      for (const name of fs.readdirSync(tmp)) {
        if (!name.startsWith('localdanmu-')) continue;
        const full = path.join(tmp, name);
        const age = Date.now() - fs.statSync(full).mtimeMs;
        if (age > 24 * 3600 * 1000) fs.rmSync(full, { recursive: true, force: true });
      }
    } catch (_) {
      /* ignore */
    }
  }

  /* --------------------------------------------------------------- 网络 */

  let profileCache = { at: 0, list: [] };

  async function refreshNetwork() {
    const preferred = store.get().preferredIp;
    const picked = await network.pick(preferred);
    const nextWarnings = [];

    if (picked.fallback || !picked.address || picked.address === '127.0.0.1') {
      nextWarnings.push({
        level: 'error',
        text: '没有检测到可用的局域网地址，手机将无法访问。请连接 WiFi 或热点后点「重新检测」。',
        action: 'refresh'
      });
    } else if (picked.virtual) {
      nextWarnings.push({
        level: 'warn',
        text: `当前选中「${picked.name}」看起来是虚拟网卡，手机可能连不上。请在设置里换一个网卡。`,
        action: 'settings'
      });
    }

    try {
      if (Date.now() - profileCache.at > 60000) {
        profileCache = { at: Date.now(), list: await network.connectionProfiles() };
      }
      const profiles = profileCache.list;
      // Get-NetConnectionProfile 的 NetworkCategory 序列化成数字：0=公用 1=专用 2=域
      const isPublicCategory = (p) => {
        if (!p) return false;
        const v = String(p.NetworkCategory == null ? '' : p.NetworkCategory).toLowerCase();
        return v === '0' || v === 'public';
      };
      const hit = profiles.find(
        (p) =>
          p &&
          (String(p.InterfaceAlias || '').toLowerCase() === String(picked.name || '').toLowerCase() ||
            String(p.Name || '').toLowerCase() === String(picked.name || '').toLowerCase())
      );
      if (isPublicCategory(hit) || (!hit && profiles.some(isPublicCategory))) {
        nextWarnings.push({
          level: 'warn',
          text: '当前网络被 Windows 识别为「公用网络」，防火墙默认会拦截手机访问。建议改为「专用网络」，或为本程序放行。',
          action: 'networkSettings'
        });
      }
    } catch (_) {
      /* 拿不到网络位置就不提示 */
    }

    if (session) {
      const nextIp = picked.address;
      if (nextIp !== session.ip) {
        session.ip = nextIp;
        session.nicName = picked.name;
        session.url = buildUrl(nextIp, session.port, session.token);
        await refreshQr();
      }
    }

    warnings = nextWarnings;
    globalThis.__nic = { picked, list: picked.list };
    pushState();
  }

  function buildUrl(ip, port, token) {
    return `http://${ip}:${port}/j/${token}`;
  }

  /* --------------------------------------------------------------- 会话 */

  async function startSession() {
    ended = false;
    paused = false;
    total = 0;
    online = 0;
    history.length = 0;

    const wanted = await pickPort(8080);
    // 开发调试可用 LDM_TOKEN 固定房间号；打包后忽略，避免被误用
    const token = (!app.isPackaged && process.env.LDM_TOKEN) || randomToken(8);
    const picked = await network.pick(store.get().preferredIp);
    const ip = picked.address || '127.0.0.1';

    bridge = createBridge({
      staticDir: WEB_DIR,
      token,
      getConfig: () => ({ ...store.get(), paused }),
      onMessage: handleIncoming,
      filter: (text) => (filterImpl ? filterImpl.check(text) : null),
      onStats: (s) => {
        online = s.online;
        schedulePush();
      },
      onLog: (...args) => log(...args)
    });

    let port;
    try {
      port = await bridge.listen(wanted);
    } catch (err) {
      port = await bridge.listen(0);
    }

    session = { port, token, ip, nicName: picked.name, url: buildUrl(ip, port, token) };
    await refreshQr();
    log('session started', session.url);
    pushState(true);
    applyMode();
  }

  async function endSession() {
    if (!session && !bridge) return;
    ended = true;
    paused = false;
    if (joinWin && !joinWin.isDestroyed()) joinWin.hide();
    if (cloudWin && !cloudWin.isDestroyed()) cloudWin.hide();
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('dm:cmd', { type: 'clear' });
    if (bridge) {
      await bridge.shutdown('ended');
      bridge = null;
    }
    history.length = 0;
    total = 0;
    online = 0;
    session = null;
    qrDataUrl = '';
    pushState();
  }

  async function restartSession() {
    ended = false;
    if (bridge) {
      await bridge.shutdown('restart');
      bridge = null;
    }
    await startSession();
  }

  function canListen(port) {
    return new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      try {
        probe.listen(port, '0.0.0.0');
      } catch (_) {
        resolve(false);
      }
    });
  }

  async function pickPort(start) {
    for (let port = start; port < start + 20; port += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (await canListen(port)) return port;
    }
    return 0; // 交给系统分配
  }

  function randomToken(len) {
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(len);
    let out = '';
    for (let i = 0; i < len; i += 1) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }

  async function refreshQr() {
    if (!session) {
      qrDataUrl = '';
      return;
    }
    try {
      qrDataUrl = await QRCode.toDataURL(session.url, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 720,
        color: { dark: '#0b0d12ff', light: '#ffffffff' }
      });
    } catch (err) {
      qrDataUrl = '';
      log('qr error', err.message);
    }
  }

  /* --------------------------------------------------------------- 消息 */

  function rebuildFilter() {
    const cfg = store.get();
    filterImpl = createFilter({ level: cfg.filterLevel, customWords: cfg.customWords });
    log('filter rebuilt', filterImpl.wordCount, 'words, level', cfg.filterLevel);
  }

  /** 给界面用的精简条目：不带图片数据，避免每次推送几百 KB。 */
  function compact(item) {
    return {
      seq: item.seq,
      ts: item.ts,
      contentType: item.contentType,
      text: item.contentType === 'text' ? item.payload : '',
      color: item.color || null,
      flagged: Boolean(item.flagged),
      flagCategory: item.flagCategory || null
    };
  }

  function publicHistory(limit) {
    const max = limit || 200;
    return history.slice(-max).map(compact);
  }

  function handleIncoming(msg) {
    total += 1;
    history.push(msg);
    trimHistory();

    const brief = compact(msg);
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send('dm:item', msg);
    }
    for (const win of [controlWin, cloudWin]) {
      if (win && !win.isDestroyed()) {
        try {
          win.webContents.send('dm:item', brief);
        } catch (_) {
          /* ignore */
        }
      }
    }
    schedulePush();
  }

  /** 重播：切回滚动模式再把这条重新推上屏，不计数、不入历史 */
  function replayItem(seq) {
    const item = history.find((m) => m.seq === seq);
    if (!item) return false;
    if (store.get().mode !== 'scroll') {
      store.set({ mode: 'scroll' });
      applyMode();
    }
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send('dm:item', { ...item, replayed: true });
      overlayWin.showInactive();
      overlayWin.setIgnoreMouseEvents(true, { forward: true });
      overlayWin.moveTop();
    }
    return true;
  }

  function trimHistory() {
    let images = 0;
    for (const m of history) if (m.contentType === 'image') images += 1;
    let i = 0;
    while (i < history.length && (history.length > HISTORY_MAX_TEXT || images > HISTORY_MAX_IMAGE)) {
      if (history[i].contentType === 'image') {
        history.splice(i, 1);
        images -= 1;
      } else if (history.length > HISTORY_MAX_TEXT) {
        history.splice(i, 1);
      } else {
        i += 1;
      }
    }
  }

  /* --------------------------------------------------------------- 状态 */

  let pushTimer = null;
  function schedulePush() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      pushState();
    }, 120);
  }

  function collectDisplays() {
    const primaryId = screen.getPrimaryDisplay().id;
    displays = screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      label: `${i + 1}. ${d.bounds.width}×${d.bounds.height}${d.id === primaryId ? '（主屏）' : ''}`,
      width: d.bounds.width,
      height: d.bounds.height
    }));
    return displays;
  }

  function targetDisplay() {
    const saved = store.get().displayId;
    const all = screen.getAllDisplays();
    return all.find((d) => String(d.id) === String(saved)) || screen.getPrimaryDisplay();
  }

  function buildState() {
    const nicInfo = globalThis.__nic || { picked: { name: '-', address: '-' }, list: [] };
    return {
      ready: Boolean(session),
      url: session ? session.url : '',
      token: session ? session.token : '',
      ip: session ? session.ip : '',
      port: session ? session.port : 0,
      nicName: session ? session.nicName : '',
      nics: (nicInfo.list || []).map((c) => ({
        address: c.address,
        name: c.name,
        virtual: c.virtual,
        current: session ? c.address === session.ip : false
      })),
      online,
      total,
      paused,
      ended,
      qr: qrDataUrl,
      displays: collectDisplays(),
      selectedDisplay: String(targetDisplay().id),
      overlayVisible,
      joinVisible: Boolean(joinWin && !joinWin.isDestroyed() && joinWin.isVisible()),
      config: { ...store.get() },
      warnings,
      shortcuts: shortcutReport,
      version: app.getVersion()
    };
  }

  function sendState(win) {
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send('state', buildState());
    } catch (_) {
      /* ignore */
    }
  }

  let stateSig = '';
  function pushState(force) {
    const state = buildState();
    const sig = JSON.stringify({
      url: state.url,
      online: state.online,
      total: state.total,
      paused: state.paused,
      ended: state.ended,
      qr: state.qr.length,
      displays: state.displays.map((d) => d.id).join(','),
      selected: state.selectedDisplay,
      overlayVisible: state.overlayVisible,
      joinVisible: state.joinVisible,
      config: state.config,
      warnings: state.warnings,
      nics: state.nics
    });
    if (!force && sig === stateSig) return;
    stateSig = sig;
    for (const win of [controlWin, joinWin, cloudWin]) {
      if (win && !win.isDestroyed()) {
        try {
          win.webContents.send('state', state);
        } catch (_) {
          /* ignore */
        }
      }
    }
    updateTray();
  }

  /* --------------------------------------------------------------- 窗口 */

  function createControlWindow() {
    // 按屏幕可用高度自适应：小屏笔记本上别把底部裁掉
    const area = screen.getPrimaryDisplay().workAreaSize;
    const height = Math.max(620, Math.min(880, area.height - 50));
    const width = Math.min(480, Math.max(420, area.width - 80));

    controlWin = new BrowserWindow({
      width,
      height,
      minWidth: 400,
      minHeight: 520,
      frame: false,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      backgroundColor: '#12141a',
      show: false,
      alwaysOnTop: true,
      title: '培训弹幕互动',
      icon: path.join(ASSETS_DIR, 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload-control.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false
      }
    });

    controlWin.loadFile(path.join(RENDERER_DIR, 'control', 'index.html'));
    controlWin.once('ready-to-show', () => {
      if (!IS_SMOKE) controlWin.show();
    });
    controlWin.on('close', (event) => {
      if (quitting) return;
      event.preventDefault();
      controlWin.hide();
    });
  }

  function createOverlay() {
    const d = targetDisplay();
    overlayWin = new BrowserWindow({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      roundedCorners: false,
      alwaysOnTop: true,
      show: false,
      title: '弹幕层',
      webPreferences: {
        preload: path.join(__dirname, 'preload-danmaku.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    });

    overlayWin.setAlwaysOnTop(true);

    overlayWin.loadFile(path.join(RENDERER_DIR, 'danmaku', 'index.html'));

    overlayWin.once('ready-to-show', () => {
      if (IS_SMOKE) return;

      overlayWin.showInactive(); // 不用 show()：否则会把焦点从幻灯片抢走

      overlayWin.setIgnoreMouseEvents(true, { forward: true });

      overlayWin.setAlwaysOnTop(true);

      overlayWin.moveTop();

    });

    overlayWin.on('closed', () => {
      overlayWin = null;
    });
  }

  function applyDisplayToOverlay() {
    const d = targetDisplay();
    for (const win of [overlayWin, joinWin, cloudWin]) {
      if (win && !win.isDestroyed()) win.setBounds(d.bounds);
    }
  }

  /* --------------------------------------------------------- 投屏引导页 */

  let joinWanted = false;

  function createJoinWindow() {
    const d = targetDisplay();
    joinWin = new BrowserWindow({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      backgroundColor: '#0b0d12',
      title: '投屏引导页',
      webPreferences: {
        preload: path.join(__dirname, 'preload-join.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    });

    joinWin.loadFile(path.join(RENDERER_DIR, 'join', 'index.html'));
    joinWin.on('closed', () => {
      joinWin = null;
      joinWanted = false;
    });
    // 等页面首帧出来再显示，避免开场时闪一下白屏
    joinWin.once('ready-to-show', () => {
      if (IS_SMOKE || !joinWanted) return;
      joinWin.show();
      joinWin.focus();
      sendState(joinWin);
      joinWin.moveTop();
      pushState();
    });
  }

  function toggleJoinScreen(force) {
    const shouldShow = force === undefined ? !joinWanted : Boolean(force);
    joinWanted = shouldShow;

    if (!shouldShow) {
      if (joinWin && !joinWin.isDestroyed()) joinWin.hide();
      pushState();
      return;
    }

    if (!joinWin || joinWin.isDestroyed()) {
      createJoinWindow();
      return; // 显示和推状态都在 ready-to-show 里
    }

    joinWin.setBounds(targetDisplay().bounds);
    if (!IS_SMOKE) {
      joinWin.show();
      joinWin.focus();
    }
    // 显示之后再推一次状态：窗口隐藏期间 Chromium 不重绘，先推会看到空白首帧
    sendState(joinWin);
    joinWin.moveTop();
    pushState();
  }

  /* ------------------------------------------------------------- 词云窗口 */

  function createCloudWindow() {
    const d = targetDisplay();
    cloudWin = new BrowserWindow({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      focusable: false,
      backgroundColor: '#06100e',
      title: '词云',
      webPreferences: {
        preload: path.join(__dirname, 'preload-cloud.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    });

    cloudWin.loadFile(path.join(RENDERER_DIR, 'cloud', 'index.html'));
    cloudWin.on('closed', () => {
      cloudWin = null;
    });
    cloudWin.once('ready-to-show', () => {
      if (IS_SMOKE) return;
      cloudWin.showInactive();
      // 大屏页面不拦鼠标，讲师仍然可以点到背后的 PPT
      cloudWin.setIgnoreMouseEvents(true, { forward: true });
      sendState(cloudWin);
      cloudWin.moveTop();
    });
  }

  /**
   * 光标轮询：Windows 上 setIgnoreMouseEvents(true, {forward:true}) 的 mousemove 并不总能送达
   * （实测这台机器就收不到），悬停判定改由主进程按 30Hz 读光标位置推给渲染层。
   */
  let cursorTimer = null;
  let lastCursor = { x: -1, y: -1 };

  function startCursorWatch() {
    if (cursorTimer) return;
    let wasDown = false;
    cursorTimer = setInterval(() => {
      // 按键状态不受窗口可见性影响，先取，避免漏掉按下边沿
      const down = isLeftButtonDown();
      const pressed = down && !wasDown;
      wasDown = down;

      if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
      if (store.get().mode !== 'scroll') return;
      const point = screen.getCursorScreenPoint();
      const bounds = overlayWin.getBounds();
      const x = point.x - bounds.x;
      const y = point.y - bounds.y;
      if (x !== lastCursor.x || y !== lastCursor.y) {
        lastCursor = { x, y };
        try {
          overlayWin.webContents.send('dm:cursor', { x, y });
        } catch (_) {
          /* ignore */
        }
      }
      if (pressed) {
        try {
          overlayWin.webContents.send('dm:click', { x, y });
        } catch (_) {
          /* ignore */
        }
      }
    }, 33);
  }

  /** 在「滚动弹幕」与「词云」之间切换投影内容 */
  function applyMode() {    const cloud = store.get().mode === 'cloud';

    if (cloud) {
      if (!cloudWin || cloudWin.isDestroyed()) {
        createCloudWindow();
      } else {
        cloudWin.setBounds(targetDisplay().bounds);
        if (!IS_SMOKE && !cloudWin.isVisible()) {
          cloudWin.showInactive();
          cloudWin.setIgnoreMouseEvents(true, { forward: true });
        }
        cloudWin.moveTop();
      }
      if (overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
    } else {
      if (cloudWin && !cloudWin.isDestroyed()) cloudWin.hide();
      if (overlayWin && !overlayWin.isDestroyed() && overlayVisible) {
        overlayWin.showInactive();
        overlayWin.setIgnoreMouseEvents(true, { forward: true });
        overlayWin.moveTop();
      }
    }
    pushState();
  }

  function onDisplaysChanged() {
    collectDisplays();
    const saved = store.get().displayId;
    if (saved && !screen.getAllDisplays().some((d) => String(d.id) === String(saved))) {
      store.set({ displayId: null });
    }
    applyDisplayToOverlay();
    pushState();
  }

  function applyThemeBackground() {
    const theme = store.get().theme;
    const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
    const bg = dark ? '#12141a' : '#f4f5f8';
    for (const win of [controlWin, joinWin]) {
      if (win && !win.isDestroyed()) {
        try {
          win.setBackgroundColor(bg);
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  function showControl() {
    if (!controlWin || controlWin.isDestroyed()) return;
    controlWin.show();
    controlWin.focus();
  }

  function toggleOverlay() {
    overlayVisible = !overlayVisible;
    if (overlayWin && !overlayWin.isDestroyed()) {
      if (overlayVisible) {
        overlayWin.showInactive();
        overlayWin.setIgnoreMouseEvents(true, { forward: true });
        overlayWin.moveTop();
      } else {
        overlayWin.hide();
      }
    }
    pushState();
  }

  /* --------------------------------------------------------------- 托盘 */

  function createTray() {
    let icon = nativeImage.createFromPath(path.join(ASSETS_DIR, 'tray.png'));
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
    tray = new Tray(icon);
    tray.setToolTip('培训弹幕互动');
    tray.on('click', showControl);
    updateTray();
  }

  let traySig = '';
  function updateTray() {
    if (!tray || tray.isDestroyed()) return;
    const sig = JSON.stringify({ token: session ? session.token : '', online, paused, overlayVisible });
    if (sig === traySig) return;
    traySig = sig;
    const menu = Menu.buildFromTemplate([
      { label: session ? `房间 ${session.token} · 在线 ${online} 人` : '未开始', enabled: false },
      { type: 'separator' },
      { label: '显示控制面板', click: showControl },
      { label: paused ? '恢复弹幕' : '暂停弹幕', click: togglePause, enabled: Boolean(session) },
      { label: '清屏', click: clearScreen, enabled: Boolean(session) },
      { label: store.get().mode === 'cloud' ? '切回滚动弹幕' : '切换到词云', click: toggleMode },
      { label: overlayVisible ? '隐藏弹幕层' : '显示弹幕层', click: toggleOverlay },
      { type: 'separator' },
      { label: '结束培训', click: () => endSessionWithConfirm(), enabled: Boolean(session) },
      { label: '退出', click: () => { quitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(menu);
    tray.setToolTip(session ? `培训弹幕互动 · 在线 ${online} 人` : '培训弹幕互动');
  }

  /* --------------------------------------------------------- 快捷键/动作 */

  function registerShortcuts() {
    const defs = [
      ['Control+Alt+Space', () => togglePause()],
      ['Control+Alt+X', () => clearScreen()],
      ['Control+Alt+J', () => toggleJoinScreen()],
      ['Control+Alt+K', () => toggleMode()],
      ['Control+Alt+G', () => closeBigImage()],
      ['Control+Alt+M', () => (controlWin.isVisible() ? controlWin.hide() : showControl())]
    ];
    for (const [accel, fn] of defs) {
      try {
        shortcutReport[accel] = globalShortcut.register(accel, fn);
      } catch (_) {
        shortcutReport[accel] = false;
      }
    }
  }

  function togglePause() {
    if (!session) return;
    paused = !paused;
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.send('dm:cmd', { type: paused ? 'pause' : 'resume' });
    }
    if (bridge) bridge.broadcast({ type: 'paused', paused });
    pushState();
  }

  function clearScreen() {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('dm:cmd', { type: 'clear' });
  }

  /** 兜底：大图卡住时用 Ctrl+Alt+G 关掉并把鼠标穿透恢复回去 */
  function closeBigImage() {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    overlayWin.webContents.send('dm:cmd', { type: 'closeModal' });
    try {
      overlayWin.setIgnoreMouseEvents(true, { forward: true });
    } catch (_) {
      /* ignore */
    }
  }

  function toggleMode() {
    store.set({ mode: store.get().mode === 'cloud' ? 'scroll' : 'cloud' });
    applyMode();
    pushState();
  }

  async function endSessionWithConfirm() {
    if (!session) return;
    const result = await msgBox({
      type: 'warning',
      buttons: ['结束培训', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '结束培训',
      message: '结束本次培训？',
      detail: '将关闭手机端连接并清空内存中的全部消息（未导出的数据无法找回）。'
    });
    if (result.response !== 0) return;
    await endSession();
  }

  /* --------------------------------------------------------------- 导出 */

  function msgBox(options) {
    if (controlWin && !controlWin.isDestroyed()) return dialog.showMessageBox(controlWin, options);
    return dialog.showMessageBox(options);
  }

  function saveDialog(options) {
    if (controlWin && !controlWin.isDestroyed()) return dialog.showSaveDialog(controlWin, options);
    return dialog.showSaveDialog(options);
  }

  function openDialog(options) {
    if (controlWin && !controlWin.isDestroyed()) return dialog.showOpenDialog(controlWin, options);
    return dialog.showOpenDialog(options);
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  }

  function csvCell(value) {
    const s = String(value == null ? '' : value);
    return `"${s.replace(/"/g, '""')}"`;
  }

  async function exportHistory() {
    if (!history.length) {
      msgBox({
        type: 'info',
        message: '还没有收到任何消息',
        buttons: ['好']
      });
      return;
    }
    const when = stamp();
    const { canceled, filePath } = await saveDialog({
      title: '导出本次弹幕记录',
      defaultPath: path.join(app.getPath('downloads'), `弹幕记录_${when}.json`),
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'CSV', extensions: ['csv'] }
      ]
    });
    if (canceled || !filePath) return;

    try {
      if (filePath.toLowerCase().endsWith('.csv')) {
        const lines = ['序号,时间,类型,内容'];
        for (const m of history) {
          const time = new Date(m.ts).toLocaleString('zh-CN', { hour12: false });
          const content = m.contentType === 'image' ? '［图片，CSV 中省略，如需图片请导出 JSON］' : m.payload;
          lines.push([m.seq, time, m.contentType === 'image' ? '图片' : '文字', content].map(csvCell).join(','));
        }
        fs.writeFileSync(filePath, '\uFEFF' + lines.join('\r\n'), 'utf8');
      } else {
        const payload = {
          exportedAt: new Date().toISOString(),
          room: session ? { token: session.token, port: session.port } : null,
          count: history.length,
          messages: history.map((m) => ({
            seq: m.seq,
            time: new Date(m.ts).toISOString(),
            contentType: m.contentType,
            content: m.payload
          }))
        };
        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
      }
      msgBox({
        type: 'info',
        message: '导出完成',
        detail: filePath,
        buttons: ['好']
      });
    } catch (err) {
      msgBox({
        type: 'error',
        message: '导出失败',
        detail: err.message,
        buttons: ['好']
      });
    }
  }

  /* --------------------------------------------------------------- IPC */

  function registerIpc() {
    ipcMain.handle('state:get', () => buildState());

    ipcMain.handle('session:togglePause', () => {
      togglePause();
      return buildState();
    });

    ipcMain.handle('session:clear', () => {
      clearScreen();
      return true;
    });

    ipcMain.handle('session:end', async () => {
      await endSessionWithConfirm();
      return buildState();
    });

    ipcMain.handle('session:restart', async () => {
      await restartSession();
      return buildState();
    });

    ipcMain.handle('app:copy', () => {
      if (!session) return false;
      clipboard.writeText(session.url);
      return true;
    });

    // 页脚的 GitHub 胶囊按钮
    ipcMain.handle('app:openRepo', async () => {
      try {
        await shell.openExternal('https://github.com/delaolao/LocalDanMu');
        return true;
      } catch (_) {
        return false;
      }
    });

    ipcMain.handle('app:export', async () => {
      await exportHistory();
      return true;
    });

    ipcMain.handle('app:setConfig', (_e, patch) => {
      store.set(patch);
      if (patch && 'intervalSec' in patch && bridge) {
        bridge.broadcast({ type: 'config', intervalSec: store.get().intervalSec });
      }
      if (patch && 'theme' in patch) applyThemeBackground();
      if (patch && ('filterLevel' in patch || 'customWords' in patch)) rebuildFilter();
      if (patch && 'mode' in patch) applyMode();
      if (overlayWin && !overlayWin.isDestroyed()) {
        overlayWin.webContents.send('dm:cmd', { type: 'config', config: store.get() });
      }
      if (joinWin && !joinWin.isDestroyed()) sendState(joinWin);
      pushState();
      return store.get();
    });

    ipcMain.handle('app:setDisplay', (_e, id) => {
      const all = screen.getAllDisplays();
      const hit = all.find((d) => String(d.id) === String(id));
      if (hit) {
        store.set({ displayId: hit.id });
        applyDisplayToOverlay();
        if (overlayWin && !overlayWin.isDestroyed() && overlayVisible) overlayWin.moveTop();
      }
      pushState();
      return buildState();
    });

    ipcMain.handle('app:setNic', async (_e, address) => {
      store.set({ preferredIp: address || null });
      profileCache = { at: 0, list: [] };
      await refreshNetwork();
      if (session) {
        session.url = buildUrl(session.ip, session.port, session.token);
        await refreshQr();
      }
      pushState(true);
      return buildState();
    });

    ipcMain.handle('app:refreshNetwork', async () => {
      profileCache = { at: 0, list: [] };
      await refreshNetwork();
      if (session) {
        session.url = buildUrl(session.ip, session.port, session.token);
        await refreshQr();
      }
      pushState(true);
      return buildState();
    });

    ipcMain.handle('app:openNetworkSettings', async () => {
      try {
        await shell.openExternal('ms-settings:network-status');
      } catch (_) {
        /* ignore */
      }
      return true;
    });

    ipcMain.handle('app:toggleOverlay', () => {
      toggleOverlay();
      return buildState();
    });

    ipcMain.handle('app:toggleJoin', () => {
      toggleJoinScreen();
      return buildState();
    });

    ipcMain.handle('app:setMode', (_e, mode) => {
      store.set({ mode: mode === 'cloud' ? 'cloud' : 'scroll' });
      applyMode();
      pushState();
      return buildState();
    });

    ipcMain.handle('history:get', () => ({ items: publicHistory(200), total }));

    ipcMain.handle('session:replay', (_e, seq) => replayItem(Number(seq)));

    ipcMain.handle('app:importWords', async () => {
      const res = await openDialog({
        title: '导入自定义词表（一行一个）',
        properties: ['openFile'],
        filters: [
          { name: '词表', extensions: ['txt', 'csv'] },
          { name: '全部文件', extensions: ['*'] }
        ]
      });
      if (res.canceled || !res.filePaths.length) return null;
      try {
        const raw = fs.readFileSync(res.filePaths[0], 'utf8');
        const incoming = raw
          .split(/[\r\n,，、;；]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 2000);
        const existing = (store.get().customWords || '')
          .split(/[\r\n,，、;；]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        const merged = Array.from(new Set(existing.concat(incoming)));
        store.set({ customWords: merged.join('\n').slice(0, 6000) });
        rebuildFilter();
        pushState();
        return { added: Math.max(0, merged.length - existing.length), total: merged.length };
      } catch (err) {
        return { error: err.message };
      }
    });

    ipcMain.handle('join:close', () => {
      toggleJoinScreen(false);
      return true;
    });

    // 鼠标悬停到图片上时才接管鼠标，其余时间保持点击穿透
    ipcMain.on('dm:hover', (event, on) => {
      if (!overlayWin || overlayWin.isDestroyed()) return;
      if (event.sender !== overlayWin.webContents) return;
      if (IS_PROBE) probeLog.push({ t: Date.now(), evt: 'hover', on: Boolean(on) });
      try {
        overlayWin.setIgnoreMouseEvents(!on, { forward: true });
      } catch (_) {
        /* ignore */
      }
    });

    // 大图模式：整个屏幕都要能点（点任意位置关闭）
    ipcMain.on('dm:modal', (event, open) => {
      if (!overlayWin || overlayWin.isDestroyed()) return;
      if (event.sender !== overlayWin.webContents) return;
      if (IS_PROBE) probeLog.push({ t: Date.now(), evt: 'modal', open: Boolean(open) });
      try {
        overlayWin.setIgnoreMouseEvents(!open, { forward: true });
      } catch (_) {
        /* ignore */
      }
    });

    ipcMain.handle('app:hidePanel', () => {
      if (controlWin && !controlWin.isDestroyed()) controlWin.hide();
      return true;
    });

    ipcMain.handle('app:quit', () => {
      quitting = true;
      app.quit();
      return true;
    });

    ipcMain.handle('app:minimize', () => {
      if (controlWin && !controlWin.isDestroyed()) controlWin.minimize();
      return true;
    });

    ipcMain.on('dm:ready', (event) => {
      if (!overlayWin || overlayWin.isDestroyed()) return;
      if (event.sender !== overlayWin.webContents) return;
      overlayWin.webContents.send('dm:cmd', { type: 'config', config: store.get() });
      if (paused) overlayWin.webContents.send('dm:cmd', { type: 'pause' });
    });
  }

  /* --------------------------------------------------------- 诊断/冒烟 */

  function hookRendererDiagnostics() {
    app.on('web-contents-created', (_event, contents) => {
      // Electron 45 用单个 Event 参数；保留旧版三元组兼容。
      contents.on('console-message', function (event) {
        let level = event && event.level;
        let message = event && event.message;
        if (level === undefined) {
          level = arguments[1];
          message = arguments[2];
        }
        const isError = level === 'error' || level === 3;
        if (isError) {
          rendererLogs.push(String(message).slice(0, 400));
          if (IS_SMOKE || IS_DEV) console.error('[renderer]', message);
        }
      });
      contents.on('render-process-gone', (_e, details) => {
        rendererLogs.push(`render-process-gone: ${details && details.reason}`);
      });
      contents.on('preload-error', (_e, preloadPath, error) => {
        rendererLogs.push(`preload-error ${preloadPath}: ${error && error.message}`);
      });
    });
  }

  async function feedSmokeItems() {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const items = [
      { seq: 1, contentType: 'text', payload: '大家好，这是第一条弹幕', color: '#ffe066', ts: Date.now() },
      {
        seq: 2,
        contentType: 'text',
        payload:
          '这是一条很长的弹幕，用来验证超长文本会被截断而不是撑破屏幕，现场同学的名字和问题都会出现在这里',
        color: '#7cc4ff',
        ts: Date.now()
      },
      { seq: 3, contentType: 'text', payload: 'Emoji 测试 🎉👍 支持', color: '#7ee787', ts: Date.now() }
    ];
    try {
      const png = path.join(APP_DIR, 'scripts', 'fixtures', 'test-image.png');
      if (fs.existsSync(png)) {
        items.push({
          seq: 4,
          contentType: 'image',
          payload: `data:image/png;base64,${fs.readFileSync(png).toString('base64')}`,
          ts: Date.now()
        });
      }
    } catch (_) {
      /* 没有测试图就跳过 */
    }
    for (const item of items) overlayWin.webContents.send('dm:item', item);
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  async function captureWindow(win, filename) {
    if (!win || win.isDestroyed()) return null;
    // 刚改过 DOM 的窗口可能还没合成新帧，先强制重绘一次再截
    try {
      win.webContents.invalidate();
    } catch (_) {
      /* ignore */
    }
    await delay(200);
    const shot = await Promise.race([
      win.webContents.capturePage(),
      new Promise((r) => setTimeout(() => r(null), 2500))
    ]);
    if (!shot) return null;
    const png = shot.toPNG();
    if (!png || png.length < 1000) return null;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, filename);
    fs.writeFileSync(file, png);
    return file;
  }

  async function captureCanvas(name) {
    if (!overlayWin || overlayWin.isDestroyed()) return null;
    const dataUrl = await overlayWin.webContents.executeJavaScript(
      "document.getElementById('stage').toDataURL('image/png')"
    );
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, Buffer.from(String(dataUrl).split(',')[1] || '', 'base64'));
    return file;
  }

  /**
   * 临时诊断：放一张图到屏幕上并停住，把它的位置写出来；
   * 外部脚本用真实鼠标事件点击它，8 秒后回报大图有没有打开。
   */
  function runClickProbe() {
    const outDir = OUT_DIR;
    fs.mkdirSync(outDir, { recursive: true });
    const step = (ms) => new Promise((r) => setTimeout(r, ms));

    (async () => {
      await step(1200);
      if (!overlayWin || overlayWin.isDestroyed()) throw new Error('no overlay');
      // 内嵌一张 8x8 的图，保证打包版（asar 里没有 scripts/）也能跑
      const probePng =
        'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGPUqDjBgA0wYRUdtBIAHOcBeDC+JtEAAAAASUVORK5CYII=';
      overlayWin.webContents.send('dm:item', {
        contentType: 'image',
        payload: `data:image/png;base64,${probePng}`
      });
      await step(1400);
      overlayWin.webContents.send('dm:cmd', { type: 'pause' });
      await step(400);
      const rects = await overlayWin.webContents.executeJavaScript('window.__dmDebug.images()');
      const bounds = overlayWin.getBounds();
      const scale = screen.getPrimaryDisplay().scaleFactor;
      let click = null;
      if (rects.length) {
        const r0 = rects[0];
        const cx = bounds.x + r0.x + r0.w / 2;
        const cy = bounds.y + r0.y + r0.h / 2;
        click = { dipX: cx, dipY: cy, px: Math.round(cx * scale), py: Math.round(cy * scale) };
      }
      fs.writeFileSync(path.join(outDir, 'probe-rect.json'), JSON.stringify({ rects, bounds, scale, click }));

      // 用注入事件模拟"鼠标移到图片上"；LDM_PROBE_INJECT=0 时只用真实鼠标
      if (rects.length && process.env.LDM_PROBE_INJECT !== '0') {
        const rect = rects[0];
        overlayWin.webContents.sendInputEvent({
          type: 'mouseMove',
          x: Math.round(rect.x + rect.w / 2),
          y: Math.round(rect.y + rect.h / 2)
        });
      }

      // 等真实鼠标挪上来，抓一张"悬停提示"的图
      for (let i = 0; i < 50; i += 1) {
        const hovering = await overlayWin.webContents.executeJavaScript('window.__dmDebug.hovering()');
        if (hovering) {
          await step(260); // 等一帧把"点击放大"标签画上去
          const dataUrl = await overlayWin.webContents.executeJavaScript(
            "document.getElementById('stage').toDataURL('image/png')"
          );
          fs.writeFileSync(
            path.join(outDir, 'probe-hover.png'),
            Buffer.from(String(dataUrl).split(',')[1] || '', 'base64')
          );
          break;
        }
        await step(100);
      }

      await step(6000);
      const state = await overlayWin.webContents.executeJavaScript(`(() => ({
        modalOpen: window.__dmDebug.modalOpen(),
        clicks: window.__dmDebug.clicks,
        lastClick: window.__dmDebug.lastClick
      }))()`);
      fs.writeFileSync(
        path.join(outDir, 'probe-result.json'),
        JSON.stringify({
          ...state,
          cursor: screen.getCursorScreenPoint(),
          visible: overlayWin.isVisible(),
          log: probeLog
        })
      );
      quitting = true;
      app.quit();
    })().catch((err) => {
      try {
        fs.writeFileSync(path.join(outDir, 'probe-result.json'), JSON.stringify({ error: String(err) }));
      } catch (_) {
        /* ignore */
      }
      quitting = true;
      app.quit();
    });
  }

  async function finishSmoke() {
    const result = {
      ok: false,
      rendererErrors: [],
      session: session ? { port: session.port, ip: session.ip, token: session.token, url: session.url } : null,
      online,
      qrLength: qrDataUrl.length,
      displays: displays.map((d) => d.label),
      warnings,
      shortcuts: shortcutReport,
      ui: null,
      snapshot: null,
      settingsPath: store.path,
      diag: false
    };

    // 填一份演示用的 WiFi，让截图里能看到这块 UI（结束时清掉）
    store.set({ wifiSsid: 'Training-5G', wifiPassword: 'danmu2026' });
    pushState(true);
    await delay(150);

    try {
      if (controlWin && !controlWin.isDestroyed()) {
        await controlWin.webContents.executeJavaScript('console.error("__smoke_probe__"); true');
        await new Promise((r) => setTimeout(r, 250));
        result.ui = await controlWin.webContents.executeJavaScript(`(() => ({
          url: document.getElementById('url').textContent,
          qrLen: (document.getElementById('qr').src || '').length,
          online: document.getElementById('online').textContent,
          room: document.getElementById('room').textContent,
          displays: document.getElementById('displaySel').options.length,
          nics: document.getElementById('nicSel').options.length,
          warnings: document.getElementById('warnings').textContent.trim().slice(0, 120),
          pauseLabel: document.getElementById('pauseBtn').textContent,
          theme: document.getElementById('themeSel') ? document.getElementById('themeSel').value : null,
          version: document.getElementById('versionChip').textContent,
          hasWifiInputs: Boolean(document.getElementById('ssidInput') && document.getElementById('pwdInput')),
          hasLogList: Boolean(document.getElementById('logList')),
          joinLabel: document.getElementById('joinBtn').textContent
        }))()`);
      }
    } catch (err) {
      rendererLogs.push('ui-probe: ' + err.message);
    }

    result.diag = rendererLogs.some((line) => line.includes('__smoke_probe__'));

    try {
      if (overlayWin && !overlayWin.isDestroyed()) {
        result.snapshot = await captureCanvas('danmaku.png');
      }
    } catch (err) {
      rendererLogs.push('snapshot: ' + err.message);
    }

    // 图片点击 → 暂停滚动 + 居中大图 → 再点一下关闭
    try {
      if (overlayWin && !overlayWin.isDestroyed()) {
        const rect = await overlayWin.webContents.executeJavaScript(
          '(() => { const list = window.__dmDebug ? window.__dmDebug.images() : []; return list[0] || null; })()'
        );
        if (rect) {
          const cx = Math.round(rect.x + rect.w / 2);
          const cy = Math.round(rect.y + rect.h / 2);
          overlayWin.webContents.sendInputEvent({ type: 'mouseMove', x: cx, y: cy });
          await delay(120);
          overlayWin.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
          overlayWin.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
          await delay(280);
          const opened = await overlayWin.webContents.executeJavaScript('window.__dmDebug.modalOpen()');
          const shot = await captureCanvas('danmaku-modal.png');

          // 等过"双击保护"窗口（550ms）再点第二下，否则会被当成双击而忽略
          await delay(650);
          overlayWin.webContents.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 });
          overlayWin.webContents.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 });
          await delay(220);
          const closed = !(await overlayWin.webContents.executeJavaScript('window.__dmDebug.modalOpen()'));

          result.imageModal = { opened: Boolean(opened), closed: Boolean(closed), shot };
        } else {
          result.imageModal = { skipped: true };
        }
      }
    } catch (err) {
      result.notes = result.notes || [];
      result.notes.push('image-modal: ' + err.message);
    }

    try {
      if (controlWin && !controlWin.isDestroyed()) {
        // 隐藏窗口 capturePage 拿不到内容，冒烟模式下短暂显示一下再截。
        controlWin.showInactive();
        await delay(350);

        store.set({ theme: 'dark' });
        applyThemeBackground();
        pushState(true);
        await delay(300);
        result.controlShot = await captureWindow(controlWin, 'control.png');
        result.controlDarkTheme = await controlWin.webContents.executeJavaScript(
          'document.documentElement.dataset.theme'
        );

        // 展开设置面板截一张，确认主题/网卡/WiFi 这些控件都在
        await controlWin.webContents.executeJavaScript("document.getElementById('settings').open = true; true");
        await delay(250);
        result.controlSettingsShot = await captureWindow(controlWin, 'control-settings.png');
        await controlWin.webContents.executeJavaScript("document.getElementById('settings').open = false; true");

        store.set({ theme: 'light' });
        applyThemeBackground();
        pushState(true);
        await delay(300);
        result.controlLightShot = await captureWindow(controlWin, 'control-light.png');
        result.controlTheme = await controlWin.webContents.executeJavaScript(
          'document.documentElement.dataset.theme'
        );

        store.set({ theme: 'system' });
        applyThemeBackground();
        pushState(true);
        await delay(150);
        controlWin.hide();
      }
    } catch (err) {
      result.notes = result.notes || [];
      result.notes.push('control-shot: ' + err.message);
    }

    // 投屏引导页：填一个 WiFi 账密，确认页面上真的显示出来了
    try {
      store.set({ wifiSsid: 'Training-5G', wifiPassword: 'danmu2026' });
      toggleJoinScreen(true);
      if (joinWin && !joinWin.isDestroyed()) {
        joinWin.show();
        joinWin.focus();
        sendState(joinWin);
        await delay(400);
        try {
          joinWin.webContents.invalidate();
        } catch (_) {
          /* ignore */
        }
        await delay(700);
        result.joinVisible = joinWin.isVisible();
        result.join = await joinWin.webContents.executeJavaScript(`(() => ({
          url: document.getElementById('url').textContent,
          ssid: document.getElementById('ssid').textContent,
          pwd: document.getElementById('pwd').textContent,
          wifiHidden: document.getElementById('wifi').hidden,
          qrLoaded: document.getElementById('qr').complete && document.getElementById('qr').naturalWidth > 0,
          theme: document.documentElement.dataset.theme
        }))()`);
        result.joinShot = await captureWindow(joinWin, 'join.png');
        joinWin.hide();
      }
      toggleJoinScreen(false);
    } catch (err) {
      result.notes = result.notes || [];
      result.notes.push('join-screen: ' + err.message);
    }

    // 端到端：用真实浏览器窗口打开观众页 → 发一条消息 → 看服务端和弹幕层是否收到
    try {
      if (session) {
        const viewer = new BrowserWindow({
          width: 390,
          height: 844,
          show: false,
          title: 'viewer-smoke',
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
        });
        await viewer.loadURL(session.url);
        await new Promise((r) => setTimeout(r, 700));

        const onlineAfterJoin = online;
        await viewer.webContents.executeJavaScript(`(() => {
          const input = document.getElementById('input');
          input.value = '冒烟测试消息：来自观众端';
          input.dispatchEvent(new Event('input'));
          document.getElementById('sendBtn').click();
          return true;
        })()`);
        await new Promise((r) => setTimeout(r, 700));

        const viewerInfo = await viewer.webContents.executeJavaScript(`(() => ({
          status: document.getElementById('status').textContent,
          counter: document.getElementById('counter').textContent,
          hint: document.getElementById('hint').textContent,
          sendLabel: document.getElementById('sendBtn').textContent,
          ended: !document.getElementById('ended').hidden,
          feedCount: document.querySelectorAll('#feedList .msg').length,
          feedEmptyHidden: document.getElementById('feedEmpty').hidden,
          feedLast: (function () {
            const last = document.querySelector('#feedList .msg:last-child .msg-bubble');
            return last ? last.textContent : '';
          })()
        }))()`);

        viewer.showInactive();
        await delay(300);

        // 深色：验证 CSS 变量 + head 里的主题引导脚本
        await viewer.webContents.executeJavaScript("localStorage.setItem('dm_theme','dark'); location.reload(); true");
        await delay(900);
        result.viewerDarkShot = await captureWindow(viewer, 'viewer-dark.png');

        await viewer.webContents.executeJavaScript("localStorage.setItem('dm_theme','light'); location.reload(); true");
        await delay(900);
        result.viewerLightShot = await captureWindow(viewer, 'viewer-light.png');
        result.viewerTheme = await viewer.webContents.executeJavaScript(
          'document.documentElement.dataset.theme'
        );
        viewer.destroy();

        result.viewer = { ...viewerInfo, onlineAfterJoin, total };
        result.viewerTotal = total;
        result.viewerOnline = onlineAfterJoin;
      }
    } catch (err) {
      result.notes = result.notes || [];
      result.notes.push('viewer: ' + err.message);
    }

    // 词云模式：灌几条演示消息，切过去看词云和回溯列表
    try {
      const demo = ['太难了', '太快了', '一般', '太难了', '满意', '跟不上', '太难了', '需要复习'];
      demo.forEach((text, i) => {
        handleIncoming({
          seq: 9000 + i,
          contentType: 'text',
          payload: text,
          color: '#ffe066',
          ts: Date.now(),
          flagged: false
        });
      });
      store.set({ mode: 'cloud' });
      applyMode();
      await delay(900);
      if (cloudWin && !cloudWin.isDestroyed()) {
        cloudWin.showInactive();
        await delay(700);
        result.cloud = await cloudWin.webContents.executeJavaScript(`(() => ({
          feed: document.querySelectorAll('.feed-item').length,
          emptyHidden: document.getElementById('empty').hidden,
          canvasW: document.getElementById('cloud').width,
          sub: document.getElementById('sub').textContent
        }))()`);
        result.cloudShot = await captureWindow(cloudWin, 'cloud.png');
        cloudWin.hide();
      }
      store.set({ mode: 'scroll' });
      applyMode();

      // 再截一张控制面板，确认"最近弹幕"列表里已经有内容
      if (controlWin && !controlWin.isDestroyed()) {
        controlWin.showInactive();
        await delay(300);
        result.controlLogShot = await captureWindow(controlWin, 'control-log.png');
        controlWin.hide();
      }
    } catch (err) {
      result.notes = result.notes || [];
      result.notes.push('cloud: ' + err.message);
    }

    // 生命周期自检：暂停 → 恢复 → 结束 → 重新开始
    try {
      const lifecycle = {};
      togglePause();
      lifecycle.paused = paused === true;
      togglePause();
      lifecycle.resumed = paused === false;

      const oldToken = session ? session.token : null;
      await endSession();
      lifecycle.ended = ended === true && session === null && bridge === null && total === 0;

      await restartSession();
      lifecycle.restarted = ended === false && Boolean(session) && Boolean(bridge);
      lifecycle.newToken = Boolean(session && session.token && session.token !== oldToken);
      result.lifecycle = lifecycle;
    } catch (err) {
      result.notes = result.notes || [];
      result.notes.push('lifecycle: ' + err.message);
    }

    result.rendererErrors = rendererLogs.filter((line) => !line.includes('__smoke_probe__'));

    // 清掉演示用的 WiFi，别写进真实配置
    store.set({ wifiSsid: '', wifiPassword: '' });
    const lifeOk = result.lifecycle && Object.values(result.lifecycle).every((v) => v === true);
    const modalOk = !result.imageModal || result.imageModal.skipped || (result.imageModal.opened && result.imageModal.closed);
    const joinOk =
      !result.join || (Boolean(result.join.url) && result.join.ssid === 'Training-5G' && result.join.wifiHidden === false);
    const themeOk =
      result.controlTheme === 'light' && result.controlDarkTheme === 'dark' && result.viewerTheme === 'light';
    const cloudOk =
      result.cloud && result.cloud.feed > 0 && result.cloud.emptyHidden === true && result.cloud.canvasW > 0;
    result.ok =
      result.rendererErrors.length === 0 &&
      result.diag === true &&
      Boolean(result.session) &&
      Boolean(lifeOk) &&
      Boolean(modalOk) &&
      Boolean(joinOk) &&
      Boolean(themeOk) &&
      Boolean(cloudOk);

    try {
      const outDir = OUT_DIR;
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'smoke-result.json'), JSON.stringify(result, null, 2));
    } catch (_) {
      /* ignore */
    }

    console.log('SMOKE_RESULT ' + JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
    quitting = true;
    app.quit();
  }
}
