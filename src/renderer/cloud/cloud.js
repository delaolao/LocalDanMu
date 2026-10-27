'use strict';

/**
 * 词云大屏
 *
 * 左边是词云（字号 ∝ 出现次数），右边是实时消息流，可以当"错过弹幕"的回溯列表用。
 * 布局用螺旋放置 + 矩形碰撞，纯 Canvas，不引第三方库。
 */

(function () {
  const canvas = document.getElementById('cloud');
  const ctx = canvas.getContext('2d', { alpha: true });

  const PALETTE = ['#34d399', '#22d3ee', '#a7f3d0', '#fbbf24', '#f472b6', '#93c5fd', '#fde68a', '#c4b5fd'];
  const LIGHT_PALETTE = ['#0f9f78', '#0891b2', '#0b8a68', '#b45309', '#be185d', '#1d4ed8', '#a16207', '#6d28d9'];

  const FEED_MAX = 80;
  const WORD_MAX = 55;

  let state = null;
  let texts = [];
  let feed = [];
  let theme = 'dark';
  let redrawTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function applyTheme(next) {
    theme = next || 'system';
    document.documentElement.dataset.theme = theme;
    const dark =
      theme === 'dark' ||
      (theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.resolved = dark ? 'dark' : 'light';
  }

  function isDark() {
    return document.documentElement.dataset.resolved !== 'light';
  }

  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i += 1) {
      h = (h * 31 + str.charCodeAt(i)) >>> 0;
    }
    return h;
  }

  function clock(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /* ------------------------------------------------------------- 消息流 */

  function renderFeed() {
    const box = $('feed');
    if (!feed.length) {
      box.innerHTML = '<div class="feed-empty">还没有消息</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const item of feed) {
      const row = document.createElement('div');
      row.className =
        'feed-item' + (item.flagged ? ' flagged' : '') + (item.contentType === 'image' ? ' image' : '');

      const time = document.createElement('span');
      time.className = 'feed-time';
      time.textContent = clock(item.ts);
      row.appendChild(time);

      if (item.contentType === 'text' && item.color) {
        const dot = document.createElement('span');
        dot.className = 'feed-dot';
        dot.style.background = item.color;
        row.appendChild(dot);
      }

      const text = document.createElement('span');
      text.className = 'feed-text';
      text.textContent = item.contentType === 'image' ? '［图片］' : item.text || '';
      row.appendChild(text);

      frag.appendChild(row);
    }
    box.innerHTML = '';
    box.appendChild(frag);
  }

  function addItem(item) {
    feed.unshift(item);
    if (feed.length > FEED_MAX) feed.length = FEED_MAX;
    if (item.contentType === 'text' && item.text) {
      texts.push(item.text);
      if (texts.length > 600) texts = texts.slice(-600);
      scheduleRedraw();
    }
    renderFeed();
  }

  function scheduleRedraw() {
    if (redrawTimer) return;
    redrawTimer = setTimeout(() => {
      redrawTimer = null;
      draw();
    }, 500);
  }

  /* --------------------------------------------------------------- 词云 */

  function palette() {
    return isDark() ? PALETTE : LIGHT_PALETTE;
  }

  function findSpot(w, h, placed, W, H) {
    const cx = W / 2;
    const cy = H / 2;
    const pad = 6;
    for (let step = 0; step < 900; step += 1) {
      const angle = step * 0.42;
      const radius = 3.2 * Math.sqrt(step) * 7;
      const x = cx + Math.cos(angle) * radius * 1.25 - w / 2;
      const y = cy + Math.sin(angle) * radius - h / 2;
      if (x < pad || y < pad || x + w > W - pad || y + h > H - pad) continue;
      let clash = false;
      for (const r of placed) {
        if (x < r.x + r.w + pad && x + w + pad > r.x && y < r.y + r.h + pad && y + h + pad > r.y) {
          clash = true;
          break;
        }
      }
      if (!clash) return { x, y };
    }
    return null;
  }

  function draw() {
    const W = Math.max(1, canvas.clientWidth);
    const H = Math.max(1, canvas.clientHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const list = window.CloudWords.aggregate(texts, { max: WORD_MAX });
    const empty = $('empty');
    if (!list.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    const maxCount = list[0].count || 1;
    // 词少的时候放大一点，别让大屏显得空
    const few = list.length <= 8;
    const maxSize = Math.min(H * (few ? 0.26 : 0.17), few ? 190 : 128);
    const minSize = Math.max(15, H * (few ? 0.045 : 0.026));
    const colors = palette();
    const placed = [];

    for (const item of list) {
      const t = Math.sqrt(item.count / maxCount);
      let size = Math.round(minSize + (maxSize - minSize) * t);
      const color = colors[hash(item.word) % colors.length];
      let done = false;

      for (let shrink = 0; shrink < 3 && !done; shrink += 1) {
        const font = `700 ${size}px "Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif`;
        ctx.font = font;
        const label = item.count > 1 ? `${item.word} ×${item.count}` : item.word;
        const w = ctx.measureText(label).width + 12;
        const h = size * 1.18;
        const pos = findSpot(w, h, placed, W, H);
        if (!pos) {
          size = Math.round(size * 0.8);
          continue;
        }
        placed.push({ x: pos.x, y: pos.y, w, h });

        ctx.save();
        ctx.textBaseline = 'middle';
        ctx.shadowColor = isDark() ? 'rgba(0, 0, 0, 0.45)' : 'rgba(255, 255, 255, 0.5)';
        ctx.shadowBlur = 10;
        ctx.fillStyle = color;
        ctx.font = font;
        const mainLabel = item.count > 1 ? item.word : item.word;
        ctx.fillText(mainLabel, pos.x + 6, pos.y + h / 2);

        if (item.count > 1) {
          const mainWidth = ctx.measureText(mainLabel).width;
          const small = Math.max(11, Math.round(size * 0.34));
          ctx.font = `600 ${small}px "Microsoft YaHei", sans-serif`;
          ctx.globalAlpha = 0.75;
          ctx.fillText(`×${item.count}`, pos.x + 6 + mainWidth + 6, pos.y + h / 2 + size * 0.16);
        }
        ctx.restore();
        done = true;
      }
    }
  }

  /* --------------------------------------------------------------- 状态 */

  function render(next) {
    if (!next) return;
    state = next;
    applyTheme(next.config && next.config.theme);

    $('onlineChip').textContent = `在线 ${next.ended ? 0 : next.online}`;
    $('totalChip').textContent = `消息 ${next.total || 0}`;
    $('pausedChip').hidden = !next.paused;
    $('sub').textContent = next.ended ? '本场已结束' : '扫码发几个关键词，字号越大出现越多';

    const version = next.version || '0.1.0';
    $('brandLine').textContent = `培训弹幕 v${version}`;

    draw();
  }

  window.addEventListener('resize', () => scheduleRedraw());

  window.cloud.onState(render);
  window.cloud.onItem(addItem);

  window.cloud
    .getState()
    .then(async (st) => {
      render(st);
      const res = await window.cloud.getHistory();
      const items = (res && res.items) || [];
      feed = items.slice().reverse();
      texts = items.filter((i) => i.contentType === 'text' && i.text).map((i) => i.text);
      renderFeed();
      draw();
    })
    .catch(() => {
      $('empty').hidden = false;
    });
})();
