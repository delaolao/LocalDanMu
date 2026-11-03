/* eslint-disable */
/**
 * Tauri 兼容层（兼容层，不是框架）。
 *
 * 旧版 Electron 用 4 个 preload 通过 contextBridge 暴露 `window.api` / `window.dm` /
 * `window.cloud` / `window.join`。这里用一份同样的接口把它们重新实现一遍，
 * 底座从 `ipcRenderer` 换成 Tauri 的 `invoke` / `listen`。
 *
 * 这么做的好处是：**四个窗口的页面代码一行都不用改**——
 * control.js / danmaku.js / cloud.js / join.js 里那些 `api.setConfig(...)`、
 * `dm.onItem(...)` 原样照跑。渲染层 100% 复用，这是整个迁移里最省事的一块。
 *
 * 与 preload 的两点差异（都不影响调用方）：
 * 1. `listen` 是异步的（底层 event.listen 返回 Promise），所以注册后的第一个 tick 内
 *    到达的事件可能丢失。实际场景里页面加载完成到开始收消息之间隔着好几帧，无影响。
 * 2. 不再需要 `contextIsolation`：页面本来就只有这些窄接口，没有 Node 集成。
 */
(function () {
  'use strict';

  var T = window.__TAURI__;
  if (!T || !T.core) {
    console.error('[shim] Tauri API 没有注入：检查 tauri.conf.json 的 withGlobalTauri');
    return;
  }

  var invoke = T.core.invoke;
  var listen = function (event, handler) {
    T.event.listen(event, function (e) {
      handler(e.payload);
    });
  };

  /* ------------------------------------------------------------- 讲师控制面板 */
  window.api = {
    getState: function () {
      return invoke('state_get');
    },
    onState: function (cb) {
      listen('state', cb);
    },

    togglePause: function () {
      return invoke('session_toggle_pause');
    },
    clear: function () {
      return invoke('session_clear');
    },
    end: function () {
      return invoke('session_end');
    },
    restart: function () {
      return invoke('session_restart');
    },

    copyLink: function () {
      return invoke('app_copy_link');
    },
    exportData: function () {
      return invoke('app_export');
    },
    openRepo: function () {
      return invoke('app_open_repo');
    },
    setConfig: function (patch) {
      return invoke('app_set_config', { patch: patch });
    },
    setDisplay: function (id) {
      return invoke('app_set_display', { id: String(id) });
    },
    setNic: function (address) {
      return invoke('app_set_nic', { address: address });
    },
    refreshNetwork: function () {
      return invoke('app_refresh_network');
    },
    openNetworkSettings: function () {
      return invoke('app_open_network_settings');
    },
    toggleOverlay: function () {
      return invoke('app_toggle_overlay');
    },
    toggleJoin: function () {
      return invoke('app_toggle_join');
    },
    setMode: function (mode) {
      return invoke('app_set_mode', { mode: mode });
    },

    getHistory: function () {
      return invoke('history_get');
    },
    replay: function (seq) {
      return invoke('session_replay', { seq: Number(seq) });
    },
    onItem: function (cb) {
      listen('dm:item', cb);
    },
    importWords: function () {
      return invoke('app_import_words');
    },

    tunnelStart: function () {
      return invoke('tunnel_start');
    },
    tunnelStop: function () {
      return invoke('tunnel_stop');
    },
    tunnelState: function () {
      return invoke('tunnel_state');
    },
    onTunnelState: function (cb) {
      listen('tunnel:state', cb);
    },

    hidePanel: function () {
      return invoke('app_hide_panel');
    },
    minimize: function () {
      return invoke('app_minimize');
    },
    quit: function () {
      return invoke('app_quit');
    }
  };

  /* ----------------------------------------------------------------- 弹幕层 */
  window.dm = {
    // 弹幕层要完整消息（图片正文在 payload 里），所以听的是 dm:item-full。
    // 控制面板/词云听 dm:item（精简副本）——两边载荷形状不同，刻意用两个事件名。
    onItem: function (cb) {
      listen('dm:item-full', cb);
    },
    onCommand: function (cb) {
      listen('dm:cmd', cb);
    },
    onLike: function (cb) {
      listen('dm:like', cb);
    },
    onCursor: function (cb) {
      listen('dm:cursor', cb);
    },
    onClick: function (cb) {
      listen('dm:click', cb);
    },
    /** 鼠标压到图片上时临时接管点击，移开再恢复穿透 */
    hover: function (on) {
      return invoke('dm_hover', { on: !!on });
    },
    /** 大图模式：整屏都要能点（点任意位置关闭） */
    modal: function (open) {
      return invoke('dm_modal', { open: !!open });
    },
    ready: function () {
      return invoke('dm_ready');
    }
  };

  /* ----------------------------------------------------------------- 词云页 */
  window.cloud = {
    getState: function () {
      return invoke('state_get');
    },
    onState: function (cb) {
      listen('state', cb);
    },
    getHistory: function () {
      return invoke('history_get');
    },
    onItem: function (cb) {
      listen('dm:item', cb);
    },
    onLike: function (cb) {
      listen('dm:like', cb);
    }
  };

  /* --------------------------------------------------------------- 投屏引导页 */
  window.join = {
    getState: function () {
      return invoke('state_get');
    },
    onState: function (cb) {
      listen('state', cb);
    },
    close: function () {
      return invoke('join_close');
    }
  };
})();
