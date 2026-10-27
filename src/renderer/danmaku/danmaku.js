'use strict';

/**
 * 弹幕渲染层
 *
 * 只做两件事：把 IPC 送来的消息变成屏幕上的滚动条目，以及响应暂停/清屏/配置指令。
 * 背景完全透明，鼠标穿透由主进程 setIgnoreMouseEvents 负责，这里不处理任何鼠标事件。
 */

(function () {
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });

  const MAX_PENDING = 12; // 暂停或轨道占满时最多攒这么多，超出丢最旧的
  const PENDING_TTL = 30000;

  let W = 0;
  let H = 0;
  let DPR = 1;

  let cfg = {
    fontPx: 38,
    speed: 8,
    area: 'full',
    opacity: 100
  };

  let paused = false;
  let items = [];
  let pending = [];
  let layout = null;
  let hoverItem = null;
  let modalItem = null;
  let modalOpenedAt = 0;
  let lastPointer = null;
  let hoverFreeze = false;
  let hoverTimer = null;

  let fontPx = 38;
  let rowH = 56;
  let areaTop = 0;
  let areaH = 0;

  let lastTs = 0;

  function fontSpec() {
    return `700 ${fontPx}px "Microsoft YaHei", "Microsoft YaHei UI", "PingFang SC", "Noto Sans SC", sans-serif`;
  }

  function pxPerSec() {
    // speed = 每秒走过屏幕宽度的百分比；下限保底 40px/s，避免极慢时看起来像卡住
    return Math.max(40, (W * Number(cfg.speed || 8)) / 100);
  }

  function resize() {
    W = Math.max(1, window.innerWidth);
    H = Math.max(1, window.innerHeight);
    DPR = Math.min(3, window.devicePixelRatio || 1);

    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    rebuild();
  }

  /** 尺寸 / 字号 / 区域变化后重建轨道。已经飞出去的弹幕会让位，直接清掉最稳妥。 */
  function rebuild() {
    fontPx = Math.max(14, Math.round((Number(cfg.fontPx) || 38) * (H / 1080)));
    rowH = Math.max(20, Math.round(fontPx * 1.55));

    const area = cfg.area;
    if (area === 'top') {
      areaTop = Math.round(H * 0.02);
      areaH = Math.round(H * 0.36);
    } else if (area === 'middle') {
      areaTop = Math.round(H * 0.32);
      areaH = Math.round(H * 0.36);
    } else if (area === 'bottom') {
      areaTop = Math.round(H * 0.62);
      areaH = Math.round(H * 0.36);
    } else {
      areaTop = Math.round(H * 0.015);
      areaH = Math.round(H * 0.97);
    }

    const rows = Math.max(1, Math.floor(areaH / rowH));
    layout = window.TrackLayout.createLayout({ rows, rowHeight: rowH, gap: Math.round(fontPx * 0.9) });
    items = [];
    pending = [];
    canvas.style.opacity = String(Math.max(0.3, Math.min(1, (Number(cfg.opacity) || 100) / 100)));
  }

  function fitText(text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    const chars = Array.from(text);
    let lo = 1;
    let hi = chars.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const candidate = chars.slice(0, mid).join('') + '…';
      if (ctx.measureText(candidate).width <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return chars.slice(0, lo).join('') + '…';
  }

  function enqueue(item) {
    item.enqueuedAt = performance.now();
    pending.push(item);
    if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
  }

  function buildText(content, color) {
    ctx.font = fontSpec();
    const text = fitText(content, W * 0.85);
    const width = Math.ceil(ctx.measureText(text).width + fontPx * 0.6);
    enqueue({
      kind: 'text',
      text,
      color: color || '#ffffff',
      font: fontSpec(),
      w: width,
      h: Math.round(fontPx * 1.35),
      speed: pxPerSec()
    });
  }

  function buildImage(payload) {
    const img = new Image();
    img.onload = function () {
      const ratio = img.width / img.height || 1;
      let h = fontPx * 2.6;
      let w = h * ratio;
      const maxW = W * 0.5;
      if (w > maxW) {
        w = maxW;
        h = w / ratio;
      }
      enqueue({ kind: 'image', img, w: Math.round(w), h: Math.round(h), speed: pxPerSec() });
    };
    img.onerror = function () {
      /* 图片坏了就当没收到 */
    };
    img.src = payload;
  }

  function onItem(msg) {
    if (!msg || !msg.payload) return;
    if (msg.contentType === 'image') buildImage(msg.payload);
    else buildText(String(msg.payload), msg.color);
  }

  function clear() {
    items = [];
    pending = [];
    if (layout) layout.reset();
    if (modalItem) closeModal();
    ctx.clearRect(0, 0, W, H);
  }

  function drawItem(item) {
    if (item.kind === 'image') {
      const pad = Math.max(2, Math.round(fontPx * 0.1));
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#ffffff';
      roundRect(item.x - pad, item.y - pad, item.w + pad * 2, item.h + pad * 2, 6);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.drawImage(item.img, item.x, item.y, item.w, item.h);
      // 鼠标停上来时描一圈薄荷色 + 提示可以点，让"是否进入可点状态"一眼可见
      if (item === hoverItem) {
        ctx.strokeStyle = 'rgba(52, 211, 153, 0.95)';
        ctx.lineWidth = Math.max(2, fontPx * 0.06);
        roundRect(item.x - pad - 2, item.y - pad - 2, item.w + pad * 2 + 4, item.h + pad * 2 + 4, 8);
        ctx.stroke();

        const label = '点击放大';
        const fs = Math.max(12, Math.round(fontPx * 0.42));
        ctx.font = `600 ${fs}px "Microsoft YaHei", "PingFang SC", sans-serif`;
        const tw = ctx.measureText(label).width;
        const bw = tw + fs * 1.4;
        const bh = fs * 1.7;
        const bx = item.x + item.w / 2 - bw / 2;
        let by = item.y - bh - pad - 8;
        // 图片贴在最上面一行时，标签放到图片下方，别画到屏幕外面
        if (by < 4) by = item.y + item.h + pad + 8;
        ctx.fillStyle = 'rgba(52, 211, 153, 0.95)';
        roundRect(bx, by, bw, bh, bh / 2);
        ctx.fill();
        ctx.fillStyle = '#04120d';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bx + bw / 2, by + bh / 2);
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }
      ctx.restore();
      return;
    }

    const baseline = item.y + fontPx * 1.06;
    ctx.font = item.font;
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = Math.max(4, fontPx * 0.18);
    ctx.shadowOffsetY = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.92)';
    ctx.lineWidth = Math.max(4, fontPx * 0.16);
    ctx.strokeText(item.text, item.x, baseline);
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillStyle = item.color || '#ffffff';
    ctx.fillText(item.text, item.x, baseline);
  }

  function roundRect(x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, radius);
      return;
    }
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function openModal(item) {
    if (modalItem || !item || item.kind !== 'image') return;
    modalItem = item;
    modalOpenedAt = performance.now();
    hoverItem = null;
    hoverFreeze = false;
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    document.body.style.cursor = 'default';
    window.dm.modal(true);
  }

  function closeModal() {
    if (!modalItem) return;
    modalItem = null;
    hoverItem = null;
    hoverFreeze = false;
    document.body.style.cursor = 'none';
    window.dm.modal(false);
  }

  /** 鼠标压到图片上才接管点击，其余位置保持穿透。命中区域外扩 16px，好点。 */
  const HIT_PAD = 16;

  function imageAt(x, y, pad) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (it.kind !== 'image') continue;
      if (x >= it.x - pad && x <= it.x + it.w + pad && y >= it.y - pad && y <= it.y + it.h + pad) return it;
    }
    return null;
  }

  function setHoverTarget(target) {
    if (target === hoverItem) return;
    hoverItem = target;
    document.body.style.cursor = target ? 'pointer' : 'none';
    window.dm.hover(Boolean(target));

    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    if (target) {
      // 停 120ms 再冻结：鼠标只是路过时不会把画面定住
      hoverTimer = setTimeout(() => {
        hoverTimer = null;
        if (hoverItem) hoverFreeze = true;
      }, 120);
    } else {
      hoverFreeze = false;
    }
  }

  function updateHover(x, y) {
    if (modalItem) return;
    setHoverTarget(imageAt(x, y, HIT_PAD));
  }

  /**
   * 弹幕一直在动，图片可能自己从鼠标下面滑走（此时不会触发 mousemove），
   * 每帧再核对一次，否则误接管点击后讲师会点不动 PPT。
   */
  function revalidateHover() {
    if (!hoverItem || modalItem || !lastPointer) return;
    const it = hoverItem;
    const inside =
      lastPointer.x >= it.x - HIT_PAD &&
      lastPointer.x <= it.x + it.w + HIT_PAD &&
      lastPointer.y >= it.y - HIT_PAD &&
      lastPointer.y <= it.y + it.h + HIT_PAD;
    if (inside) return;
    setHoverTarget(null);
  }

  function drawModal() {
    const img = modalItem.img;
    if (!img || !img.width || !img.height) return;
    const maxW = W * 0.88;
    const maxH = H * 0.84;
    const ratio = img.width / img.height;
    let w = maxW;
    let h = w / ratio;
    if (h > maxH) {
      h = maxH;
      w = h * ratio;
    }
    const x = (W - w) / 2;
    const y = (H - h) / 2;

    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.82)';
    ctx.fillRect(0, 0, W, H);
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = Math.round(H * 0.03);
    ctx.fillStyle = '#ffffff';
    roundRect(x - 8, y - 8, w + 16, h + 16, 10);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.drawImage(img, x, y, w, h);

    const hint = Math.round(Math.max(14, fontPx * 0.55));
    ctx.font = `500 ${hint}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.fillText('点击任意位置关闭', W / 2, H - Math.max(16, Math.round(H * 0.035)));
    ctx.textAlign = 'start';
    ctx.restore();
  }

  function frame(ts) {
    if (!lastTs) lastTs = ts;
    const dt = Math.min(0.05, Math.max(0, (ts - lastTs) / 1000));
    lastTs = ts;

    if (!paused && !modalItem && !hoverFreeze) {
      for (const item of items) item.x -= item.speed * dt;
      if (items.length) items = items.filter((item) => item.x + item.w > -80);

      let spawned = 0;
      while (pending.length && spawned < 3) {
        const head = pending[0];
        if (ts - head.enqueuedAt > PENDING_TTL) {
          pending.shift();
          continue;
        }
        const slot = layout.allocate({ now: ts, width: head.w, height: head.h, speed: head.speed });
        if (!slot) break;
        pending.shift();
        head.x = W + 8;
        head.y = areaTop + slot.y;
        items.push(head);
        spawned += 1;
      }
    }

    revalidateHover();

    ctx.clearRect(0, 0, W, H);
    for (const item of items) drawItem(item);
    if (modalItem) drawModal();

    requestAnimationFrame(frame);
  }

  function applyConfig(next) {
    const merged = {
      fontPx: Number(next.fontPx) || cfg.fontPx,
      speed: Number(next.speed) || cfg.speed,
      area: next.area || cfg.area,
      opacity: Number(next.opacity) || cfg.opacity
    };
    const changed =
      merged.fontPx !== cfg.fontPx ||
      merged.speed !== cfg.speed ||
      merged.area !== cfg.area ||
      merged.opacity !== cfg.opacity;
    const onlySpeed =
      merged.speed !== cfg.speed &&
      merged.fontPx === cfg.fontPx &&
      merged.area === cfg.area &&
      merged.opacity === cfg.opacity;

    cfg = merged;
    if (!changed) return;

    if (onlySpeed) {
      // 只调速度时不清屏，把在飞的条目速度一起改掉
      const speed = pxPerSec();
      for (const item of items) item.speed = speed;
      for (const item of pending) item.speed = speed;
      return;
    }
    rebuild();
  }

  function onCommand(cmd) {
    if (!cmd) return;
    if (cmd.type === 'pause') paused = true;
    else if (cmd.type === 'resume') paused = false;
    else if (cmd.type === 'clear') clear();
    else if (cmd.type === 'closeModal') closeModal();
    else if (cmd.type === 'config' && cmd.config) applyConfig(cmd.config);
  }

  window.addEventListener('resize', resize, { passive: true });

  // 只有鼠标落在图片上时才向主进程申请接管点击，其余时间保持点击穿透
  // 主进程轮询光标位置（Windows 上 forward 的 mousemove 不一定送达，这条才是主路径）
  window.dm.onCursor((point) => {
    if (!point) return;
    lastPointer = { x: point.x, y: point.y };
    updateHover(point.x, point.y);
  });

  window.addEventListener(
    'mousemove',
    (event) => {
      lastPointer = { x: event.clientX, y: event.clientY };
      updateHover(event.clientX, event.clientY);
    },
    { passive: true }
  );

  // 鼠标移出屏幕/窗口时不会再有 mousemove，主动放开点击
  document.addEventListener('mouseleave', () => {
    lastPointer = null;
    if (modalItem) return;
    setHoverTarget(null);
  });

  window.addEventListener('click', (event) => {
    if (modalItem) {
      // 双击的第二次点击会立刻把大图关掉，看起来就像"没打开"，这里挡一下
      if (performance.now() - modalOpenedAt < 550) return;
      closeModal();
      return;
    }
    const hit = imageAt(event.clientX, event.clientY, 8);
    if (hit) openModal(hit);
  });

  resize();
  window.dm.onCommand(onCommand);
  window.dm.onItem(onItem);
  window.dm.ready();

  // 冒烟测试用的只读探针（不对外暴露任何写能力）
  window.__dmDebug = {
    clicks: 0,
    lastClick: null,
    images() {
      return items.filter((it) => it.kind === 'image').map((it) => ({ x: it.x, y: it.y, w: it.w, h: it.h }));
    },
    modalOpen() {
      return Boolean(modalItem);
    },
    hovering() {
      return Boolean(hoverItem);
    }
  };

  window.addEventListener('mousedown', (event) => {
    if (!window.__dmDebug) return;
    window.__dmDebug.clicks += 1;
    window.__dmDebug.lastClick = { x: event.clientX, y: event.clientY };
  });

  requestAnimationFrame(frame);
})();
