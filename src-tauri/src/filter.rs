//! 内容过滤。与旧版 `src/main/filter.js` 行为对齐。
//!
//! 策略（沿用旧版判断）：中文互联网上所谓"敏感词库"绝大多数是政治审查词表，不适合内置于本产品。
//! 培训现场真正会出事的是三类：联系方式/导流、广告话术、现场辱骂。所以：
//!   1) 联系方式、网址、广告话术 —— 用规则匹配，最有效且误杀低；
//!   2) 内置一份约 50 条通用脏话（不含任何政治词），可整体关闭；
//!   3) 讲师自定义词表，支持一行一个；想接更大的词库自行导入。
//!
//! 实现上有两处与旧版不同，但外部行为一致：
//!
//! - 旧版手写前缀树（DFA）做多词匹配，这里用 `aho-corasick`，取"最长命中"，
//!   语义与旧版 `matchTrie` 的"全局最长匹配"一致，但更快且不用自己维护状态机。
//! - **Rust 的 regex 不支持 lookaround**（`(?<!\d)1[3-9]\d{9}(?!\d)` 这种写法编译不过），
//!   手机号规则改写成 `(?:^|[^0-9])1[3-9][0-9]{9}(?:[^0-9]|$)`。
//!   我们只关心"是否命中"，所以边界字符被一起吃掉不影响判定。

use std::sync::OnceLock;

use aho_corasick::AhoCorasick;
use regex::Regex;
use unicode_normalization::UnicodeNormalization;

/// 内置通用辱骂词（不含任何政治词）。与旧版 WORDS 完全一致。
pub const BUILTIN_WORDS: &[&str] = &[
    "傻逼", "沙比", "煞笔", "傻b", "傻叉", "傻帽", "智障", "脑残", "弱智", "白痴", "废物", "滚蛋",
    "滚开", "去死", "死全家", "你妈", "你妈的", "妈的", "他妈", "尼玛", "尼马", "卧槽", "我操",
    "我艹", "操你", "草泥马", "草你妈", "日你", "干你", "贱人", "婊子", "妓女", "混蛋", "王八蛋",
    "畜生", "杂种", "狗东西", "狗日的", "日了狗", "不要脸", //
    "fuck", "fucking", "shit", "bitch", "asshole", "bastard", "dick", "cunt",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Off,
    Mark,
    Block,
}

impl Level {
    pub fn parse(raw: &str) -> Level {
        match raw {
            "off" => Level::Off,
            "mark" => Level::Mark,
            _ => Level::Block,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub blocked: bool,
    pub flagged: bool,
    pub category: Option<String>,
    pub word: Option<String>,
}

impl Verdict {
    fn clean() -> Verdict {
        Verdict { blocked: false, flagged: false, category: None, word: None }
    }
}

struct Rule {
    id: &'static str,
    label: &'static str,
    re: Regex,
}

fn rules() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let mk = |id, label, pat: &str| Rule {
            id,
            label,
            re: Regex::new(pat).expect("内置过滤规则写错了"),
        };
        vec![
            // 旧版：(?<!\d)1[3-9]\d{9}(?!\d)
            mk("phone", "手机号", r"(?:^|[^0-9])1[3-9][0-9]{9}(?:[^0-9]|$)"),
            mk("qq", "QQ 号", r"(?:qq|扣扣|企鹅|球球)\s*[:：]?\s*[0-9]{5,11}"),
            mk(
                "wechat",
                "微信号",
                r"(?:微信|weixin|vx|v信|威信|薇信)\s*[:：]?\s*[a-z0-9_-]{5,20}",
            ),
            mk("url", "网址", r"(?:https?://|www\.)[a-z0-9-]+(?:\.[a-z0-9-]+)+"),
            mk(
                "ad",
                "广告/导流",
                r"(加群|进群|加v|加微|私信我|扫码加|返利|优惠券|代购|刷单|日结|贷款|博彩|下注|拉人)",
            ),
        ]
    })
}

