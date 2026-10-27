'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.api;

  const LOG_MAX = 200;

  let state = null;
  let logs = [];
  let toastTimer = null;
  let wifiTimer = null;

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme || 'system';
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2200);
  }

  function setText(id, value) {
    const el = $(id);
    if (!el) return;
    const next = String(value);
    if (el.textContent !== next) el.textContent = next;
  }

  /** 焦点在控件上时不要回写，否则用户正在拖动/输入会被打断 */
  function setControl(id, value) {
    const el = $(id);
    if (!el) return;
    if (document.activeElement === el) return;
    if (String(el.value) !== String(value)) el.value = value;
  }

  function clock(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* ------------------------------------------------------------- 列表 */

  function renderLogs() {
    const list = $('logList');
    setText('logCount', `${logs.length} 条`);

    if (!logs.length) {
      list.innerHTML = '<div class="log-empty">还没有人发弹幕</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of logs) {
      const row = document.createElement('div');
      row.className =
        'log-item' + (item.flagged ? ' flagged' : '') + (item.contentType === 'image' ? ' image' : '');

      const time = document.createElement('span');
      time.className = 'log-time';
      time.textContent = clock(item.ts);
      row.appendChild(time);

      if (item.contentType === 'text' && item.color) {
        const dot = document.createElement('span');
        dot.className = 'log-dot';
        dot.style.background = item.color;
        row.appendChild(dot);
      }

      const text = document.createElement('span');
      text.className = 'log-text';
      text.textContent =
        item.contentType === 'image' ? '［图片］' : (item.flagged ? '⚠ ' : '') + (item.text || '');
      row.appendChild(text);

      const replay = document.createElement('button');
      replay.className = 'log-replay';
      replay.type = 'button';
      replay.title = '重新上屏';
      replay.textContent = '↻';
      replay.addEventListener('click', () => {
        api.replay(item.seq).then((ok) => toast(ok ? '已重新上屏' : '这条已经不在了'));
      });
      row.appendChild(replay);

      frag.appendChild(row);
    }
    list.innerHTML = '';
    list.appendChild(frag);
    list.scrollTop = 0;
  }

  function pushLog(item) {
    logs.unshift(item);
    if (logs.length > LOG_MAX) logs.length = LOG_MAX;
    renderLogs();
  }

  /* ------------------------------------------------------------- 渲染 */

  function renderWarnings(list) {
    const box = $('warnings');
    const items = Array.isArray(list) ? list : [];
    box.innerHTML = '';
    for (const item of items) {
      const div = document.createElement('div');
      div.className = 'warn-item' + (item.level === 'error' ? ' error' : '');
      const text = document.createElement('div');
      text.textContent = item.text;
      div.appendChild(text);
      if (item.action) {
        const btn = document.createElement('button');
        btn.textContent =
          item.action === 'networkSettings' ? '打开网络设置' : item.action === 'settings' ? '去选择网卡' : '重新检测';
        btn.addEventListener('click', () => {
          if (item.action === 'networkSettings') api.openNetworkSettings();
          else if (item.action === 'settings') $('settings').open = true;
          else api.refreshNetwork().then(render).catch(() => toast('检测失败'));
        });
        div.appendChild(btn);
      }
      box.appendChild(div);
    }
  }

  function renderDisplays(list, selected) {
    const sel = $('displaySel');
    const items = Array.isArray(list) ? list : [];
    const sig = items.map((d) => d.id).join(',') + '|' + selected;
    if (sel.dataset.sig === sig) return;
    sel.dataset.sig = sig;
    sel.innerHTML = '';
    for (const d of items) {
      const opt = document.createElement('option');
      opt.value = String(d.id);
      opt.textContent = d.label;
      sel.appendChild(opt);
    }
    sel.value = String(selected);
  }

  function renderNics(list, current) {
    const sel = $('nicSel');
    const items = Array.isArray(list) ? list : [];
    const sig = items.map((n) => n.address).join(',') + '|' + current;
    if (sel.dataset.sig === sig) return;
    sel.dataset.sig = sig;
    sel.innerHTML = '';
    for (const n of items) {
      const opt = document.createElement('option');
      opt.value = n.address;
      opt.textContent = `${n.name} · ${n.address}${n.virtual ? '（虚拟）' : ''}`;
      sel.appendChild(opt);
    }
    if (current) sel.value = current;
  }

  function render(next) {
    if (!next) return;
    state = next;
    const cfg = next.config || {};

    setText('online', next.ended ? 0 : next.online);
    setText('total', next.total);
    setText('room', next.token || '—');
    setText('url', next.url || '正在启动…');
    setText('versionChip', `v ${next.version || '0.1.0'}`);

    const qr = $('qr');
    if (next.qr && qr.dataset.src !== next.qr) {
      qr.dataset.src = next.qr;
      qr.src = next.qr;
    } else if (!next.qr) {
      qr.removeAttribute('src');
      qr.dataset.src = '';
    }

    const pauseBtn = $('pauseBtn');
    pauseBtn.textContent = next.paused ? '恢复弹幕' : '暂停弹幕';
    pauseBtn.classList.toggle('paused', Boolean(next.paused));
    pauseBtn.disabled = !next.ready || next.ended;
    $('clearBtn').disabled = !next.ready || next.ended;
    $('endBtn').disabled = !next.ready || next.ended;
    $('copyBtn').disabled = !next.url;

    $('joinBtn').textContent = next.joinVisible ? '关闭引导页' : '投屏引导页';

    const mode = cfg.mode === 'cloud' ? 'cloud' : 'scroll';
    $('modeScroll').classList.toggle('active', mode === 'scroll');
    $('modeCloud').classList.toggle('active', mode === 'cloud');

    applyTheme(cfg.theme);
    setControl('themeSel', cfg.theme || 'system');
    setControl('ssidInput', cfg.wifiSsid || '');
    setControl('pwdInput', cfg.wifiPassword || '');
    setControl('filterSel', cfg.filterLevel || 'block');
    setControl('wordsInput', cfg.customWords || '');

    const hasWifi = Boolean(cfg.wifiSsid || cfg.wifiPassword);
    $('wifiLine').hidden = !hasWifi;
    $('wifiName').textContent = cfg.wifiSsid || '—';
    $('wifiPwd').textContent = cfg.wifiPassword ? '密码 ' + cfg.wifiPassword : '无密码';

    setControl('speedRange', cfg.speed);
    setControl('fontRange', cfg.fontPx);
    setControl('opacityRange', cfg.opacity);
    setControl('areaSel', cfg.area);
    setControl('intervalSel', cfg.intervalSec);
    setText('speedVal', cfg.speed);
    setText('fontVal', cfg.fontPx);
    setText('opacityVal', cfg.opacity);

    const words = (cfg.customWords || '').split(/[\r\n,，、;；]+/).filter((w) => w.trim());
    setText('wordCount', words.length ? `${words.length} 个自定义词` : '自定义词 0');

    renderWarnings(next.warnings);
    renderDisplays(next.displays, next.selectedDisplay);
    renderNics(next.nics, next.ip);

    $('ended').hidden = !next.ended;
    $('url').title = next.url || '';
  }

  function guard(promise, fallbackMessage) {
    return Promise.resolve(promise)
      .then((res) => {
        if (res && typeof res === 'object' && 'ready' in res) render(res);
        return res;
      })
      .catch(() => {
        if (fallbackMessage) toast(fallbackMessage);
      });
  }

  /* ------------------------------------------------------------- 事件 */

  $('minBtn').addEventListener('click', () => api.minimize());
  $('closeBtn').addEventListener('click', () => {
    api.hidePanel();
    toast('已隐藏到托盘，可从托盘图标恢复');
  });

  $('pauseBtn').addEventListener('click', () => guard(api.togglePause(), '操作失败'));
  $('clearBtn').addEventListener('click', () => {
    api.clear();
    toast('已清屏');
  });
  $('endBtn').addEventListener('click', () => guard(api.end()));
  $('restartBtn').addEventListener('click', () => guard(api.restart()));

  $('copyBtn').addEventListener('click', () => {
    api.copyLink().then((ok) => toast(ok ? '链接已复制' : '暂无链接'));
  });

  $('joinBtn').addEventListener('click', () => guard(api.toggleJoin()));

  $('modeScroll').addEventListener('click', () => guard(api.setMode('scroll')));
  $('modeCloud').addEventListener('click', () => guard(api.setMode('cloud')));

  $('exportBtn').addEventListener('click', () => api.exportData());
  $('netSettingsBtn').addEventListener('click', () => api.openNetworkSettings());

  $('refreshBtn').addEventListener('click', () => {
    toast('正在重新检测网络…');
    guard(api.refreshNetwork(), '检测失败');
  });

  $('displaySel').addEventListener('change', (event) => {
    guard(api.setDisplay(event.target.value));
  });

  $('nicSel').addEventListener('change', (event) => {
    toast('正在切换网卡…');
    guard(api.setNic(event.target.value), '切换失败');
  });

  $('themeSel').addEventListener('change', (event) => {
    applyTheme(event.target.value);
    api.setConfig({ theme: event.target.value });
  });

  function saveWifi() {
    if (wifiTimer) clearTimeout(wifiTimer);
    wifiTimer = setTimeout(() => {
      wifiTimer = null;
      api.setConfig({ wifiSsid: $('ssidInput').value, wifiPassword: $('pwdInput').value });
    }, 450);
  }

  $('ssidInput').addEventListener('input', saveWifi);
  $('pwdInput').addEventListener('input', saveWifi);
  $('ssidInput').addEventListener('blur', saveWifi);
  $('pwdInput').addEventListener('blur', saveWifi);

  $('speedRange').addEventListener('input', (event) => setText('speedVal', event.target.value));
  $('speedRange').addEventListener('change', (event) => {
    api.setConfig({ speed: Number(event.target.value) });
  });

  $('fontRange').addEventListener('input', (event) => setText('fontVal', event.target.value));
  $('fontRange').addEventListener('change', (event) => {
    api.setConfig({ fontPx: Number(event.target.value) });
  });

  $('opacityRange').addEventListener('input', (event) => setText('opacityVal', event.target.value));
  $('opacityRange').addEventListener('change', (event) => {
    api.setConfig({ opacity: Number(event.target.value) });
  });

  $('areaSel').addEventListener('change', (event) => {
    api.setConfig({ area: event.target.value });
  });

  $('intervalSel').addEventListener('change', (event) => {
    api.setConfig({ intervalSec: Number(event.target.value) });
    toast(`已设置为每 ${event.target.value} 秒一条`);
  });

  $('filterSel').addEventListener('change', (event) => {
    const labels = { block: '命中即拦截', mark: '仅标记，照常上屏', off: '已关闭过滤' };
    api.setConfig({ filterLevel: event.target.value });
    toast(labels[event.target.value] || '已更新');
  });

  $('saveWordsBtn').addEventListener('click', () => {
    api.setConfig({ customWords: $('wordsInput').value }).then(() => toast('词表已保存'));
  });

  $('importWordsBtn').addEventListener('click', () => {
    Promise.resolve(api.importWords())
      .then((res) => {
        if (!res) return;
        if (res.error) return toast('导入失败：' + res.error);
        toast(`已导入 ${res.added} 个词，共 ${res.total} 个`);
      })
      .catch(() => toast('导入失败'));
  });

  api.onState(render);
  api.onItem(pushLog);

  api
    .getHistory()
    .then((res) => {
      logs = (res && res.items ? res.items : []).slice().reverse();
      renderLogs();
    })
    .catch(() => {});

  api
    .getState()
    .then(render)
    .catch(() => toast('初始化失败，请重启程序'));
})();
