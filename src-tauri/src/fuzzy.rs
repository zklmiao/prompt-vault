//! `src/util.ts` 纯函数的 Rust 移植:模糊匹配(fuzzyMatch/matchPrompt)
//! 与占位符(extractPlaceholders/fillPlaceholders)。
//! 对齐基准:regression/util.test.ts 的 U3/U4/U7 用例子集,见文末单测。
//!
//! MCP headless 与 GUI 必须给出完全一致的评分,否则检索排序会漂移。

use std::collections::HashMap;

/* ---------- 占位符 ---------- */

/// PLACEHOLDER_RE = /(?<!\{)\{\{([^{}]+)\}\}(?!\})/g 的等价手写扫描。
/// Rust regex 不支持 lookbehind,按字符实现:
/// `{{` 前一个字符不能是 `{`;内容不含 `{}`;结尾 `}}` 后一个字符不能是 `}`。
struct PlaceholderSpan {
    /// 整个 {{名称}} 的字符区间 [start, end)
    whole: (usize, usize),
    /// 名称内容的字符区间 [start, end)
    name: (usize, usize),
}

fn scan_placeholders(chars: &[char]) -> Vec<PlaceholderSpan> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < chars.len() {
        let opens = chars[i] == '{' && chars[i + 1] == '{' && (i == 0 || chars[i - 1] != '{');
        if opens {
            let content_start = i + 2;
            let mut j = content_start;
            while j < chars.len() && chars[j] != '{' && chars[j] != '}' {
                j += 1;
            }
            // 需要非空内容 + 紧跟 }} + }} 后不是 }(三者都满足才算命中,
            // 任一不满足时正则会整体回退,这里等价地只前进一格)
            if j + 1 < chars.len()
                && chars[j] == '}'
                && chars[j + 1] == '}'
                && j > content_start
                && !(j + 2 < chars.len() && chars[j + 2] == '}')
            {
                out.push(PlaceholderSpan {
                    whole: (i, j + 2),
                    name: (content_start, j),
                });
                i = j + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// 提取正文里的 {{变量}} 名(先 trim;空名跳过;按出现顺序去重)
pub fn extract_placeholders(body: &str) -> Vec<String> {
    let chars: Vec<char> = body.chars().collect();
    let mut out: Vec<String> = Vec::new();
    for m in scan_placeholders(&chars) {
        let name: String = chars[m.name.0..m.name.1].iter().collect();
        let name = name.trim();
        if !name.is_empty() && !out.iter().any(|s| s == name) {
            out.push(name.to_string());
        }
    }
    out
}

/// 用填写值替换占位符;留空(或缺键)的保持 {{原名}} 原样。
/// 键按「占位符内容 trim 后」查找,与前端 fillPlaceholders 一致。
pub fn fill_placeholders(body: &str, values: &HashMap<String, String>) -> String {
    let chars: Vec<char> = body.chars().collect();
    let spans = scan_placeholders(&chars);
    let mut out = String::with_capacity(body.len());
    let mut cursor = 0;
    for m in spans {
        let (ws, we) = m.whole;
        out.extend(chars[cursor..ws].iter());
        let raw: String = chars[ws..we].iter().collect();
        let name: String = chars[m.name.0..m.name.1].iter().collect();
        let filled = values
            .get(name.trim())
            .filter(|v| !v.is_empty())
            .cloned()
            .unwrap_or(raw);
        out.push_str(&filled);
        cursor = we;
    }
    out.extend(chars[cursor..].iter());
    out
}

/* ---------- 模糊匹配 ---------- */

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchRange {
    /// 起始下标(含)
    pub start: usize,
    /// 结束下标(不含)
    pub end: usize,
}

#[derive(Debug, Clone)]
pub struct FuzzyMatch {
    pub score: i64,
    pub ranges: Vec<MatchRange>,
}

/// 参与匹配的字段视图;由数据层实现(前端 PromptItem 的 Rust 对应物)
pub trait MatchFields {
    fn title(&self) -> &str;
    fn tags(&self) -> &[String];
    fn source(&self) -> &str;
    fn note(&self) -> &str;
    fn body(&self) -> &str;
}

fn merge_ranges(mut ranges: Vec<MatchRange>) -> Vec<MatchRange> {
    if ranges.len() <= 1 {
        return ranges;
    }
    ranges.sort_by_key(|r| r.start);
    let mut out: Vec<MatchRange> = Vec::with_capacity(ranges.len());
    for cur in ranges {
        match out.last_mut() {
            Some(last) if cur.start <= last.end => {
                last.end = last.end.max(cur.end);
            }
            _ => out.push(cur),
        }
    }
    out
}

fn find_subslice(hay: &[char], needle: &[char]) -> Option<usize> {
    if needle.len() > hay.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

/// JS 正则 \s 是 Unicode 感知的(char::is_whitespace 覆盖其全集,仅差 U+FEFF)
fn is_word_boundary_char(c: char) -> bool {
    c.is_whitespace()
        || c == '\u{feff}'
        || matches!(
            c,
            '-' | '_'
                | '/'
                | '.'
                | ','
                | ';'
                | ':'
                | '!'
                | '?'
                | '('
                | ')'
                | '['
                | ']'
                | '{'
                | '}'
                | '"'
                | '\''
                | '`'
                | '#'
                | '@'
                | '、'
                | '，'
                | '。'
                | '；'
                | '：'
                | '！'
                | '？'
                | '\u{ff08}' // (
                | '\u{ff09}' // )
                | '【'
                | '】'
                | '《'
                | '》'
        )
}

fn is_word_start(text_chars: &[char], index: usize) -> bool {
    if index == 0 {
        return true;
    }
    is_word_boundary_char(text_chars[index - 1])
}

/// 子序列模糊匹配:query 的每个字符按顺序出现在 text 中即命中。
/// 打分:单字符 10 分;连续命中额外 +6×连续长度;词首额外 +8;
/// 完整子串直接给高分(100 + 4×长度 + 起始位置奖励)。
/// 中文按字符匹配,不做拼音。下标均为字符位置。
pub fn fuzzy_match(query: &str, text: &str) -> Option<FuzzyMatch> {
    let q: Vec<char> = query.trim().to_lowercase().chars().collect();
    if q.is_empty() {
        return None;
    }
    let t: Vec<char> = text.to_lowercase().chars().collect();
    if t.is_empty() {
        return None;
    }

    if let Some(sub) = find_subslice(&t, &q) {
        let score = 100 + (q.len() as i64) * 4 + 0.max(20 - sub as i64);
        return Some(FuzzyMatch {
            score,
            ranges: vec![MatchRange {
                start: sub,
                end: sub + q.len(),
            }],
        });
    }

    // 词首加分参照原始文本(与 TS 的 isWordStart(text, i) 一致)
    let text_chars: Vec<char> = text.chars().collect();
    let mut ranges: Vec<MatchRange> = Vec::new();
    let mut score: i64 = 0;
    let mut qi = 0;
    let mut last_index: isize = -2;
    let mut run: i64 = 0;
    for (i, &tc) in t.iter().enumerate() {
        if qi >= q.len() {
            break;
        }
        if tc != q[qi] {
            continue;
        }
        let consecutive = (i as isize) == last_index + 1;
        run = if consecutive { run + 1 } else { 0 };
        let word_bonus: i64 = if is_word_start(&text_chars, i) { 8 } else { 0 };
        score += 10 + (if consecutive { 6 * run } else { 0 }) + word_bonus;
        ranges.push(MatchRange {
            start: i,
            end: i + 1,
        });
        last_index = i as isize;
        qi += 1;
    }
    if qi < q.len() {
        return None;
    }

    let span = (ranges.last().unwrap().end - ranges.first().unwrap().start) as i64;
    score += 0.max(30 - span / 2);
    Some(FuzzyMatch {
        score,
        ranges: merge_ranges(ranges),
    })
}

const SNIPPET_LEAD: usize = 24;
const SNIPPET_TAIL: usize = 40;

/// 正文命中且标题/标签未命中时给一行片段:换行替换为空格,前后截断补省略号
fn make_snippet(text: &str, ranges: &[MatchRange]) -> String {
    let chars: Vec<char> = text.chars().collect();
    let first = ranges.first().unwrap();
    let last = ranges.last().unwrap();
    let start = first.start.saturating_sub(SNIPPET_LEAD);
    let end = chars.len().min(last.end + SNIPPET_TAIL);
    let prefix = if start > 0 { "…" } else { "" };
    let suffix = if end < chars.len() { "…" } else { "" };
    let mut slice = String::with_capacity(end - start);
    for &c in &chars[start..end] {
        slice.push(if c == '\n' || c == '\r' { ' ' } else { c });
    }
    format!("{prefix}{slice}{suffix}")
}

const FIELD_WEIGHT_TITLE: f64 = 3.0;
const FIELD_WEIGHT_TAG: f64 = 2.0;
const FIELD_WEIGHT_SOURCE: f64 = 1.5;
const FIELD_WEIGHT_NOTE: f64 = 1.0;
const FIELD_WEIGHT_BODY: f64 = 1.0;

#[derive(Debug, Clone)]
pub struct PromptMatch {
    /// 全字段加权总分(标题×3 / 标签×2 / 来源×1.5 / 备注×1 / 正文×1)
    pub score: f64,
    /// 仅当正文命中且标题/标签未命中时生成
    pub body_snippet: Option<String>,
}

/// 对单条 prompt 做全字段匹配并加权评分
pub fn match_prompt<M: MatchFields + ?Sized>(query: &str, item: &M) -> Option<PromptMatch> {
    let q = query.trim();
    if q.is_empty() {
        return None;
    }

    let title = fuzzy_match(q, item.title());
    let tags: Vec<Option<FuzzyMatch>> = item.tags().iter().map(|t| fuzzy_match(q, t)).collect();
    let best_tag = tags
        .iter()
        .flatten()
        .max_by(|a, b| a.score.cmp(&b.score))
        .cloned();
    let source = fuzzy_match(q, item.source());
    let note = fuzzy_match(q, item.note());
    let body = fuzzy_match(q, item.body());

    if title.is_none()
        && best_tag.is_none()
        && source.is_none()
        && note.is_none()
        && body.is_none()
    {
        return None;
    }

    let mut score = 0.0;
    if let Some(m) = &title {
        score += m.score as f64 * FIELD_WEIGHT_TITLE;
    }
    if let Some(m) = &best_tag {
        score += m.score as f64 * FIELD_WEIGHT_TAG;
    }
    if let Some(m) = &source {
        score += m.score as f64 * FIELD_WEIGHT_SOURCE;
    }
    if let Some(m) = &note {
        score += m.score as f64 * FIELD_WEIGHT_NOTE;
    }
    if let Some(m) = &body {
        score += m.score as f64 * FIELD_WEIGHT_BODY;
    }

    let body_snippet = match (&body, &title, &best_tag) {
        (Some(b), None, None) => Some(make_snippet(item.body(), &b.ranges)),
        _ => None,
    };

    Some(PromptMatch {
        score,
        body_snippet,
    })
}

/* ---------- 单测(对齐 regression/util.test.ts U3/U4/U7 子集) ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    struct TestItem {
        title: String,
        tags: Vec<String>,
        source: String,
        note: String,
        body: String,
    }

    impl MatchFields for TestItem {
        fn title(&self) -> &str {
            &self.title
        }
        fn tags(&self) -> &[String] {
            &self.tags
        }
        fn source(&self) -> &str {
            &self.source
        }
        fn note(&self) -> &str {
            &self.note
        }
        fn body(&self) -> &str {
            &self.body
        }
    }

    fn item(title: &str, body: &str) -> TestItem {
        TestItem {
            title: title.to_string(),
            tags: vec![],
            source: String::new(),
            note: String::new(),
            body: body.to_string(),
        }
    }

    fn tags_item(tags: &[&str]) -> TestItem {
        TestItem {
            title: String::new(),
            tags: tags.iter().map(|s| s.to_string()).collect(),
            source: String::new(),
            note: String::new(),
            body: String::new(),
        }
    }

    /* ---- U7 模糊匹配 ---- */

    #[test]
    fn substring_hit_ranges_and_score() {
        let m = fuzzy_match("代码", "复习代码审查").unwrap();
        // 子串:100 + 4×2 + max(0, 20-2) = 126
        assert_eq!(m.score, 126);
        assert_eq!(
            m.ranges,
            vec![MatchRange {
                start: 2,
                end: 4
            }]
        );
    }

    #[test]
    fn case_insensitive() {
        let m = fuzzy_match("ABC", "xabcx").unwrap();
        // 子串:100 + 4×3 + max(0, 20-1) = 131
        assert_eq!(m.score, 131);
        assert_eq!(
            m.ranges,
            vec![MatchRange {
                start: 1,
                end: 4
            }]
        );
        let m = fuzzy_match("sql", "SQL 优化").unwrap();
        // 子串在起点:100 + 12 + 20 = 132
        assert_eq!(m.score, 132);
        assert_eq!(
            m.ranges,
            vec![MatchRange {
                start: 0,
                end: 3
            }]
        );
    }

    #[test]
    fn subsequence_hit_and_reverse_miss() {
        let m = fuzzy_match("代审", "代码审查").unwrap();
        // 代:10+词首8 = 18;审:10(非连续、非词首);跨度 3 → +29 = 57
        assert_eq!(m.score, 57);
        assert_eq!(
            m.ranges,
            vec![
                MatchRange {
                    start: 0,
                    end: 1
                },
                MatchRange {
                    start: 2,
                    end: 3
                }
            ]
        );
        assert!(fuzzy_match("审代", "代码审查").is_none());
    }

    #[test]
    fn empty_query_empty_text_incomplete_subsequence() {
        assert!(fuzzy_match("  ", "文本").is_none());
        assert!(fuzzy_match("q", "").is_none());
        assert!(fuzzy_match("abcd", "abc").is_none());
    }

    #[test]
    fn word_start_bonus_only_in_subsequence_path() {
        // "a b":两字符都在词首(下标 0 / 空格后);"xaqb":两字符都在词中。
        // 两文本都不含子串 "ab"。36+29=65 vs 20+29=49
        let word_start = fuzzy_match("ab", "a b").unwrap();
        let mid_word = fuzzy_match("ab", "xaqb").unwrap();
        assert_eq!(word_start.score, 65);
        assert_eq!(mid_word.score, 49);
        assert!(
            word_start.score > mid_word.score,
            "{} 应 > {}",
            word_start.score,
            mid_word.score
        );
    }

    #[test]
    fn match_prompt_field_weights_title_beats_body() {
        let by_title = match_prompt("sql", &item("SQL 优化", "无关正文")).unwrap();
        let by_body = match_prompt("sql", &item("别的", "这里讲 sql")).unwrap();
        // 标题子串 132×3 = 396;正文子串(起始 4)128×1 = 128
        assert_eq!(by_title.score, 396.0);
        assert_eq!(by_body.score, 128.0);
        assert!(by_title.score > by_body.score);
    }

    #[test]
    fn tag_field_weight_applies() {
        let by_tag = match_prompt("编码", &tags_item(&["编码"])).unwrap();
        // 标签子串在起点:100 + 4×2 + 20 = 128,×2 = 256
        assert_eq!(by_tag.score, 256.0);
    }

    #[test]
    fn snippet_only_when_body_hit_and_title_tags_miss() {
        let snip = match_prompt(
            "执行计划",
            &TestItem {
                title: "SQL 优化分析".into(),
                tags: vec!["编码".into()],
                source: String::new(),
                note: String::new(),
                body: "给出:执行计划分析".into(),
            },
        )
        .unwrap();
        assert_eq!(snip.body_snippet.as_deref(), Some("给出:执行计划分析"));

        let no_snip = match_prompt("sql", &item("SQL 模板", "sql 正文")).unwrap();
        assert!(no_snip.body_snippet.is_none());
    }

    #[test]
    fn snippet_boundaries_ellipsis_and_newline() {
        let long = format!("{}关键词{}", "前".repeat(60), "后".repeat(80));
        let m = match_prompt("关键词", &item("t", &long)).unwrap();
        let s = m.body_snippet.unwrap();
        assert!(s.starts_with('…') && s.ends_with('…'), "{s}");
        assert!(!s.contains('\n'));

        let with_nl = match_prompt("关键", &item("t", "a\nb关键词c\nd")).unwrap();
        // 换行逐字符替换为空格,文本原样 9 字符内不截断
        assert_eq!(with_nl.body_snippet.as_deref(), Some("a b关键词c d"));
    }

    #[test]
    fn no_match_returns_none() {
        assert!(match_prompt("不存在的词xyz", &item("标题", "正文")).is_none());
        assert!(match_prompt("", &item("标题", "正文")).is_none());
        assert!(match_prompt("   ", &item("标题", "正文")).is_none());
    }

    /* ---- U3 占位符提取 ---- */

    #[test]
    fn extract_basic_chinese_dedupe_trim() {
        assert_eq!(extract_placeholders("你好 {{name}}!"), ["name"]);
        assert_eq!(
            extract_placeholders("{{变量A}}和{{变量B}}"),
            ["变量A", "变量B"]
        );
        assert_eq!(extract_placeholders("{{a}} {{a}}"), ["a"]);
        assert_eq!(extract_placeholders("{{ 空格名 }}"), ["空格名"]);
    }

    #[test]
    fn extract_boundaries() {
        assert!(extract_placeholders("{{}}").is_empty());
        assert!(extract_placeholders("{{{a}}}").is_empty());
        assert!(extract_placeholders("{{a}}}").is_empty());
        assert!(extract_placeholders("{{a}").is_empty());
        assert!(extract_placeholders("{a} 不是占位符").is_empty());
        assert!(extract_placeholders("没有占位符").is_empty());
        // 多个连续占位符 + 相邻花括号混合
        assert_eq!(
            extract_placeholders("x{{a}}{{b}}y{{{c}}}{{ d }}"),
            ["a", "b", "d"]
        );
    }

    /* ---- U4 占位符填充 ---- */

    #[test]
    fn fill_replace_keep_and_repeat() {
        let v = HashMap::new();
        assert_eq!(
            fill_placeholders("你好 {{name}}!", &HashMap::from([("name".to_string(), "世界".to_string())])),
            "你好 世界!"
        );
        assert_eq!(
            fill_placeholders("你好 {{name}}!", &HashMap::from([("name".to_string(), String::new())])),
            "你好 {{name}}!"
        );
        assert_eq!(fill_placeholders("你好 {{name}}!", &v), "你好 {{name}}!");
        assert_eq!(
            fill_placeholders("{{z}}-{{z}}", &HashMap::from([("z".to_string(), "9".to_string())])),
            "9-9"
        );
        // 替换值里的正则替换语义符号必须按字面处理(Rust 无 $& 展开问题)
        assert_eq!(
            fill_placeholders("A{{v}}B", &HashMap::from([("v".to_string(), "$&$'`".to_string())])),
            "A$&$'`B"
        );
        assert_eq!(
            fill_placeholders(
                "{{a}} {{b}}",
                &HashMap::from([("a".to_string(), "1".to_string()), ("b".to_string(), "2".to_string())])
            ),
            "1 2"
        );
        // 未填变量保持原样,包括带空格的原始写法
        assert_eq!(
            fill_placeholders("{{ 空格名 }} 保持", &v),
            "{{ 空格名 }} 保持"
        );
    }

    #[test]
    fn fill_skips_triple_braces() {
        assert_eq!(
            fill_placeholders("{{{a}}}", &HashMap::from([("a".to_string(), "x".to_string())])),
            "{{{a}}}"
        );
    }
}