/// 宽松归一化：NFKC（全角转半角）、小写、去零宽/方向覆写字符、压缩空白。
/// 保留标点，供正则规则使用。
pub fn normalize_loose(text: &str) -> String {
    let nfkc: String = text.nfkc().collect();
    let lowered = nfkc.to_lowercase();
    let stripped: String = lowered
        .chars()
        .filter(|c| !is_invisible(*c))
        .collect();
    // 压缩空白（含全角空格经 NFKC 之后变成的普通空格）
    let mut out = String::with_capacity(stripped.len());
    let mut last_space = false;
    for c in stripped.chars() {
        let is_space = c.is_whitespace();
        if is_space {
            if !last_space {
                out.push(' ');
            }
        } else {
            out.push(c);
        }
        last_space = is_space;
    }
    out
}

/// 严格归一化：再去掉一切非字母数字，用来对抗「傻 逼」「傻*逼」这类插字规避。
pub fn normalize_strict(text: &str) -> String {
    normalize_loose(text)
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// 零宽字符与方向覆写符（可用于伪装文字）。
fn is_invisible(c: char) -> bool {
    matches!(c,
        '\u{200B}'..='\u{200F}'
        | '\u{202A}'..='\u{202E}'
        | '\u{2066}'..='\u{2069}'
        | '\u{FEFF}'
    )
}

/// 解析自定义词表：换行 / 中英文逗号 / 顿号 / 分号都能分隔，最多 2000 条。
pub fn parse_custom_words(raw: &str) -> Vec<String> {
    raw.split(|c| matches!(c, '\r' | '\n' | ',' | '，' | '、' | ';' | '；'))
        .map(|w| w.trim().to_string())
        .filter(|w| !w.is_empty())
        .take(2000)
        .collect()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WordKind {
    Profanity,
    Custom,
}

pub struct Filter {
    level: Level,
    matcher: AhoCorasick,
    kinds: Vec<WordKind>,
    pub word_count: usize,
}

impl Filter {
    pub fn new(level: Level, custom_words: &str) -> Filter {
        let custom = parse_custom_words(custom_words);
        let mut patterns: Vec<String> = Vec::new();
        let mut kinds: Vec<WordKind> = Vec::new();

        for w in BUILTIN_WORDS {
            let key = normalize_strict(w);
            if !key.is_empty() {
                patterns.push(key);
                kinds.push(WordKind::Profanity);
            }
        }
        for w in &custom {
            let key = normalize_strict(w);
            if !key.is_empty() {
                patterns.push(key);
                kinds.push(WordKind::Custom);
            }
        }

        let word_count = patterns.len();
        let matcher = AhoCorasick::builder()
            .match_kind(aho_corasick::MatchKind::Standard)
            .build(&patterns)
            .unwrap_or_else(|_| {
                // 极端情况下（例如词表里有诡异字符）退化成空匹配器，绝不 panic：
                // 教学现场不能因为一份词表把整个程序带崩。
                AhoCorasick::new(Vec::<String>::new()).expect("空词表必然可构造")
            });

        Filter { level, matcher, kinds, word_count }
    }

    /// 从设置构造（设置里的 `filterLevel` / `customWords`）。
    pub fn from_settings(level: &str, custom_words: &str) -> Filter {
        Filter::new(Level::parse(level), custom_words)
    }

    pub fn check(&self, text: &str) -> Verdict {
        if self.level == Level::Off {
            return Verdict::clean();
        }

        let loose = normalize_loose(text);
        for rule in rules() {
            if rule.re.is_match(&loose) {
                return Verdict {
                    blocked: self.level == Level::Block,
                    flagged: true,
                    category: Some(rule.id.to_string()),
                    word: Some(rule.label.to_string()),
                };
            }
        }

        let strict = normalize_strict(text);
        if let Some(longest) = self.longest_hit(&strict) {
            let category = match self.kinds.get(longest.0) {
                Some(WordKind::Custom) => "custom",
                _ => "profanity",
            };
            return Verdict {
                blocked: self.level == Level::Block,
                flagged: true,
                category: Some(category.to_string()),
                word: Some(longest.1),
            };
        }

        Verdict::clean()
    }

    /// 取"最长命中"。旧版是每个起点都走一遍前缀树再保留全局最长，语义等价。
    fn longest_hit(&self, strict: &str) -> Option<(usize, String)> {
        if strict.is_empty() || self.word_count == 0 {
            return None;
        }
        let mut best: Option<(usize, usize, String)> = None;
        for m in self.matcher.find_overlapping_iter(strict) {
            let len = m.end() - m.start();
            let better = match &best {
                Some((_, best_len, _)) => len > *best_len,
                None => true,
            };
            if better {
                best = Some((m.pattern().as_usize(), len, strict[m.start()..m.end()].to_string()));
            }
        }
        best.map(|(pat, _, word)| (pat, word))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block() -> Filter {
        Filter::new(Level::Block, "")
    }

    #[test]
    fn blocks_contact_and_ads() {
        assert_eq!(block().check("有事打我电话 13800138000").category.as_deref(), Some("phone"));
        assert!(block().check("QQ：123456789").blocked);
        assert!(block().check("加微信 abc_12345 领资料").blocked);
        assert!(block().check("看这个 https://example.com/x").blocked);
        assert!(block().check("扫码进群领优惠券").blocked);
    }

    #[test]
    fn phone_rule_needs_real_boundaries() {
        assert!(block().check("13800138000").blocked, "整条就是手机号");
        assert!(block().check("电话13800138000。").blocked, "中文句号收尾");
        // 12 位数字不是手机号
        assert!(!block().check("213800138000").blocked);
    }

    #[test]
    fn blocks_profanity_including_evasions() {
        assert!(block().check("你这个问题真傻逼").blocked);
        assert!(block().check("傻 逼").blocked, "插空格");
        assert!(block().check("傻*逼").blocked, "插符号");
        assert!(block().check("傻　逼").blocked, "插全角空格");
        assert!(block().check("ＦＵＣＫ").blocked, "全角字母");
    }

    #[test]
    fn no_false_positives_on_normal_teaching_talk() {
        assert!(!block().check("这段内容是垃圾时间，可以跳过").blocked);
        assert!(!block().check("微信这个功能怎么用？").blocked);
        assert!(!block().check("培训很有收获").blocked);
    }

    #[test]
    fn mark_mode_flags_but_allows() {
        let f = Filter::new(Level::Mark, "");
        let v = f.check("傻逼");
        assert!(!v.blocked);
        assert!(v.flagged);
    }

    #[test]
    fn off_mode_lets_everything_through() {
        let f = Filter::new(Level::Off, "");
        let v = f.check("13800138000 傻逼");
        assert!(!v.blocked);
        assert!(!v.flagged);
    }

    #[test]
    fn custom_words_work_and_are_labelled() {
        let f = Filter::new(Level::Block, "竞品公司\n某品牌");
        assert!(f.check("这个比某品牌好").blocked);
        assert_eq!(f.check("这个比某品牌好").category.as_deref(), Some("custom"));
        assert!(!f.check("今天天气不错").blocked);
    }

    #[test]
    fn custom_words_accept_mixed_separators() {
        let f = Filter::new(Level::Block, "甲,乙、丙\n丁");
        for w in ["甲", "乙", "丙", "丁"] {
            assert!(f.check(&format!("说的是{w}吗")).blocked, "{w} 应该命中");
        }
    }

    #[test]
    fn longest_match_wins() {
        // "你妈的" 和 "你妈" 都在词库里，应该报最长的那个
        let f = block();
        let v = f.check("你妈的");
        assert_eq!(v.word.as_deref(), Some("你妈的"));
    }

    #[test]
    fn normalization_handles_zero_width_and_fullwidth() {
        assert_eq!(normalize_strict("傻\u{200B}逼"), "傻逼");
        assert_eq!(normalize_strict("  傻  逼  "), "傻逼");
        assert_eq!(normalize_loose("ＨＥＬＬＯ　ＷＯＲＬＤ"), "hello world");
    }

    #[test]
    fn custom_word_parsing() {
        assert_eq!(parse_custom_words("a,b、c\nd"), vec!["a", "b", "c", "d"]);
        assert!(parse_custom_words("").is_empty());
        assert_eq!(parse_custom_words("   ").len(), 0);
    }

    #[test]
    fn empty_wordlist_never_panics() {
        let f = Filter::new(Level::Block, "");
        assert!(!f.check("完全正常的一句话").blocked);
    }
}
