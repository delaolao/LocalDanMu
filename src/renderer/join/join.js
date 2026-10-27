'use strict';

/**
 * 投屏引导页：开场时把二维码 + 现场 WiFi 账密放大投到屏幕上，
 * 学员看完自己扫码；讲师按 Esc 或 Ctrl+Alt+J 关掉即可切回 PPT。
 */

(function () {
  const $ = (id) => document.getElementById(id);

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme || 'system';
  }

  function render(state) {
    if (!state) return;
    applyTheme(state.config && state.config.theme);

    const qr = $('qr');
    if (state.qr && qr.dataset.src !== state.qr) {
      qr.dataset.src = state.qr;
      qr.src = state.qr;
    }

    $('url').textContent = state.url || '—';
    $('online').textContent = String(state.online || 0);
    $('brandLine').textContent = `培训弹幕 v${state.version || '0.1.0'} · teacherGeng programs with DSH.`;

    const ssid = (state.config && state.config.wifiSsid) || '';
    const pwd = (state.config && state.config.wifiPassword) || '';
    const wifi = $('wifi');
    wifi.hidden = !ssid && !pwd;
    $('ssid').textContent = ssid || '—';
    $('pwd').textContent = pwd || '无密码';
    $('pwdRow').hidden = !pwd;
  }

  $('closeBtn').addEventListener('click', () => window.join.close());

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.join.close();
  });

  window.join.onState(render);
  window.join.getState().then(render).catch(() => {});
})();
