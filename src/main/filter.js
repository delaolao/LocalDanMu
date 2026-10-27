'use strict';

/**
 * 内容过滤
 *
 * 说明：中文互联网上所谓"敏感词库"绝大多数是政治审查词表，不适合内置到本产品。
 * 培训现场真正会出事的是三类：联系方式/导流、广告话术、以及现场辱骂。
 * 所以这里的策略是：
 *   1) 联系方式、网址、广告话术 —— 用规则匹配，最有效且误杀低；
 *   2) 内置一份约 50 条的通用脏话（不含任何政治词），可整体关闭；
 *   3) 讲师自定义词表，支持一行一个；想接更大的词库自行导入即可。
 *
 * 匹配用前缀树（DFA），文本先做归一化，能挡住"傻 逼""傻*逼"这类插字符规避。
 */

const WORDS = [
  // 通用辱骂
  '傻逼',
  '沙比',
  '煞笔',
  '傻b',
  '傻叉',
  '傻帽',
  '智障',
  '脑残',
  '弱智',
  '白痴',
  '废物',
  '滚蛋',
  '滚开',
  '去死',
  '死全家',
  '你妈',
  '你妈的',
  '妈的',
  '他妈',
  '尼玛',
  '尼马',
  '卧槽',
  '我操',
  '我艹',
  '操你',
  '草泥马',
  '草你妈',
  '日你',
  '干你',
  '贱人',
  '婊子',
  '妓女',
  '混蛋',
  '王八蛋',
  '畜生',
  '杂种',
  '狗东西',
  '狗日的',
  '日了狗',
  '不要脸',
  // 英文
  'fuck',
  'fucking',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'dick',
  'cunt'
];

const RULES = [
  {
    id: 'phone',
    label: '手机号',
    re: /(?<!\d)1[3-9]\d{9}(?!\d)/
  },
  {
    id: 'qq',
    label: 'QQ 号',
    re: /(?:qq|扣扣|企鹅|球球)\s*[:：]?\s*\d{5,11}/i
  },
  {
    id: 'wechat',
    label: '微信号',
    re: /(?:微信|weixin|vx|v信|威信|薇信)\s*[:：]?\s*[a-z0-9_-]{5,20}/i
  },
  {
    id: 'url',
    label: '网址',
    re: /(?:https?:\/\/|www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)+/i
  },
  {
    id: 'ad',
    label: '广告/导流',
    re: /(加群|进群|加v|加微|私信我|扫码加|返利|优惠券|代购|刷单|日结|贷款|博彩|下注|拉人)/i
  }
];

/** 全角转半角、去零宽、压缩空白、统一小写。保留标点，供规则匹配使用。 */
function normalizeLoose(text) {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ');
}

/** 再做一层：只保留文字和数字，符号空格全部去掉，用于防插字规避。 */
function normalizeStrict(text) {
  return normalizeLoose(text).replace(/[^\p{L}\p{N}]+/gu, '');
}

function buildTrie(words) {
  const root = Object.create(null);
  let count = 0;
  for (const raw of words) {
    const key = normalizeStrict(raw);
    if (!key) continue;
    let node = root;
    for (const ch of key) {
      if (!node[ch]) node[ch] = Object.create(null);
      node = node[ch];
    }
    node['$'] = true;
    count += 1;
  }
  return { root, count };
}

function matchTrie(trie, strictText) {
  const root = trie.root;
  let node = root;
  let matched = '';
  let start = -1;
  const chars = Array.from(strictText);
  for (let i = 0; i < chars.length; i += 1) {
    node = root;
    let j = i;
    let word = '';
    let found = '';
    while (j < chars.length && node[chars[j]]) {
      node = node[chars[j]];
      word += chars[j];
      if (node['$']) found = word;
      j += 1;
    }
    if (found && found.length > matched.length) {
      matched = found;
      start = i;
    }
  }
  return matched ? { word: matched, start } : null;
}

function parseCustomWords(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\r\n,，、;；]+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .slice(0, 2000);
}

/**
 * @param {{level:'off'|'mark'|'block', customWords?:string}} opts
 */
function createFilter(opts) {
  const level = opts && opts.level ? opts.level : 'block';
  const custom = parseCustomWords(opts && opts.customWords);
  const trie = buildTrie(WORDS.concat(custom));

  return {
    level,
    wordCount: trie.count,
    /**
     * @returns {{blocked:boolean, flagged:boolean, category?:string, word?:string}}
     */
    check(text) {
      if (level === 'off') return { blocked: false, flagged: false };

      const loose = normalizeLoose(text);

      for (const rule of RULES) {
        if (rule.re.test(loose)) {
          return {
            blocked: level === 'block',
            flagged: true,
            category: rule.id,
            word: rule.label
          };
        }
      }

      const hit = matchTrie(trie, normalizeStrict(text));
      if (hit) {
        return {
          blocked: level === 'block',
          flagged: true,
          category: custom.includes(hit.word) ? 'custom' : 'profanity',
          word: hit.word
        };
      }

      return { blocked: false, flagged: false };
    }
  };
}

module.exports = { createFilter, normalizeLoose, normalizeStrict, parseCustomWords, WORDS, RULES };
