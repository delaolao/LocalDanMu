'use strict';

/**
 * 词云切词/聚合单测。
 * 运行：node scripts/test-words.js
 */

const assert = require('assert');
const { splitTerms, aggregate } = require('../src/renderer/cloud/words');

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

console.log('\n切词');

it('短句整条作为一个词', () => {
  assert.deepStrictEqual(splitTerms('太难了'), ['太难']);
});

it('去掉句尾语气词', () => {
  assert.deepStrictEqual(splitTerms('一般吧'), ['一般']);
  assert.deepStrictEqual(splitTerms('满意啊'), ['满意']);
});

it('带标点的长句按段切开', () => {
  assert.deepStrictEqual(splitTerms('讲得太快，跟不上。需要复习'), ['讲得太快', '跟不上', '需要复习']);
});

it('纯数字和空串被忽略', () => {
  assert.deepStrictEqual(splitTerms('123456'), []);
  assert.deepStrictEqual(splitTerms('   '), []);
});

it('超长段落按 6 字切块', () => {
  const out = splitTerms('这是一个特别特别长的没有标点的一句话用来测试切块逻辑');
  assert.ok(out.length >= 2);
  assert.ok(out.every((t) => Array.from(t).length <= 6));
});

console.log('\n聚合');

it('计数并排序', () => {
  const list = aggregate(['太难了', '太难', '一般', '太难了']);
  assert.strictEqual(list[0].word, '太难');
  assert.strictEqual(list[0].count, 3);
  assert.strictEqual(list[1].word, '一般');
});

it('相同意思的句尾语气词会合并', () => {
  const list = aggregate(['太难了', '太难啊']);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].count, 2);
});

it('max 限制生效', () => {
  const texts = Array.from({ length: 30 }, (_, i) => `词${i}`);
  assert.strictEqual(aggregate(texts, { max: 10 }).length, 10);
});

it('空输入返回空数组', () => {
  assert.deepStrictEqual(aggregate([]), []);
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
