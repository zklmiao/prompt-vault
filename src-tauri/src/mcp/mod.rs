//! MCP Server(`--mcp` headless):stdio 上的 JSON-RPC 2.0 服务端。
//!
//! 进程模型见 docs/plugin-system-design.md §6:
//! - 启动前读 `%APPDATA%\prompt-vault\plugins.json`,仅 `mcp.enabled == true` 才运行,
//!   否则 stderr 提示并以退出码 1 结束;
//! - 每条消息(即每次工具/模板调用)重新从 config.json 解析 data_path,
//!   再从磁盘重读数据文件,主窗口的任何改动都即时生效;
//! - 协议传输为按行分隔的 JSON(无 Content-Length 头),日志一律走 stderr。

mod data;

use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;

use serde_json::{json, Map, Value};

use crate::config_file_path;
use crate::fuzzy::{extract_placeholders, fill_placeholders};

const SERVER_NAME: &str = "prompt-vault";
const DEFAULT_PROTOCOL_VERSION: &str = "2024-11-05";
const SEARCH_LIMIT_DEFAULT: usize = 10;
const SEARCH_LIMIT_CAP: usize = 50;

/* ---------- 启用门控 ---------- */

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct McpSection {
    enabled: bool,
}

#[derive(serde::Deserialize, Default)]
#[serde(default)]
struct PluginsState {
    mcp: McpSection,
}

/// 门控纯判定:文件缺失 / 坏 JSON / 缺字段一律视为未启用,绝不 panic
fn is_mcp_enabled(raw: Option<&str>) -> bool {
    raw.and_then(|r| serde_json::from_str::<PluginsState>(r).ok())
        .map(|s| s.mcp.enabled)
        .unwrap_or(false)
}

fn plugins_file_path() -> PathBuf {
    // plugins.json 与 config.json 同目录(D6)
    config_file_path().with_file_name("plugins.json")
}

fn mcp_enabled_on_disk() -> bool {
    is_mcp_enabled(std::fs::read_to_string(plugins_file_path()).ok().as_deref())
}

/* ---------- 每消息上下文 ---------- */

pub(crate) struct McpCtx {
    /// config.json 的 data_path(每条消息重新解析)
    pub(crate) data_path: Option<PathBuf>,
}

impl McpCtx {
    #[cfg(test)]
    fn none() -> McpCtx {
        McpCtx { data_path: None }
    }

    fn from_config() -> McpCtx {
        McpCtx {
            data_path: crate::read_config().data_path.map(PathBuf::from),
        }
    }

    /// 读路径:未配置数据文件视为空库;配置了则重读磁盘
    fn records(&self) -> Vec<data::PromptRecord> {
        match &self.data_path {
            Some(p) => data::load_records(p),
            None => vec![],
        }
    }
}

/* ---------- JSON-RPC 信封 ---------- */

struct RpcError {
    code: i64,
    message: String,
}

fn invalid_params(msg: impl Into<String>) -> RpcError {
    RpcError {
        code: -32602,
        message: msg.into(),
    }
}

fn ok_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn err_response(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// 工具执行期失败(MCP 语义):以 isError 结果回包,而不是协议错误
struct ToolError(String);

fn str_arg<'a>(args: &'a Map<String, Value>, key: &str) -> Result<&'a str, RpcError> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params(format!("缺少字符串参数 {key}")))
}

fn opt_str_arg<'a>(args: &'a Map<String, Value>, key: &str) -> Result<Option<&'a str>, RpcError> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.as_str())),
        Some(_) => Err(invalid_params(format!("参数 {key} 应为字符串"))),
    }
}

/* ---------- 消息处理 ---------- */

