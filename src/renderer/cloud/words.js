(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CloudWords = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * 词云用的切词与聚合。
   *
   * 现场互动大多是两三个字的短答（"太难""一般""满意"），所以：
   * - 短句（≤12 字）整条当一个词，语义最准；
   * - 长句按标点/空格切成小段，每段单独计数；
   * - 去掉句尾语气词（的/了/啊/吧…），让"太难了"和"太难"尽量合并。
   * 不做同义词合并，这是已知局限，现场引导大家发短词效果最好。
   */

  const SEPARATORS = /[，。！？、,.!?;；:：\s/\\|~～…\-—_()（）[\]【】"'"'""'']+/u;
  const TRAILING = /[的了吗啊吧呢呀哦嘛哈啦咯呗]+$/u;
  const LEADING = /^[的了吗啊吧呢呀哦嘛哈]+/u;
  const MAX_TERM = 12;
  const MIN_TERM = 1;

  function cleanTerm(raw) {
    let term = String(raw || '').trim();
    if (!term) return '';
    term = term.replace(LEADING, '').replace(TRAILING, '').trim();
    if (!term) return '';
    if (/^[\d\s.]+$/.test(term)) return '';
    return term;
  }

  /** 把一条弹幕拆成若干个候选项。 */
  function splitTerms(text) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return [];

    const parts = raw.split(SEPARATORS).filter(Boolean);
    if (!parts.length) return [];

    const out = [];
    for (const part of parts) {
      const term = cleanTerm(part);
      if (!term) continue;

      const chars = Array.from(term);
      if (chars.length <= MAX_TERM) {
        // 整条就是一个短词（"太难了" → "太难"），直接当一项
        out.push(term);
        continue;
      }
      // 长句里没有标点的一整段，按 6 字一节切开，宁可粗一点也别丢掉
      for (let i = 0; i < chars.length; i += 6) {
        const slice = chars.slice(i, i + 6).join('');
        if (slice) out.push(slice);
      }
    }
    return out;
  }

  /**
   * @param {string[]} texts
   * @param {{max?:number}} [opts]
   * @returns {{word:string,count:number}[]}
   */
  function aggregate(texts, opts) {
    const max = (opts && opts.max) || 60;
    const counts = new Map();
    const order = new Map();
    let seq = 0;

    for (const text of texts || []) {
      for (const term of splitTerms(text)) {
        if (!counts.has(term)) {
          counts.set(term, 0);
          order.set(term, seq++);
        }
        counts.set(term, counts.get(term) + 1);
      }
    }

    const list = Array.from(counts.entries()).map(([word, count]) => ({ word, count }));
    list.sort((a, b) => b.count - a.count || order.get(a.word) - order.get(b.word));
    return list.slice(0, max);
  }

  return { splitTerms, aggregate, cleanTerm };
});
