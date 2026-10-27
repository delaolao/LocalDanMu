'use strict';

/**
 * 观众端（手机 H5）
 *
 * 注意：这个页面跑在 http://192.168.x.x 上，属于"非安全上下文"。
 * 因此不能用 crypto.randomUUID / navigator.clipboard / getUserMedia，
 * 只能用 crypto.getRandomValues 和 <input type="file">。
 * 同时要照顾微信内置浏览器（X5 / WKWebView）：不依赖任何外部资源，语法保持保守。
 */

(function () {
  var TOKEN = (function () {
    var m = location.pathname.match(/^\/j\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  })();

  var $ = function (id) {
    return document.getElementById(id);
  };

  var PROTO = 1; // 与 server.js 的 hello.proto 对应

  /* ---------------------------------------------------------------- 主题 */

  var THEME_KEY = 'dm_theme';
  var THEMES = ['system', 'dark', 'light'];

  var theme = (function () {
    try {
      var saved = localStorage.getItem(THEME_KEY);
      return THEMES.indexOf(saved) >= 0 ? saved : 'system';
    } catch (e) {
      return 'system';
    }
  })();

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', theme);
    var label = theme === 'dark' ? '深色' : theme === 'light' ? '浅色' : '跟随系统';
    if (els.theme) {
      els.theme.textContent = theme === 'dark' ? '🌙' : theme === 'light' ? '☀️' : '◐';
      els.theme.title = '当前：' + label + '，点击切换';
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
      var isDark = theme === 'dark' || (theme === 'system' && (!media || media.matches));
      meta.setAttribute('content', isDark ? '#06100e' : '#f2f7f4');
    }
  }

  function cycleTheme() {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch (e) {
      /* 无痕模式忽略 */
    }
    applyTheme();
  }

  /* ---------------------------------------------------------------- 颜色 */

  var COLOR_KEY = 'dm_color';
  // 与 server.js 的 COLORS 白名单保持一致
  var PALETTE = ['#ffffff', '#ffe066', '#7ee787', '#7cc4ff', '#ffb4d1', '#ffa94d', '#b197fc', '#66e3d0'];

  var pickedColor = (function () {
    try {
      var saved = localStorage.getItem(COLOR_KEY);
      return saved === 'auto' || PALETTE.indexOf(saved) >= 0 ? saved : 'auto';
    } catch (e) {
      return 'auto';
    }
  })();

  function paintSwatches() {
    var nodes = document.querySelectorAll('#colors .swatch');
    for (var i = 0; i < nodes.length; i += 1) {
      nodes[i].classList.toggle('active', nodes[i].getAttribute('data-color') === pickedColor);
    }
  }

  function pickColor() {
    if (pickedColor !== 'auto') return pickedColor;
    return PALETTE[Math.floor(Math.random() * PALETTE.length)];
  }

  var els = {
    status: $('status'),
    dot: $('dot'),
    hint: $('hint'),
    input: $('input'),
    counter: $('counter'),
    cool: $('cool'),
    send: $('sendBtn'),
    file: $('file'),
    toast: $('toast'),
    ended: $('ended'),
    theme: $('themeBtn')
  };

  var state = {
    connected: false,
    ended: false,
    intervalSec: 5,
    paused: false,
    cooldownUntil: 0,
    pending: null,
    retry: 0,
    busy: false
  };

  var ws = null;
  var reconnectTimer = null;
  var toastTimer = null;
  var composing = false;
  var resetLabelTimer = null;

  /* ------------------------------------------------------------ 基础工具 */

  function randomId(len) {
    var bytes = new Uint8Array(len);
    var c = window.crypto || window.msCrypto;
    if (c && c.getRandomValues) c.getRandomValues(bytes);
    else for (var k = 0; k < len; k += 1) bytes[k] = Math.floor(Math.random() * 256);
    var out = '';
    for (var i = 0; i < len; i += 1) {
      var hex = bytes[i].toString(16);
      if (hex.length < 2) hex = '0' + hex;
      out += hex;
    }
    return out;
  }

  var CID = (function () {
    var saved = null;
    try {
      saved = sessionStorage.getItem('dm_cid');
    } catch (e) {
      saved = null;
    }
    if (!saved) {
      saved = randomId(8);
      try {
        sessionStorage.setItem('dm_cid', saved);
      } catch (e) {
        /* 无痕模式下忽略 */
      }
    }
    return saved;
  })();

  function countChars(text) {
    var n = 0;
    for (var i = 0; i < text.length; i += 1) {
      var code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) i += 1; // 代理对算一个字符
      n += 1;
    }
    return n;
  }

  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.hidden = true;
    }, 2200);
  }

  function setStatus(kind, text) {
    els.dot.className = 'dot' + (kind ? ' ' + kind : '');
    els.status.textContent = text;
  }

  function updateHint() {
    var parts = ['每人每 ' + state.intervalSec + ' 秒可发 1 条'];
    if (state.paused) parts.push('讲师已暂停展示');
    els.hint.textContent = parts.join(' · ');
  }

  function flashSent() {
    els.send.textContent = '已发送 ✓';
    if (resetLabelTimer) clearTimeout(resetLabelTimer);
    resetLabelTimer = setTimeout(updateSendButton, 1200);
  }

  function updateSendButton() {
    var now = Date.now();
    var cooling = state.cooldownUntil - now;
    var disabled = !state.connected || state.ended || cooling > 0;
    els.send.disabled = disabled;
    els.cool.textContent = cooling > 0 ? '冷却 ' + Math.ceil(cooling / 1000) + 's' : '';
    if (els.send.textContent !== '已发送 ✓') {
      els.send.textContent = '发送';
    }
  }

  setInterval(updateSendButton, 250);

  /* ---------------------------------------------------------------- 连接 */

  function connect() {
    if (state.ended) return;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    if (!TOKEN) {
      setStatus('warn', '链接无效，请重新扫码');
      return;
    }

    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = proto + '//' + location.host + '/ws?t=' + encodeURIComponent(TOKEN);

    setStatus('', '连接中…');
    try {
      ws = new WebSocket(url);
    } catch (e) {
      scheduleReconnect();
      return;
    }

    ws.onopen = function () {
      state.connected = true;
      state.retry = 0;
      setStatus('on', '培训互动 · 已连接');
      updateSendButton();
    };

    ws.onmessage = function (event) {
      var msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      handleMessage(msg);
    };

    ws.onclose = function () {
      state.connected = false;
      if (state.ended) return;
      setStatus('warn', '连接断开，正在重连…');
      updateSendButton();
      scheduleReconnect();
    };

    ws.onerror = function () {
      /* onclose 会紧跟着触发 */
    };
  }

  function scheduleReconnect() {
    if (state.ended || reconnectTimer) return;
    var delay = Math.min(8000, 800 * Math.pow(1.6, state.retry));
    state.retry = Math.min(state.retry + 1, 8);
    if (state.retry >= 5) {
      setStatus('warn', '连接断开，请刷新页面或重新扫码');
    }
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function handleMessage(msg) {
    if (!msg || !msg.type) return;

    if (msg.type === 'hello') {
      if (msg.proto && msg.proto !== PROTO) {
        toast('页面版本过旧，请下拉刷新');
      }
      state.intervalSec = Number(msg.intervalSec) || 5;
      state.paused = Boolean(msg.paused);
      updateHint();
      return;
    }
    if (msg.type === 'config') {
      state.intervalSec = Number(msg.intervalSec) || state.intervalSec;
      updateHint();
      return;
    }
    if (msg.type === 'paused') {
      state.paused = Boolean(msg.paused);
      updateHint();
      return;
    }
    if (msg.type === 'session_end') {
      endSession();
      return;
    }
    if (msg.type === 'ack') {
      handleAck(msg);
    }
  }

  function endSession() {
    state.ended = true;
    state.connected = false;
    els.ended.hidden = false;
    setStatus('', '培训已结束');
    if (ws) {
      try {
        ws.close();
      } catch (e) {
        /* ignore */
      }
    }
  }

  function handleAck(msg) {
    if (!state.pending) return;
    if (msg.msgId && msg.msgId !== state.pending.id) return;

    var pending = state.pending;
    state.pending = null;

    if (msg.status === 'ok') {
      state.cooldownUntil = Date.now() + (Number(msg.retryAfter) || state.intervalSec * 1000);
      flashSent();
      pending.resolve(msg);
      return;
    }

    if (msg.status === 'rate_limited') {
      state.cooldownUntil = Date.now() + (Number(msg.retryAfter) || 3000);
      toast('发送太快了，休息一下');
      pending.reject(new Error('rate_limited'));
      return;
    }

    var reason = msg.reason || '';
    var map = {
      too_long: '内容太长了，精简一下吧',
      empty: '内容不能为空',
      too_large: '图片太大了，换一张试试',
      bad_image: '图片格式不支持',
      json: '发送失败，请重试',
      type: '发送失败，请重试'
    };
    toast(map[reason] || '发送失败，请重试');
    pending.reject(new Error('invalid'));
  }

  /* ---------------------------------------------------------------- 发送 */

  function sendMessage(contentType, payload, color) {
    return new Promise(function (resolve, reject) {
      if (!state.connected || !ws || ws.readyState !== 1) {
        reject(new Error('offline'));
        return;
      }
      if (state.cooldownUntil > Date.now()) {
        reject(new Error('cooldown'));
        return;
      }
      if (state.pending) {
        reject(new Error('busy'));
        return;
      }

      var msgId = randomId(8);
      state.pending = { id: msgId, resolve: resolve, reject: reject };

      var timer = setTimeout(function () {
        if (state.pending && state.pending.id === msgId) {
          state.pending = null;
          reject(new Error('timeout'));
        }
      }, 10000);

      var settle = function (fn) {
        return function (value) {
          clearTimeout(timer);
          fn(value);
        };
      };
      state.pending.resolve = settle(resolve);
      state.pending.reject = settle(reject);

      try {
        ws.send(
          JSON.stringify({
            type: 'message',
            msgId: msgId,
            contentType: contentType,
            payload: payload,
            color: color || null,
            clientId: CID,
            ts: Date.now()
          })
        );
      } catch (e) {
        state.pending = null;
        clearTimeout(timer);
        reject(new Error('offline'));
      }
    });
  }

  function describeError(err) {
    var code = err && err.message;
    if (code === 'offline') return '连接断开了，正在重连…';
    if (code === 'cooldown') return '发送太快了，休息一下';
    if (code === 'timeout') return '没发出去，请再试一次';
    if (code === 'busy') return '上一条还在发送中';
    return null;
  }

  function sendText() {
    var text = String(els.input.value).replace(/\s+/g, ' ').trim();
    if (!text) {
      toast('说点什么吧');
      return;
    }
    if (countChars(text) > 100) {
      toast('最多 100 个字');
      return;
    }
    els.send.disabled = true;
    sendMessage('text', text, pickColor())
      .then(function () {
        els.input.value = '';
        updateCounter();
      })
      .catch(function (err) {
        var hint = describeError(err);
        if (hint) toast(hint);
      })
      .then(updateSendButton);
  }

  /* ------------------------------------------------------------ 图片处理 */

  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      var done = function (fn, value) {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {
          /* ignore */
        }
        fn(value);
      };

      img.onload = function () {
        try {
          var maxSide = 800;
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          if (!w || !h) throw new Error('bad-size');

          var scale = Math.min(1, maxSide / Math.max(w, h));
          var tw = Math.max(1, Math.round(w * scale));
          var th = Math.max(1, Math.round(h * scale));

          var canvas = document.createElement('canvas');
          canvas.width = tw;
          canvas.height = th;
          var cx = canvas.getContext('2d');
          // JPEG 没有透明通道，先铺白底，避免 PNG 透明区域变黑
          cx.fillStyle = '#ffffff';
          cx.fillRect(0, 0, tw, th);
          cx.drawImage(img, 0, 0, tw, th);

          var data = canvas.toDataURL('image/jpeg', 0.82);
          if (data.length > 780 * 1024) data = canvas.toDataURL('image/jpeg', 0.6);
          if (data.length > 900 * 1024) {
            done(reject, new Error('too-big'));
            return;
          }
          done(resolve, data);
        } catch (err) {
          done(reject, err);
        }
      };

      img.onerror = function () {
        done(reject, new Error('decode'));
      };

      img.src = url;
    });
  }

  function handleFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      toast('请选择图片');
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      toast('图片太大（超过 12MB）');
      return;
    }

    toast('正在处理图片…');
    compressImage(file)
      .then(function (dataUrl) {
        return sendMessage('image', dataUrl).then(function () {
          toast('图片已发送');
        });
      })
      .catch(function (err) {
        if (err && err.message === 'too-big') {
          toast('图片压缩后仍然太大');
          return;
        }
        var hint = describeError(err);
        toast(hint || '图片处理失败，换一张试试');
      })
      .then(updateSendButton);
  }

  /* ---------------------------------------------------------------- 输入 */

  function updateCounter() {
    var n = countChars(els.input.value);
    els.counter.textContent = n + '/100';
    els.counter.style.color = n > 100 ? '#e5484d' : '';
  }

  els.input.addEventListener('compositionstart', function () {
    composing = true;
  });

  els.input.addEventListener('compositionend', function () {
    composing = false;
    updateCounter();
  });

  els.input.addEventListener('input', function () {
    if (!composing) {
      var chars = Array.from ? Array.from(els.input.value) : els.input.value.split('');
      if (chars.length > 100) {
        els.input.value = chars.slice(0, 100).join('');
      }
    }
    updateCounter();
  });

  els.send.addEventListener('click', sendText);

  els.file.addEventListener('change', function () {
    var file = els.file.files && els.file.files[0];
    els.file.value = '';
    handleFile(file);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && !state.connected && !state.ended) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
        state.retry = 0;
      }
      connect();
    }
  });

  /* --------------------------------------------------- 移动端键盘与视口 */

  function syncViewport() {
    var vv = window.visualViewport;
    if (vv) {
      document.documentElement.style.setProperty('--vh', vv.height + 'px');
    }
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncViewport);
    window.visualViewport.addEventListener('scroll', syncViewport);
    syncViewport();
  }

  els.input.addEventListener('focus', function () {
    setTimeout(function () {
      window.scrollTo(0, 0);
    }, 120);
  });

  updateCounter();
  updateHint();
  updateSendButton();

  if (els.theme) els.theme.addEventListener('click', cycleTheme);
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onSchemeChange = function () {
      if (theme === 'system') applyTheme();
    };
    if (mq.addEventListener) mq.addEventListener('change', onSchemeChange);
    else if (mq.addListener) mq.addListener(onSchemeChange);
  }
  applyTheme();

  var colorBox = $('colors');
  if (colorBox) {
    colorBox.addEventListener('click', function (event) {
      var btn = event.target && event.target.closest ? event.target.closest('.swatch') : null;
      if (!btn) return;
      var value = btn.getAttribute('data-color');
      pickedColor = value === 'auto' || PALETTE.indexOf(value) >= 0 ? value : 'auto';
      try {
        localStorage.setItem(COLOR_KEY, pickedColor);
      } catch (e) {
        /* 无痕模式忽略 */
      }
      paintSwatches();
    });
  }
  paintSwatches();

  connect();
})();