/// 处理一行输入,返回要写回 stdout 的响应;空行 / 通知 / 可忽略消息返回 None
pub(crate) fn handle_line(line: &str, ctx: &McpCtx) -> Option<Value> {
    if line.trim().is_empty() {
        return None; // 空行无消息(与主循环的跳过逻辑一致)
    }
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return Some(err_response(Value::Null, -32700, "JSON 解析失败")),
    };
    let Some(obj) = msg.as_object() else {
        return Some(err_response(Value::Null, -32600, "无效请求:应为 JSON 对象"));
    };
    let Some(method) = obj.get("method").and_then(Value::as_str) else {
        // 客户端发来的响应或畸形消息,忽略
        return None;
    };
    let id = obj.get("id").cloned().unwrap_or(Value::Null);
    let has_id = obj.contains_key("id");
    let params = obj.get("params").cloned().unwrap_or(Value::Null);

    let result = match method {
        "initialize" => Ok(initialize_result(&params)),
        "notifications/initialized" => return None,
        "tools/list" => Ok(tools_list_result()),
        "tools/call" => tools_call(&params, ctx),
        "prompts/list" => Ok(prompts_list(ctx)),
        "prompts/get" => prompts_get(&params, ctx),
        "shutdown" | "exit" => Ok(Value::Null),
        _ => {
            if !has_id {
                return None; // 未知通知静默
            }
            Err(RpcError {
                code: -32601,
                message: format!("未知方法:{method}"),
            })
        }
    };

    if !has_id {
        return None; // 通知永不回包
    }
    Some(match result {
        Ok(v) => ok_response(id, v),
        Err(e) => err_response(id, e.code, &e.message),
    })
}

fn is_exit_message(line: &str) -> bool {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|v| v.get("method").and_then(Value::as_str).map(str::to_string))
        .is_some_and(|m| m == "shutdown" || m == "exit")
}

/* ---------- initialize ---------- */

fn initialize_result(params: &Value) -> Value {
    // 客户端可协商协议版本;未携带时用首个稳定版
    let protocol_version = params
        .get("protocolVersion")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_PROTOCOL_VERSION);
    json!({
        "protocolVersion": protocol_version,
        "capabilities": { "tools": {}, "prompts": {} },
        "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
    })
}

/* ---------- tools ---------- */

fn tool_defs() -> Vec<Value> {
    vec![
        json!({
            "name": "search_prompts",
            "description": "按关键词模糊检索收藏的 Prompt(不含回收站),按相关度排序,返回 id/title/tags/正文片段",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "搜索关键词" },
                    "limit": { "type": "integer", "description": "返回条数上限,默认 10,最大 50" }
                },
                "required": ["query"]
            }
        }),
        json!({
            "name": "get_prompt",
            "description": "按 id 获取完整 Prompt;正文中的 {{变量}} 原样返回,由 agent 与用户确认后填充",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "条目 id(search_prompts 或 prompts/list 返回)" }
                },
                "required": ["id"]
            }
        }),
        json!({
            "name": "list_tags",
            "description": "列出全部标签及条目计数(不含回收站)",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "save_prompt",
            "description": "新增一条收藏(只增不删不改);source 默认为 MCP",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "标题" },
                    "body": { "type": "string", "description": "正文,支持 {{变量}} 占位符" },
                    "tags": { "type": "array", "items": { "type": "string" }, "description": "可选标签" },
                    "source": { "type": "string", "description": "可选来源标记,默认 MCP" }
                },
                "required": ["title", "body"]
            }
        }),
    ]
}

fn tools_list_result() -> Value {
    json!({ "tools": tool_defs() })
}

