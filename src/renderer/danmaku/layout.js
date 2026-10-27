(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TrackLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 轨道分配
   *
   * 思路：把可用高度切成若干行，每行记住"什么时候可以再放一条"。
   * 关键：不是等上一条完全飞出屏幕，而是等它的尾巴完全进入屏幕
   * （x + width + gap <= 屏幕宽），这样同一条轨道可以连续发车，吞吐高很多。
   *
   * 一条弹幕可能占多行（图片、或换行文本），所以按行占用、按连续空行查找。
   */
  function createLayout(opts) {
    const options = opts || {};
    const rowHeight = Math.max(8, options.rowHeight || 32);
    const rows = Math.max(1, options.rows | 0);
    const gap = Math.max(0, options.gap || 0);
    const freeAt = new Float64Array(rows);

    return {
      rows,
      rowHeight,
      /** 重置所有轨道（清屏 / 分辨率变化时调用） */
      reset() {
        freeAt.fill(0);
      },
      /** 某行当前可用的时间戳，主要给测试用 */
      freeAt(row) {
        return freeAt[row];
      },
      /**
       * 申请位置。
       * @param {{now:number,width:number,height:number,speed:number}} item
       * @returns {{row:number,y:number}|null}
       */
      allocate(item) {
        const now = Number(item.now) || 0;
        const speed = Math.max(1, Number(item.speed) || 1);
        const width = Math.max(0, Number(item.width) || 0);
        const span = Math.min(rows, Math.max(1, Math.ceil((Number(item.height) || rowHeight) / rowHeight)));

        for (let start = 0; start + span <= rows; start += 1) {
          let blocked = false;
          for (let k = 0; k < span; k += 1) {
            if (freeAt[start + k] > now) {
              blocked = true;
              break;
            }
          }
          if (blocked) continue;

          // 宽度 + 间距 走完所需时间（now 是毫秒，speed 是 px/秒）
          const occupyUntil = now + ((width + gap) / speed) * 1000;
          for (let k = 0; k < span; k += 1) freeAt[start + k] = occupyUntil;
          return { row: start, y: start * rowHeight };
        }
        return null;
      }
    };
  }

  /**
   * 命中测试：从后往前找最上面的一条（后面的绘制在上层）。
   * @param {Array<{x:number,y:number,w:number,h:number}>} items
   */
  function hitTest(items, x, y) {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (!it) continue;
      if (x >= it.x && x <= it.x + it.w && y >= it.y && y <= it.y + it.h) return it;
    }
    return null;
  }

  return { createLayout, hitTest };
});
