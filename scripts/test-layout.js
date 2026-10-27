'use strict';

/**
 * 轨道分配单测：保证同一条轨道不会刚发车就压上一条，
 * 也保证长卡片能占到连续的多行。
 *
 * 运行：node scripts/test-layout.js
 */

const assert = require('assert');
const { createLayout, hitTest } = require('../src/renderer/danmaku/layout');

let passed = 0;
let failed = 0;

function it(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

console.log('\n轨道分配');

it('同一时刻 6 条各占一行', () => {
  const layout = createLayout({ rows: 6, rowHeight: 50, gap: 20 });
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    const slot = layout.allocate({ now: 0, width: 400, height: 50, speed: 500 });
    assert.ok(slot, `第 ${i + 1} 条应能放下`);
    rows.push(slot.row);
  }
  assert.deepStrictEqual(rows, [0, 1, 2, 3, 4, 5]);
  assert.strictEqual(layout.allocate({ now: 0, width: 400, height: 50, speed: 500 }), null);
});

it('上一条尾巴进场后即可复用该行（不必等它飞出屏幕）', () => {
  const layout = createLayout({ rows: 2, rowHeight: 50, gap: 20 });
  layout.allocate({ now: 0, width: 400, height: 50, speed: 500 });
  layout.allocate({ now: 0, width: 400, height: 50, speed: 500 });

  // (400 + 20) / 500 = 0.84s 后，第一条已完全进入屏幕
  assert.strictEqual(layout.allocate({ now: 700, width: 400, height: 50, speed: 500 }), null);
  const slot = layout.allocate({ now: 850, width: 400, height: 50, speed: 500 });
  assert.ok(slot);
  assert.strictEqual(slot.row, 0);
});

it('多行卡片占用连续轨道', () => {
  const layout = createLayout({ rows: 6, rowHeight: 50, gap: 20 });
  // 占 3 行（120px / 50px 向上取整）
  const slot = layout.allocate({ now: 0, width: 300, height: 120, speed: 400 });
  assert.strictEqual(slot.row, 0);
  // 第 2、3 行被占了，下一条单行只能从第 4 行开始
  const next = layout.allocate({ now: 0, width: 300, height: 50, speed: 400 });
  assert.strictEqual(next.row, 3);
});

it('多行卡片找不到连续空位时返回 null', () => {
  const layout = createLayout({ rows: 3, rowHeight: 50, gap: 20 });
  layout.allocate({ now: 0, width: 100, height: 50, speed: 1000 }); // 行 0
  layout.allocate({ now: 0, width: 100, height: 50, speed: 1000 }); // 行 1
  layout.allocate({ now: 0, width: 100, height: 50, speed: 1000 }); // 行 2
  assert.strictEqual(layout.allocate({ now: 0, width: 100, height: 120, speed: 1000 }), null);
});

it('reset 后全部轨道恢复可用', () => {
  const layout = createLayout({ rows: 2, rowHeight: 50, gap: 20 });
  layout.allocate({ now: 0, width: 400, height: 50, speed: 100 });
  layout.allocate({ now: 0, width: 400, height: 50, speed: 100 });
  assert.strictEqual(layout.allocate({ now: 0, width: 400, height: 50, speed: 100 }), null);
  layout.reset();
  assert.ok(layout.allocate({ now: 0, width: 400, height: 50, speed: 100 }));
});

it('宽度相同但速度更快时更早释放', () => {
  const slow = createLayout({ rows: 1, rowHeight: 50, gap: 20 });
  const fast = createLayout({ rows: 1, rowHeight: 50, gap: 20 });
  slow.allocate({ now: 0, width: 500, height: 50, speed: 200 });
  fast.allocate({ now: 0, width: 500, height: 50, speed: 800 });
  assert.strictEqual(slow.allocate({ now: 2000, width: 500, height: 50, speed: 200 }), null);
  assert.ok(fast.allocate({ now: 2000, width: 500, height: 50, speed: 800 }));
});

console.log('\n命中测试');

it('点在矩形内命中', () => {
  const items = [{ x: 100, y: 50, w: 200, h: 90 }];
  assert.strictEqual(hitTest(items, 150, 80), items[0]);
});

it('点在矩形外不命中', () => {
  const items = [{ x: 100, y: 50, w: 200, h: 90 }];
  assert.strictEqual(hitTest(items, 99, 80), null);
  assert.strictEqual(hitTest(items, 150, 141), null);
});

it('重叠时取后绘制（更靠上）的那条', () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  const b = { x: 50, y: 50, w: 100, h: 100 };
  assert.strictEqual(hitTest([a, b], 60, 60), b);
});

it('空列表返回 null', () => {
  assert.strictEqual(hitTest([], 10, 10), null);
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);process.exit(failed === 0 ? 0 : 1);
