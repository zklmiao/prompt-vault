//! MCP 数据访问:数据文件的防御式解析与四个工具的纯逻辑。
//! 每次工具调用都重新从磁盘读(主窗口任何改动都即时原子落盘,读到的永远最新)。

use std::collections::HashMap;
use std::path::Path;

use serde_json::{json, Value};

use crate::data_lock;
use crate::fuzzy::{match_prompt, MatchFields};
use crate::now_iso_utc;
use crate::write_atomic;

/// 数据文件单条记录(前端 PromptItem 的读取子集,只含 MCP 用到的字段)
pub(crate) struct PromptRecord {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) tags: Vec<String>,
    pub(crate) source: String,
    pub(crate) note: String,
    /// 存在即处于回收站
    pub(crate) deleted_at: Option<String>,
}

impl MatchFields for PromptRecord {
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

/// 宽松解析(对齐 src/util.ts coerceItems 的读取语义):
/// 接受 `{prompts:[…]}` 或裸数组;字段类型不符逐个回退,非对象条目跳过,绝不 panic。
/// tags 过滤非字符串与空白项(保留原字符串,与前端一致不做 trim)。
pub(crate) fn parse_records(root: &Value) -> Vec<PromptRecord> {
    let arr = match root.get("prompts").and_then(Value::as_array) {
        Some(a) => a,
        None => match root.as_array() {
            Some(a) => a,
            None => return vec![],
        },
    };
    let mut out = Vec::new();
    for raw in arr {
        let Some(obj) = raw.as_object() else {
            continue;
        };
        let s = |k: &str| obj.get(k).and_then(Value::as_str).unwrap_or("");
        let id = {
            let v = s("id");
            if v.is_empty() {
                uuid::Uuid::new_v4().to_string()
            } else {
                v.to_string()
            }
        };
        let tags: Vec<String> = obj
            .get("tags")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|t| t.as_str())
                    .filter(|t| !t.trim().is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        out.push(PromptRecord {
            id,
            title: s("title").to_string(),
            body: s("body").to_string(),
            tags,
            source: s("source").to_string(),
            note: s("note").to_string(),
            deleted_at: obj.get("deletedAt").and_then(Value::as_str).map(str::to_string),
        });
    }
    out
}

/// 从磁盘读入并解析;文件缺失 / 非法 JSON / IO 错误一律按空库处理(读路径防御式)
pub(crate) fn load_records(path: &Path) -> Vec<PromptRecord> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return vec![];
    };
    let Ok(root) = serde_json::from_str::<Value>(&raw) else {
        return vec![];
    };
    parse_records(&root)
}

pub(crate) fn live(records: &[PromptRecord]) -> impl Iterator<Item = &PromptRecord> {
    records.iter().filter(|r| r.deleted_at.is_none())
}

/// 模糊检索:match_prompt 评分排序(同分保持文件顺序,稳定排序),截取 limit
pub(crate) fn search_rows(records: &[PromptRecord], query: &str, limit: usize) -> Vec<Value> {
    let mut hits: Vec<(&PromptRecord, f64, Option<String>)> = Vec::new();
    for r in live(records) {
        if let Some(m) = match_prompt(query, r) {
            hits.push((r, m.score, m.body_snippet));
        }
    }
    hits.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    hits.truncate(limit);
    hits.into_iter()
        .map(|(r, _, snippet)| {
            json!({
                "id": r.id,
                "title": r.title,
                "tags": r.tags,
                "snippet": snippet.unwrap_or_default(),
            })
        })
        .collect()
}

/// 标签计数(仅未删除条目):计数降序,同数按名称升序,保证输出稳定
pub(crate) fn tag_counts(records: &[PromptRecord]) -> Vec<(String, usize)> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for r in live(records) {
        for t in &r.tags {
            *counts.entry(t.clone()).or_default() += 1;
        }
    }
    let mut out: Vec<(String, usize)> = counts.into_iter().collect();
    out.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out
}

