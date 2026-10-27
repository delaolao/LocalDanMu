'use strict';

/**
 * 过滤规则单测。
 * 运行：node scripts/test-filter.js
 */

const assert = require('assert');
const { createFilter } = require('../src/main/filter');

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

const block = createFilter({ level: 'block' });
const mark = createFilter({ level: 'mark' });
const off = createFilter({ level: 'off' });

console.log('\n联系方式与广告');

it('手机号被拦截', () => {
  const v = block.check('有事打我电话 13800138000');
  assert.strictEqual(v.blocked, true);
  assert.strictEqual(v.category, 'phone');
});

it('QQ 号被拦截', () => {
  assert.strictEqual(block.check('QQ：123456789').blocked, true);
});

it('微信号被拦截', () => {
  assert.strictEqual(block.check('加微信 abc_12345 领资料').blocked, true);
});

it('网址被拦截', () => {
  assert.strictEqual(block.check('看这个 https://example.com/x').blocked, true);
});

it('广告话术被拦截', () => {
  assert.strictEqual(block.check('扫码进群领优惠券').blocked, true);
});

console.log('\n脏话与插字规避');

it('普通脏话被拦截', () => {
  assert.strictEqual(block.check('你这个问题真傻逼').blocked, true);
});

it('中间插空格/符号也能拦住', () => {
  assert.strictEqual(block.check('傻 逼').blocked, true);
  assert.strictEqual(block.check('傻*逼').blocked, true);
  assert.strictEqual(block.check('傻　逼').blocked, true);
});

it('全角字符也能拦住', () => {
  assert.strictEqual(block.check('ＦＵＣＫ').blocked, true);
});

console.log('\n误杀与模式');

it('正常教学用语不误杀', () => {
  assert.strictEqual(block.check('这段内容是垃圾时间，可以跳过').blocked, false);
  assert.strictEqual(block.check('微信这个功能怎么用？').blocked, false);
  assert.strictEqual(block.check('培训很有收获').blocked, false);
});

it('mark 模式只标记不拦截', () => {
  const v = mark.check('傻逼');
  assert.strictEqual(v.blocked, false);
  assert.strictEqual(v.flagged, true);
});

it('off 模式全部放行', () => {
  const v = off.check('13800138000 傻逼');
  assert.strictEqual(v.blocked, false);
  assert.strictEqual(v.flagged, false);
});

console.log('\n自定义词表');

it('自定义词生效', () => {
  const custom = createFilter({ level: 'block', customWords: '竞品公司\n某品牌' });
  assert.strictEqual(custom.check('这个比某品牌好').blocked, true);
  assert.strictEqual(custom.check('今天天气不错').blocked, false);
});

it('自定义词支持逗号/换行混排', () => {
  const custom = createFilter({ level: 'block', customWords: '甲,乙、丙\n丁' });
  for (const word of ['甲', '乙', '丙', '丁']) {
    assert.strictEqual(custom.check(`说的是${word}吗`).blocked, true, word);
  }
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed === 0 ? 0 : 1);