fn tools_call(params: &Value, ctx: &McpCtx) -> Result<Value, RpcError> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("缺少工具名 name"))?;
    let args = params
        .get("arguments")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    // 参数校验(架构层错误)在此统一走协议错误;执行期失败才用 isError 结果
    let payload = match name {
        "search_prompts" => {
            let query = str_arg(&args, "query")?;
            let limit = limit_arg(&args)?;
            tool_search(ctx, query, limit)
        }
        "get_prompt" => {
            let id = str_arg(&args, "id")?;
            tool_get(ctx, id)
        }
        "list_tags" => Ok(tool_tags(ctx)),
        "save_prompt" => {
            let title = str_arg(&args, "title")?;
            let body = str_arg(&args, "body")?;
            let tags = tags_arg(&args)?;
            let source = opt_str_arg(&args, "source")?.unwrap_or("MCP");
            tool_save(ctx, title, body, &tags, source)
        }
        _ => return Err(invalid_params(format!("未知工具:{name}"))),
    };

    match payload {
        Ok(payload) => {
            let text = serde_json::to_string(&payload)
                .map_err(|e| RpcError { code: -32603, message: format!("结果序列化失败:{e}") })?;
            Ok(json!({
                "content": [{ "type": "text", "text": text }],
                "isError": false,
            }))
        }
        // 执行期失败(找不到条目 / 数据文件异常):isError 结果,客户端可读
        Err(ToolError(message)) => Ok(json!({
            "content": [{ "type": "text", "text": message }],
            "isError": true,
        })),
    }
}

/// limit 缺省 10,上限 50;null 视为缺省
fn limit_arg(args: &Map<String, Value>) -> Result<usize, RpcError> {
    match args.get("limit") {
        None | Some(Value::Null) => Ok(SEARCH_LIMIT_DEFAULT),
        Some(v) => {
            let n = v.as_u64().ok_or_else(|| invalid_params("limit 应为非负整数"))?;
            Ok((n as usize).min(SEARCH_LIMIT_CAP))
        }
    }
}

/// tags 归一化:trim、去空白项(与前端保存行为一致)
fn tags_arg(args: &Map<String, Value>) -> Result<Vec<String>, RpcError> {
    match args.get("tags") {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(a)) => Ok(a
            .iter()
            .filter_map(|t| t.as_str())
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect()),
        Some(_) => Err(invalid_params("tags 应为字符串数组")),
    }
}

fn tool_search(ctx: &McpCtx, query: &str, limit: usize) -> Result<Value, ToolError> {
    let records = ctx.records();
    Ok(json!({ "results": data::search_rows(&records, query, limit) }))
}

fn tool_get(ctx: &McpCtx, id: &str) -> Result<Value, ToolError> {
    let records = ctx.records();
    let r = records
        .iter()
        .find(|r| r.deleted_at.is_none() && r.id == id)
        .ok_or_else(|| ToolError(format!("未找到该收藏(或已在回收站):{id}")))?;
    Ok(json!({
        "id": r.id,
        "title": r.title,
        "body": r.body,
        "tags": r.tags,
        "source": r.source,
        "note": r.note,
    }))
}

fn tool_tags(ctx: &McpCtx) -> Value {
    let records = ctx.records();
    let tags: Vec<Value> = data::tag_counts(&records)
        .into_iter()
        .map(|(name, count)| json!({ "name": name, "count": count }))
        .collect();
    json!({ "tags": tags })
}

fn tool_save(
    ctx: &McpCtx,
    title: &str,
    body: &str,
    tags: &[String],
    source: &str,
) -> Result<Value, ToolError> {
    let Some(path) = ctx.data_path.clone() else {
        return Err(ToolError(
            "未配置数据文件路径,无法保存;请先在 Prompt Vault 中设置".to_string(),
        ));
    };
    let new_id = data::save_prompt(&path, title, body, tags, source).map_err(ToolError)?;
    Ok(json!({ "id": new_id, "title": title }))
}

/* ---------- 原生 prompts ---------- */

fn prompts_list(ctx: &McpCtx) -> Value {
    let records = ctx.records();
    let mut prompts = Vec::new();
    for r in data::live(&records) {
        let mut p = json!({ "name": r.id, "description": r.title });
        let vars = extract_placeholders(&r.body);
        if !vars.is_empty() {
            let arguments: Vec<Value> = vars
                .iter()
                .map(|v| json!({ "name": v, "description": format!("占位符变量 {v}"), "required": false }))
                .collect();
            p["arguments"] = json!(arguments);
        }
        prompts.push(p);
    }
    json!({ "prompts": prompts })
}