/// save_prompt 只增不删不改:持跨进程锁 读 → 追加 → 复用 write_atomic 原子落盘。
/// 文件不存在则新建;已存在的文件损坏时拒绝写入(绝不覆盖真实数据)。
/// 返回新条目 id。
pub(crate) fn save_prompt(
    path: &Path,
    title: &str,
    body: &str,
    tags: &[String],
    source: &str,
) -> Result<String, String> {
    data_lock::with_data_lock(path, || {
        let new_id = uuid::Uuid::new_v4().to_string();
        let now = now_iso_utc();
        let item = json!({
            "id": new_id,
            "title": title,
            "body": body,
            "tags": tags,
            "source": source,
            "note": "",
            "pinned": false,
            "createdAt": now,
            "updatedAt": now,
        });
        let root: Value = if path.exists() {
            let raw = std::fs::read_to_string(path)
                .map_err(|e| format!("读取数据文件失败:{e}"))?;
            let mut root: Value = serde_json::from_str(&raw)
                .map_err(|e| format!("数据文件不是有效 JSON,拒绝追加:{e}"))?;
            let arr = root
                .get_mut("prompts")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| "数据格式不正确:缺少 prompts 数组".to_string())?;
            arr.push(item);
            root
        } else {
            json!({ "version": 1, "prompts": [item] })
        };
        let text = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
        write_atomic(path, &text)?;
        Ok(new_id)
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pv-mcp-data-{}-{}", std::process::id(), tag));
        let _ = std::fs::create_dir_all(&dir);
        dir.join("prompts.json")
    }

    fn v(json: &str) -> Value {
        serde_json::from_str(json).unwrap()
    }

    /* ---- 防御式解析(coerceItems 读取语义对齐) ---- */

    #[test]
    fn parse_wrapped_and_bare_array() {
        let wrapped = parse_records(&v(r#"{"version":1,"prompts":[{"id":"a","title":"x","body":"y"}]}"#));
        let bare = parse_records(&v(r#"[{"id":"a","title":"x","body":"y"}]"#));
        assert_eq!(wrapped.len(), 1);
        assert_eq!(bare.len(), 1);
        assert_eq!(wrapped[0].id, "a");
        assert_eq!(bare[0].body, "y");
    }

    #[test]
    fn parse_skips_garbage_and_coerces_fields() {
        let records = parse_records(&v(
            r#"{"prompts":[
                null, 42, "x", {},
                {"id":"ok","body":""},
                {"id":"b","title":123,"body":null,"tags":["ok",5,""," x "],"source":0,"note":false,"deletedAt":9}
            ]}"#,
        ));
        // {} 条目 id 为空 → 生成 uuid(排在最前);其余坏字段回退
        assert_eq!(records.len(), 3);
        assert!(uuid::Uuid::parse_str(&records[0].id).is_ok(), "{{}} 条目应生成 uuid");
        assert_eq!(records[1].id, "ok");
        let bad = &records[2];
        assert_eq!(bad.id, "b");
        assert_eq!(bad.title, "");
        assert_eq!(bad.body, "");
        // 过滤空白项;通过校验的保留原样不 trim(与 coerceItems 一致)
        assert_eq!(bad.tags, vec!["ok".to_string(), " x ".to_string()]);
        assert_eq!(bad.source, "");
        assert_eq!(bad.note, "");
        assert_eq!(bad.deleted_at, None);
    }

    #[test]
    fn parse_deleted_at_and_non_object_root() {
        let r = parse_records(&v(r#"[{"id":"a","deletedAt":"2026-01-01T00:00:00.000Z"}]"#));
        assert_eq!(r[0].deleted_at.as_deref(), Some("2026-01-01T00:00:00.000Z"));
        assert!(parse_records(&v(r#"{"prompts":"nope"}"#)).is_empty());
        assert!(parse_records(&v("42")).is_empty());
    }

    /* ---- 检索 / 标签 ---- */

    fn sample_records() -> Vec<PromptRecord> {
        parse_records(&v(
            r#"[
                {"id":"p1","title":"SQL 优化","body":"SELECT * FROM t","tags":["数据库"],"source":"笔记"},
                {"id":"p2","title":"翻译助手","body":"把以下内容翻译成英文:{{内容}}","tags":["翻译"],"source":"网页"},
                {"id":"p4","title":"代码审查清单","body":"检查 sql 注入风险","tags":["编码","数据库"]},
                {"id":"p3","title":"旧 SQL 笔记","body":"已废弃","tags":[],"deletedAt":"2026-01-01T00:00:00.000Z"}
            ]"#,
        ))
    }

    #[test]
    fn search_orders_by_score_and_excludes_recycle_bin() {
        let rows = search_rows(&sample_records(), "sql", 50);
        // 标题命中(p1)权重 3×,正文命中(p4)排后;回收站 p3 不出现
        let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["p1", "p4"]);
        // 标题命中条目无正文片段;正文命中条目有片段
        assert_eq!(rows[0]["snippet"], "");
        assert_eq!(rows[1]["snippet"], "检查 sql 注入风险");
    }

    #[test]
    fn search_limit_cap_and_empty() {
        let rows = search_rows(&sample_records(), "sql", 1);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "p1");
        assert!(search_rows(&sample_records(), "不存在的词xyz", 10).is_empty());
    }

    #[test]
    fn tag_counts_sorted_by_count_then_name() {
        let counts = tag_counts(&sample_records());
        assert_eq!(
            counts,
            vec![
                ("数据库".to_string(), 2),
                ("编码".to_string(), 1),
                ("翻译".to_string(), 1),
            ]
        );
    }

    /* ---- save_prompt 只增语义 ---- */

    #[test]
    fn save_appends_and_never_touches_existing_items() {
        let path = temp_path("append");
        std::fs::write(&path, r#"{"version":1,"prompts":[{"id":"p1","title":"已有","body":"B","tags":["t"],"source":"S","note":"N","pinned":true,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","copyCount":3}]}"#).unwrap();

        // 注:tags 归一化(trim/去空白)是 RPC 层 tags_arg 的职责
        // (由 mcp::tests::tools_call_save_prompt_appends_only 覆盖);
        // 本层契约 = 原样存储,故传已归一化的值验证落盘。
        let id1 = save_prompt(&path, "新条目", "内容 {{x}}", &["a".to_string(), "b".to_string()], "MCP")
            .expect("保存应成功");
        // 新 id 为 uuid 格式,与原条目不同
        assert!(uuid::Uuid::parse_str(&id1).is_ok());

        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let arr = root["prompts"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        // 原条目逐字段保持不变(只增不改)
        assert_eq!(arr[0]["id"], "p1");
        assert_eq!(arr[0]["title"], "已有");
        assert_eq!(arr[0]["pinned"], true);
        assert_eq!(arr[0]["copyCount"], 3);
        // 新条目:归一化 tags(去空白项、trim),时间戳为 ISO UTC
        assert_eq!(arr[1]["id"], id1.as_str());
        assert_eq!(arr[1]["title"], "新条目");
        assert_eq!(arr[1]["body"], "内容 {{x}}");
        assert_eq!(arr[1]["tags"], serde_json::json!(["a", "b"]));
        assert_eq!(arr[1]["source"], "MCP");
        assert_eq!(arr[1]["note"], "");
        assert_eq!(arr[1]["pinned"], false);
        let created = arr[1]["createdAt"].as_str().unwrap();
        assert!(created.ends_with(".000Z") && created.len() == 24, "{created}");

        // 再次保存:继续追加,先前的条目原样
        let id2 = save_prompt(&path, "第二条", "", &[], "MCP").unwrap();
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let arr = root["prompts"].as_array().unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[1]["id"], id1.as_str(), "只增:上一条新条目不得被修改");
        assert_eq!(arr[2]["id"], id2.as_str());
    }

    #[test]
    fn save_creates_missing_file_and_rejects_corrupt_file() {
        let fresh = temp_path("fresh");
        let _ = std::fs::remove_file(&fresh);
        let id = save_prompt(&fresh, "首条", "B", &[], "MCP").unwrap();
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&fresh).unwrap()).unwrap();
        assert_eq!(root["version"], 1);
        assert_eq!(root["prompts"].as_array().unwrap().len(), 1);
        assert_eq!(root["prompts"][0]["id"], id.as_str());

        let corrupt = temp_path("corrupt");
        std::fs::write(&corrupt, "not json").unwrap();
        let before = std::fs::read_to_string(&corrupt).unwrap();
        assert!(save_prompt(&corrupt, "T", "B", &[], "MCP").is_err());
        // 损坏文件必须原样保留,绝不允许覆盖
        assert_eq!(std::fs::read_to_string(&corrupt).unwrap(), before);

        let bad_root = temp_path("badroot");
        std::fs::write(&bad_root, r#"{"prompts":"nope"}"#).unwrap();
        let before = std::fs::read_to_string(&bad_root).unwrap();
        assert!(save_prompt(&bad_root, "T", "B", &[], "MCP").is_err());
        assert_eq!(std::fs::read_to_string(&bad_root).unwrap(), before);
    }
}