fn prompts_get(params: &Value, ctx: &McpCtx) -> Result<Value, RpcError> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_params("缺少模板名 name"))?;
    let records = ctx.records();
    let r = records
        .iter()
        .find(|r| r.deleted_at.is_none() && r.id == name)
        .ok_or_else(|| invalid_params(format!("未找到模板:{name}")))?;

    let mut values: HashMap<String, String> = HashMap::new();
    if let Some(map) = params.get("arguments").and_then(Value::as_object) {
        for (k, v) in map {
            if let Some(s) = v.as_str() {
                values.insert(k.trim().to_string(), s.to_string());
            }
        }
    }
    let filled = fill_placeholders(&r.body, &values);
    Ok(json!({
        "description": r.title,
        "messages": [
            { "role": "user", "content": { "type": "text", "text": filled } }
        ]
    }))
}

/* ---------- 主循环 ---------- */

pub(crate) fn run() {
    if !mcp_enabled_on_disk() {
        eprintln!("MCP 已在 Prompt Vault 设置中禁用");
        std::process::exit(1);
    }
    eprintln!("prompt-vault MCP server 已就绪(stdio,JSON-RPC 2.0)");

    let stdin = std::io::stdin();
    let mut reader = stdin.lock();
    let stdout = std::io::stdout();
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break, // EOF:客户端关闭,正常退出
            Ok(_) => {}
            Err(e) => {
                eprintln!("读取 stdin 失败:{e}");
                break;
            }
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // 每条消息重新解析配置与数据路径,保证读到最新状态
        let ctx = McpCtx::from_config();
        if let Some(resp) = handle_line(trimmed, &ctx) {
            let mut out = stdout.lock();
            if writeln!(out, "{resp}").is_err() || out.flush().is_err() {
                // 客户端断开(管道关闭),静默收尾
                break;
            }
        }
        if is_exit_message(trimmed) {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::data::parse_records;
    use std::path::Path;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pv-mcp-test-{}-{}", std::process::id(), tag));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn write_data(path: &Path, contents: &str) -> PathBuf {
        std::fs::write(path, contents).unwrap();
        path.to_path_buf()
    }

    fn call(method: &str, params: Value, ctx: &McpCtx) -> Value {
        let line = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"{method}","params":{}}}"#,
            params
        );
        handle_line(&line, ctx).unwrap()
    }

    /* ---- 门控 ---- */

    #[test]
    fn gate_disabled_missing_and_corrupt_plugins_json() {
        assert!(!is_mcp_enabled(None), "缺文件应视为未启用");
        assert!(!is_mcp_enabled(Some("not json")), "坏 JSON 不应 panic 且未启用");
        assert!(!is_mcp_enabled(Some("{}")), "缺 mcp 字段未启用");
        assert!(!is_mcp_enabled(Some(r#"{"mcp":{}}"#)), "缺 enabled 未启用");
        assert!(!is_mcp_enabled(Some(r#"{"mcp":{"enabled":false}}"#)));
        assert!(is_mcp_enabled(Some(r#"{"mcp":{"enabled":true}}"#)));
        // 其他无关字段不影响判定
        assert!(is_mcp_enabled(Some(
            r#"{"sources":[],"mcp":{"enabled":true,"extra":1}}"#
        )));
        // 文件级链路:读失败(缺文件)按未启用
        let missing = temp_dir("gate").join("plugins.json");
        let _ = std::fs::remove_file(&missing);
        assert!(!is_mcp_enabled(std::fs::read_to_string(&missing).ok().as_deref()));
    }

    /* ---- JSON-RPC 解析与响应形状 ---- */

    #[test]
    fn initialize_response_shape() {
        let ctx = McpCtx::none();
        let resp = call("initialize", json!({"protocolVersion": "2025-06-18"}), &ctx);
        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 1);
        assert_eq!(resp["result"]["protocolVersion"], "2025-06-18", "应回显客户端版本");
        assert!(resp["result"]["capabilities"].get("tools").is_some());
        assert!(resp["result"]["capabilities"].get("prompts").is_some());
        assert_eq!(resp["result"]["serverInfo"]["name"], "prompt-vault");
        assert_eq!(resp["result"]["serverInfo"]["version"], env!("CARGO_PKG_VERSION"));

        // 未携带 protocolVersion 时用默认
        let resp = handle_line(
            r#"{"jsonrpc":"2.0","id":2,"method":"initialize"}"#,
            &ctx,
        )
        .unwrap();
        assert_eq!(resp["result"]["protocolVersion"], DEFAULT_PROTOCOL_VERSION);
    }

    #[test]
    fn tools_list_shape() {
        let ctx = McpCtx::none();
        let resp = call("tools/list", json!({}), &ctx);
        let tools = resp["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["search_prompts", "get_prompt", "list_tags", "save_prompt"]);
        let search = tools.iter().find(|t| t["name"] == "search_prompts").unwrap();
        assert_eq!(search["inputSchema"]["required"], json!(["query"]));
        let save = tools.iter().find(|t| t["name"] == "save_prompt").unwrap();
        assert_eq!(save["inputSchema"]["required"], json!(["title", "body"]));
    }

    #[test]
    fn notifications_never_respond() {
        let ctx = McpCtx::none();
        assert!(handle_line(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            &ctx
        )
        .is_none());
        assert!(handle_line(
            r#"{"jsonrpc":"2.0","method":"some/unknown-notification"}"#,
            &ctx
        )
        .is_none());
    }

    #[test]
    fn unknown_method_and_parse_errors() {
        let ctx = McpCtx::none();
        let resp = handle_line(
            r#"{"jsonrpc":"2.0","id":7,"method":"nope/method"}"#,
            &ctx,
        )
        .unwrap();
        assert_eq!(resp["id"], 7);
        assert_eq!(resp["error"]["code"], -32601);

        let resp = handle_line("{bad json", &ctx).unwrap();
        assert_eq!(resp["error"]["code"], -32700);
        assert_eq!(resp["id"], Value::Null);

        let resp = handle_line("42", &ctx).unwrap();
        assert_eq!(resp["error"]["code"], -32600);

        // 空 / 空白行不回包
        assert!(handle_line("   ", &ctx).is_none());
    }

    /* ---- tools/call:检索 / 详情 / 标签 ---- */

    fn sample_ctx(tag: &str) -> McpCtx {
        let dir = temp_dir(tag);
        let path = write_data(
            &dir.join("prompts.json"),
            r#"{"version":1,"prompts":[
                {"id":"p1","title":"SQL 优化","body":"SELECT * FROM t","tags":["数据库"],"source":"笔记","note":"周查询"},
                {"id":"p2","title":"翻译助手","body":"把以下内容翻译成英文:{{内容}}","tags":["翻译"],"source":"网页"},
                {"id":"p4","title":"代码审查清单","body":"检查 sql 注入风险","tags":["编码","数据库"]},
                {"id":"p3","title":"旧 SQL 笔记","body":"已废弃","tags":[],"deletedAt":"2026-01-01T00:00:00.000Z"}
            ]}"#,
        );
        McpCtx {
            data_path: Some(path),
        }
    }

    #[test]
    fn tools_call_search_shape_and_order() {
        let ctx = sample_ctx("search");
        let resp = call(
            "tools/call",
            json!({"name":"search_prompts","arguments":{"query":"sql","limit":1}}),
            &ctx,
        );
        assert_eq!(resp["result"]["isError"], false);
        let text = resp["result"]["content"][0]["text"].as_str().unwrap();
        let payload: Value = serde_json::from_str(text).unwrap();
        let results = payload["results"].as_array().unwrap();
        assert_eq!(results.len(), 1, "limit=1");
        assert_eq!(results[0]["id"], "p1");
        assert_eq!(results[0]["title"], "SQL 优化");
        assert_eq!(results[0]["tags"], json!(["数据库"]));
        assert_eq!(results[0]["snippet"], "");
    }

    #[test]
    fn tools_call_get_prompt_fields_and_errors() {
        let ctx = sample_ctx("get");
        let resp = call(
            "tools/call",
            json!({"name":"get_prompt","arguments":{"id":"p2"}}),
            &ctx,
        );
        let payload: Value =
            serde_json::from_str(resp["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(payload["title"], "翻译助手");
        assert_eq!(payload["body"], "把以下内容翻译成英文:{{内容}}", "占位符原样返回");
        assert_eq!(payload["tags"], json!(["翻译"]));
        assert_eq!(payload["source"], "网页");
        assert_eq!(payload["note"], "");
        assert_eq!(payload["id"], "p2");

        // 不存在 / 回收站条目 → isError 结果
        for id in ["nope", "p3"] {
            let resp = call(
                "tools/call",
                json!({"name":"get_prompt","arguments":{"id":id}}),
                &ctx,
            );
            assert_eq!(resp["result"]["isError"], true, "id={id}");
            assert!(resp["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("未找到"));
        }
        // 缺参数 → 协议错误
        let resp = call("tools/call", json!({"name":"get_prompt","arguments":{}}), &ctx);
        assert_eq!(resp["error"]["code"], -32602);
    }

    #[test]
    fn tools_call_list_tags_counts_live_only() {
        let ctx = sample_ctx("tags");
        let resp = call("tools/call", json!({"name":"list_tags","arguments":{}}), &ctx);
        let payload: Value =
            serde_json::from_str(resp["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(
            payload["tags"],
            json!([
                {"name": "数据库", "count": 2},
                {"name": "编码", "count": 1},
                {"name": "翻译", "count": 1}
            ])
        );
    }

    /* ---- tools/call:save_prompt(经完整 JSON-RPC 入口) ---- */

    #[test]
    fn tools_call_save_prompt_appends_only() {
        let dir = temp_dir("save");
        let path = write_data(
            &dir.join("prompts.json"),
            r#"{"version":1,"prompts":[{"id":"p1","title":"已有","body":"B","tags":[],"source":"S","note":"","pinned":true,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}]}"#,
        );
        let ctx = McpCtx { data_path: Some(path.clone()) };

        let resp = call(
            "tools/call",
            json!({"name":"save_prompt","arguments":{"title":"来自 agent","body":"内容 {{var}}","tags":["t1","  t2  "]}}),
            &ctx,
        );
        assert_eq!(resp["result"]["isError"], false);
        let payload: Value =
            serde_json::from_str(resp["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        let new_id = payload["id"].as_str().unwrap().to_string();
        assert!(uuid::Uuid::parse_str(&new_id).is_ok());

        // 缺省 source=MCP;tags 归一化;原条目未动
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let arr = root["prompts"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["id"], "p1");
        assert_eq!(arr[0]["pinned"], true);
        assert_eq!(arr[1]["id"], new_id.as_str());
        assert_eq!(arr[1]["source"], "MCP");
        assert_eq!(arr[1]["tags"], json!(["t1", "t2"]));
        assert_eq!(arr[1]["body"], "内容 {{var}}");

        // 只增:第二条保存后第一条新增仍原样
        call(
            "tools/call",
            json!({"name":"save_prompt","arguments":{"title":"第二条","body":"","source":"网页"}}),
            &ctx,
        );
        let root: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let arr = root["prompts"].as_array().unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[1]["id"], new_id.as_str());
        assert_eq!(arr[2]["source"], "网页");

        // 坏参数 → 协议错误而非静默
        let resp = call(
            "tools/call",
            json!({"name":"save_prompt","arguments":{"title":"x","body":"y","tags":"bad"}}),
            &ctx,
        );
        assert_eq!(resp["error"]["code"], -32602);
    }

    #[test]
    fn tools_call_save_prompt_rejects_corrupt_and_missing_data_path() {
        let dir = temp_dir("save-bad");
        let path = write_data(&dir.join("prompts.json"), "not json");
        let ctx = McpCtx { data_path: Some(path.clone()) };
        let resp = call(
            "tools/call",
            json!({"name":"save_prompt","arguments":{"title":"t","body":"b"}}),
            &ctx,
        );
        assert_eq!(resp["result"]["isError"], true);
        // 文件保持原样
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");

        // 未配置数据文件路径
        let ctx = McpCtx::none();
        let resp = call(
            "tools/call",
            json!({"name":"save_prompt","arguments":{"title":"t","body":"b"}}),
            &ctx,
        );
        assert_eq!(resp["result"]["isError"], true);
        assert!(resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("未配置"));

        // 未配置路径时读取类工具按空库处理,不报错
        let resp = call(
            "tools/call",
            json!({"name":"search_prompts","arguments":{"query":"x"}}),
            &ctx,
        );
        assert_eq!(resp["result"]["isError"], false);
        let payload: Value =
            serde_json::from_str(resp["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(payload["results"], json!([]));
    }

    /* ---- 原生 prompts ---- */

    #[test]
    fn prompts_list_maps_placeholders_to_arguments() {
        let ctx = sample_ctx("plist");
        let resp = call("prompts/list", json!({}), &ctx);
        let prompts = resp["result"]["prompts"].as_array().unwrap();
        // 回收站条目不出现
        let names: Vec<&str> = prompts.iter().map(|p| p["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["p1", "p2", "p4"]);
        let p2 = prompts.iter().find(|p| p["name"] == "p2").unwrap();
        assert_eq!(p2["description"], "翻译助手", "描述放 title");
        assert_eq!(
            p2["arguments"],
            json!([{"name":"内容","description":"占位符变量 内容","required":false}])
        );
        // 无占位符的条目不带 arguments 字段
        let p1 = prompts.iter().find(|p| p["name"] == "p1").unwrap();
        assert!(p1.get("arguments").is_none());
    }

    #[test]
    fn prompts_get_fills_and_keeps_unfilled() {
        let ctx = sample_ctx("pget");
        let resp = call(
            "prompts/get",
            json!({"name":"p2","arguments":{"内容":"你好世界"}}),
            &ctx,
        );
        assert_eq!(resp["result"]["description"], "翻译助手");
        let msg = &resp["result"]["messages"][0];
        assert_eq!(msg["role"], "user");
        assert_eq!(msg["content"]["type"], "text");
        assert_eq!(msg["content"]["text"], "把以下内容翻译成英文:你好世界");

        // 未填参数保持 {{原名}} 原样
        let resp = call("prompts/get", json!({"name":"p2"}), &ctx);
        let msg = &resp["result"]["messages"][0];
        assert_eq!(msg["content"]["text"], "把以下内容翻译成英文:{{内容}}");

        // 未知模板 → 协议错误
        let resp = call("prompts/get", json!({"name":"nope"}), &ctx);
        assert_eq!(resp["error"]["code"], -32602);
    }

    /* ---- 数据解析联动(供 mod 层测试的记录构造 sanity) ---- */

    #[test]
    fn ctx_records_read_fresh_from_disk() {
        let ctx = sample_ctx("fresh-read");
        let path = ctx.data_path.as_ref().unwrap().clone();
        assert_eq!(ctx.records().len(), 4);
        // 追加后同一 ctx 再次读取应看到新条目(每次调用重读磁盘)
        crate::mcp::data::save_prompt(&path, "新", "B", &[], "MCP").unwrap();
        assert_eq!(ctx.records().len(), 5);
        let records = ctx.records();
        // 未删除条目 = 5 - 1(回收站里的 p3)= 4
        let live: Vec<_> = data::live(&records).collect();
        assert_eq!(live.len(), 4);
        assert_eq!(parse_records(&serde_json::from_str::<Value>("[]").unwrap()).len(), 0);
    }
}
