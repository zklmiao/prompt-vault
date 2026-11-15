//! 插件安装管线与宿主状态存储(插件系统批次1)。
//!
//! 职责(见 docs/plugin-system-design.md §2/§3/§4 与开工卡 A/B 节):
//! - 仓库源清单拉取 `plugin_fetch_source`:四平台 raw URL 推导 + ref 回退
//!   (显式分支 → main → master),URL 校验与 SSRF 防护复用 net.rs;
//! - 安装 `plugin_install`:下载缓存 → sha256 校验(不符删缓存)→ zip-slip
//!   防护解压(拒 `..`/绝对路径/软链;解压限额:单条目 8MB/累计 64MB/条目数 512,
//!   防高压缩比 zip 炸弹写满磁盘)→ manifest 校验(id/version/minAppVersion)
//!   → 版本化落盘 `plugins\store\<id>\<版本>\` + current 指针 → 更新 plugins.json;
//! - 卸载 `plugin_uninstall`:删 store/data 目录 + 更新 plugins.json(幂等);
//! - plugins.json 读写 `plugin_read_state` / `plugin_write_state`:
//!   字符串透传 + Rust 端 serde 校验,写盘复用 write_atomic;
//! - 插件沙箱 KV `plugin_kv_get` / `plugin_kv_set`:`plugins\data\<id>\kv.json`;
//! - 插件窗口 `plugin_open_window` / `plugin_close_window`:
//!   ui:"window" 插件的专属无边框置顶窗口(label = pv-plugin-<id>);
//! - 注入辅助 `plugin_read_entry` / `plugin_installed_manifest`:
//!   主窗口按 enabled 顺序注入 main.js(pv-1 内联注入)与消费语言包 JSON 前,
//!   从当前版本目录读包内文件内容,并解析包内 manifest。
//!
//! 存储布局(%APPDATA%\prompt-vault\):
//!   plugins.json                 —— 宿主状态(契约见开工卡 B,读端已存在于 net.rs/mcp)
//!   plugins\store\<id>\current   —— 纯文本指针,内容为当前版本目录名(原子写切换)
//!   plugins\store\<id>\<版本>\    —— 已解压插件包;更新保留上一版本作回滚点
//!   plugins\cache\<sha256>.zip   —— 下载缓存(sha256 不符即删)
//!   plugins\data\<id>\kv.json    —— 插件沙箱 KV
//!
//! 安全边界:本模块所有 URL 请求(拉清单/下 zip)仅 http/https,请求前过
//! net.rs 的 validate_url + assert_public_target(SSRF),不跟随重定向,响应体限长;
//! 与插件 net 白名单无关(市场源 URL 是宿主行为,非插件行为);不涉及任何凭据。

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use tauri::{Emitter, Manager};

/// 仓库清单响应体上限 2MB
const MAX_MANIFEST_BYTES: usize = 2 * 1024 * 1024;
/// 插件包下载上限 2MB(v1 插件 = JS + 数据文件,与清单同限)
const MAX_PACKAGE_BYTES: usize = 2 * 1024 * 1024;
/// 解压单条目上限 8MB(下载体积上限只约束压缩包,deflate 千倍膨胀可写满磁盘)
const MAX_ENTRY_UNCOMPRESSED_BYTES: usize = 8 * 1024 * 1024;
/// 解压累计上限 64MB(全部条目解压后的总字节数)
const MAX_TOTAL_UNCOMPRESSED_BYTES: usize = 64 * 1024 * 1024;
/// 插件包条目数上限(防海量小文件条目)
const MAX_ZIP_ENTRIES: usize = 512;
/// 沙箱 KV 单值上限 64KB
const KV_VALUE_MAX_BYTES: usize = 64 * 1024;
/// 插件窗口 label 前缀(capabilities 里以 pv-plugin-* 通配覆盖)
pub(crate) const PLUGIN_WINDOW_PREFIX: &str = "pv-plugin-";

/* ---------- 插件 id 与路径 ---------- */

/// 插件 id 合法性:kebab-case(`^[a-z0-9][a-z0-9-]{0,63}$` 的宽松等价,
/// 不允许空串/大写/下划线/空白;首尾连字符拒绝,防止路径拼接歧义)。
/// 所有以 id 参与拼路径的命令都必须先过这里,防目录穿越。
fn plugin_id_valid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('-')
        && !id.ends_with('-')
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn ensure_plugin_id(id: &str) -> Result<(), String> {
    if plugin_id_valid(id) {
        Ok(())
    } else {
        Err("插件 id 不合法:应为小写字母、数字和连字符组成的 kebab-case".to_string())
    }
}

/// plugins.json 与 config.json 同目录(契约 B;读端 net.rs/mcp 同此推导)
fn plugins_file_path() -> PathBuf {
    crate::config_file_path().with_file_name("plugins.json")
}

/// 插件存储根目录:%APPDATA%\prompt-vault\plugins
/// (pv-1 内联注入后宿主经 plugin_read_entry 读取包内文件,不再走 asset 协议)
pub(crate) fn plugins_root() -> PathBuf {
    crate::config_file_path()
        .with_file_name("plugins")
}

struct PluginRoot(PathBuf);

impl PluginRoot {
    /// 命令路径使用真实根目录;测试直接构造临时根目录
    fn discover() -> Self {
        Self(plugins_root())
    }

    fn store_dir(&self, id: &str) -> PathBuf {
        self.0.join("store").join(id)
    }

    fn cache_dir(&self) -> PathBuf {
        self.0.join("cache")
    }

    fn data_dir(&self, id: &str) -> PathBuf {
        self.0.join("data").join(id)
    }

    /// current 指针内容 = 当前版本目录名(无换行,原子写切换)
    fn current_version(&self, id: &str) -> Option<String> {
        std::fs::read_to_string(self.store_dir(id).join("current"))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    fn set_current_version(&self, id: &str, version: &str) -> Result<(), String> {
        crate::write_atomic(&self.store_dir(id).join("current"), version)
    }

    /// 解析当前版本目录;指针缺失/指向不存在时返回 None
    fn resolve_version_dir(&self, id: &str) -> Option<PathBuf> {
        let version = self.current_version(id)?;
        let dir = self.store_dir(id).join(version);
        dir.is_dir().then_some(dir)
    }
}

/* ---------- 版本比较(手写最小 semver,含 pre-release 排序) ---------- */

#[derive(Debug, PartialEq, Eq)]
enum PreId {
    Num(u64),
    Text(String),
}

#[derive(Debug, PartialEq, Eq)]
struct SemVer {
    major: u64,
    minor: u64,
    patch: u64,
    pre: Vec<PreId>,
}

/// 解析 `major.minor.patch[-pre]`;构建元数据(`+…`)忽略;非法输入返回 None
fn parse_semver(input: &str) -> Option<SemVer> {
    let s = input.trim();
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (s, None),
    };
    let core = core.split_once('+').map_or(core, |(c, _)| c);
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let mut ids = Vec::new();
    if let Some(p) = pre {
        let p = p.split_once('+').map_or(p, |(x, _)| x);
        if p.is_empty() {
            return None;
        }
        for ident in p.split('.') {
            if ident.is_empty() {
                return None;
            }
            if ident.bytes().all(|b| b.is_ascii_digit()) {
                ids.push(PreId::Num(ident.parse().ok()?));
            } else if ident
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            {
                ids.push(PreId::Text(ident.to_string()));
            } else {
                return None;
            }
        }
    }
    Some(SemVer {
        major,
        minor,
        patch,
        pre: ids,
    })
}

/// semver 优先级:核心三元组逐位比较;pre-release 优先级低于正式版;
/// pre 标识符逐项比较,数字 < 字母数字,同类按数值/字典序;前缀相同则少标识符更低
fn compare_semver(a: &SemVer, b: &SemVer) -> std::cmp::Ordering {
    let core = a
        .major
        .cmp(&b.major)
        .then(a.minor.cmp(&b.minor))
        .then(a.patch.cmp(&b.patch));
    if core != std::cmp::Ordering::Equal {
        return core;
    }
    match (a.pre.is_empty(), b.pre.is_empty()) {
        (true, true) => std::cmp::Ordering::Equal,
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        (false, false) => {
            for (x, y) in a.pre.iter().zip(b.pre.iter()) {
                let c = match (x, y) {
                    (PreId::Num(m), PreId::Num(n)) => m.cmp(n),
                    (PreId::Num(_), PreId::Text(_)) => std::cmp::Ordering::Less,
                    (PreId::Text(_), PreId::Num(_)) => std::cmp::Ordering::Greater,
                    (PreId::Text(m), PreId::Text(n)) => m.cmp(n),
                };
                if c != std::cmp::Ordering::Equal {
                    return c;
                }
            }
            a.pre.len().cmp(&b.pre.len())
        }
    }
}

/// minAppVersion 门:应用版本 >= 插件要求版本时放行。
/// 任一侧无法解析视为不满足(保守拒绝,报错信息会带具体要求)。
fn app_meets_min_version(min_required: &str, app_version: &str) -> bool {
    match (parse_semver(min_required), parse_semver(app_version)) {
        (Some(min), Some(app)) => compare_semver(&app, &min) != std::cmp::Ordering::Less,
        _ => false,
    }
}

/* ---------- 源 raw URL 推导(四平台) ---------- */

/// ref 序列:显式分支优先,否则先 main 再 master
fn refs_to_try(branch: Option<&str>) -> Vec<String> {
    match branch.map(str::trim).filter(|s| !s.is_empty()) {
        Some(b) => vec![b.to_string()],
        None => vec!["main".to_string(), "master".to_string()],
    }
}

/// 仓库路径段(owner/repo)校验:字母数字与 ._-,拒绝 . .. 与分隔符
fn validate_repo_segment(s: &str, what: &str) -> Result<(), String> {
    let s = s.trim();
    if s.is_empty() || s.len() > 100 {
        return Err(format!("{what} 长度不合法"));
    }
    if s == "." || s == ".." {
        return Err(format!("{what} 不合法"));
    }
    if !s
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err(format!("{what} 含不支持的字符"));
    }
    Ok(())
}

/// git ref 校验:拒绝空白、URL 特殊字符与路径穿越形状
fn validate_git_ref(git_ref: &str) -> Result<(), String> {
    if git_ref.is_empty() || git_ref.len() > 128 {
        return Err("分支名长度不合法".to_string());
    }
    let bad = git_ref.chars().any(|c| {
        c.is_whitespace() || matches!(c, '?' | '#' | '%' | '\\' | '\'' | '"') || c.is_control()
    }) || git_ref.starts_with('/')
        || git_ref.contains("..");
    if bad {
        return Err("分支名含不支持的字符".to_string());
    }
    Ok(())
}

/// gitea 自建主机解析:返回 (是否 http, 规范化 host[:port],含 [IPv6] 形式)。
/// 支持可选的 "http://" / "https://" 前缀 —— 自建源跟随用户主页地址的 scheme
/// (http 用于本地/内网静态服务等场景);默认 https。
fn parse_gitea_target(host: &str) -> Result<(bool, String), String> {
    let host = host.trim();
    let (use_http, rest) = if let Some(r) = host.strip_prefix("http://") {
        (true, r)
    } else if let Some(r) = host.strip_prefix("https://") {
        (false, r)
    } else {
        (false, host)
    };
    if rest.is_empty() || rest.len() > 253 {
        return Err("gitea 主机地址长度不合法".to_string());
    }
    if rest.contains('/') || rest.contains('\\') || rest.contains('@') {
        return Err("gitea 主机地址只需填域名(可选端口),不要带路径或凭据".to_string());
    }
    // [IPv6] 形式:方括号内允许十六进制与冒号(v4 映射允许点)
    if let Some(after) = rest.strip_prefix('[') {
        let Some(bracket_end) = after.find(']') else {
            return Err("gitea 主机地址的 IPv6 方括号不闭合".to_string());
        };
        let v6 = &after[..bracket_end];
        if v6.is_empty()
            || !v6
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.')
        {
            return Err("gitea 主机地址的 IPv6 形式不合法".to_string());
        }
        let tail = &after[bracket_end + 1..];
        if !tail.is_empty() {
            let Some(port) = tail.strip_prefix(':') else {
                return Err("gitea 主机地址不合法".to_string());
            };
            if port.is_empty() || port.len() > 5 || !port.bytes().all(|b| b.is_ascii_digit()) {
                return Err("gitea 端口不合法".to_string());
            }
        }
        return Ok((use_http, rest.to_string()));
    }
    let (label, port) = match rest.split_once(':') {
        Some((l, p)) => (l, Some(p)),
        None => (rest, None),
    };
    if label.is_empty() || label.contains("..") {
        return Err("gitea 主机地址不合法".to_string());
    }
    if !label
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
    {
        return Err("gitea 主机地址含不支持的字符".to_string());
    }
    if let Some(p) = port {
        if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return Err("gitea 端口不合法".to_string());
        }
    }
    Ok((use_http, rest.to_string()))
}

/// gitea 自建主机校验(旧布尔语义入口,内部走 parse_gitea_target)
#[cfg(test)]
fn validate_gitea_host(host: &str) -> Result<(), String> {
    parse_gitea_target(host).map(|_| ())
}

/// 四平台 raw 清单 URL 推导(设计 §3.1;gitea 为自建域名,须过 SSRF 校验)
fn source_raw_url(
    provider: &str,
    owner: &str,
    repo: &str,
    host: Option<&str>,
    git_ref: &str,
) -> Result<String, String> {
    let owner = owner.trim();
    let repo = repo.trim();
    validate_repo_segment(owner, "owner")?;
    validate_repo_segment(repo, "repo")?;
    validate_git_ref(git_ref)?;
    match provider {
        "github" => Ok(format!(
            "https://raw.githubusercontent.com/{owner}/{repo}/{git_ref}/pv-plugins.json"
        )),
        "gitee" => Ok(format!(
            "https://gitee.com/{owner}/{repo}/raw/{git_ref}/pv-plugins.json"
        )),
        "gitlab" => Ok(format!(
            "https://gitlab.com/{owner}/{repo}/-/raw/{git_ref}/pv-plugins.json"
        )),
        "gitea" => {
            let h = host
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "gitea 源需要提供主机地址".to_string())?;
            let (use_http, cleaned) = parse_gitea_target(h)?;
            let scheme = if use_http { "http" } else { "https" };
            Ok(format!("{scheme}://{cleaned}/{owner}/{repo}/raw/{git_ref}/pv-plugins.json"))
        }
        other => Err(format!("不支持的平台类型:{other}")),
    }
}

/* ---------- HTTP 下载(清单与插件包共用) ---------- */

enum FetchFail {
    NotFound,
    Other(String),
}

/// GET 指定 URL:15s 超时、不跟随重定向、响应体限长(404 单独区分供 ref 回退);
/// Agent 取 net.rs 的进程级共享实例(配置逐字一致),获得 keep-alive 连接复用
fn http_get_bytes(url: &url::Url, cap: usize) -> Result<Vec<u8>, FetchFail> {
    let agent = crate::net::shared_agent();
    let response = match agent.get(url.as_str()).call() {
        Ok(resp) => resp,
        Err(ureq::Error::Status(404, _)) => return Err(FetchFail::NotFound),
        Err(ureq::Error::Status(status, _)) => {
            return Err(FetchFail::Other(format!("HTTP {status}")));
        }
        Err(e) => return Err(FetchFail::Other(format!("网络请求失败:{e}"))),
    };
    let mut reader = response.into_reader().take((cap + 1) as u64);
    let mut buf = Vec::new();
    reader
        .read_to_end(&mut buf)
        .map_err(|e| FetchFail::Other(format!("读取响应失败:{e}")))?;
    if buf.len() > cap {
        return Err(FetchFail::Other("响应体超过大小上限".to_string()));
    }
    Ok(buf)
}

/* ---------- 仓库清单防御式解析 ---------- */

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChannelRef {
    pub(crate) version: String,
    pub(crate) url: String,
    pub(crate) sha256: String,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MarketEntry {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) desc: String,
    pub(crate) release: Option<ChannelRef>,
    pub(crate) beta: Option<ChannelRef>,
    pub(crate) min_app_version: Option<String>,
    pub(crate) permissions: Vec<String>,
}

#[derive(serde::Serialize, Clone, Debug)]
pub(crate) struct SourceManifest {
    pub(crate) name: String,
    pub(crate) plugins: Vec<MarketEntry>,
}

fn parse_channel_ref(v: &Value) -> Option<ChannelRef> {
    let version = v.get("version")?.as_str()?.trim();
    let url = v.get("url")?.as_str()?.trim();
    let sha256 = v.get("sha256")?.as_str()?.trim();
    if version.is_empty() || url.is_empty() || sha256.is_empty() {
        return None;
    }
    // 此处只做 scheme 前缀初筛;真正下载时会走 validate_url + SSRF 全量校验
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return None;
    }
    Some(ChannelRef {
        version: version.to_string(),
        url: url.to_string(),
        sha256: sha256.to_lowercase(),
    })
}

/// 单个市场条目解析;任何必需字段缺失/非法即整个条目跳过(坏条目不拖垮清单)
fn parse_market_entry(v: &Value) -> Option<MarketEntry> {
    let id = v.get("id")?.as_str()?.trim();
    if !plugin_id_valid(id) {
        return None;
    }
    let name = v.get("name")?.as_str()?.trim();
    if name.is_empty() {
        return None;
    }
    let desc = v
        .get("desc")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let channels = v.get("channels")?;
    let release = channels.get("release").and_then(parse_channel_ref);
    let beta = channels.get("beta").and_then(parse_channel_ref);
    if release.is_none() && beta.is_none() {
        return None;
    }
    let min_app_version = v
        .get("minAppVersion")
        .and_then(|x| x.as_str())
        .map(str::to_string);
    let permissions = v
        .get("permissions")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| p.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    Some(MarketEntry {
        id: id.to_string(),
        name: name.to_string(),
        desc,
        release,
        beta,
        min_app_version,
        permissions,
    })
}

/// 清单防御式解析:整体非 JSON / 缺 plugins 数组 → Err;坏条目逐条跳过
fn parse_source_manifest(raw: &str) -> Result<SourceManifest, String> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|_| "插件清单不是有效的 JSON".to_string())?;
    let arr = value
        .get("plugins")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "插件清单缺少 plugins 数组".to_string())?;
    let name = value
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let plugins: Vec<MarketEntry> = arr.iter().filter_map(parse_market_entry).collect();
    Ok(SourceManifest { name, plugins })
}

/* ---------- plugins.json 契约(写端校验) ---------- */

// 以下结构仅供写端校验字段形状(字段本身不读取),allow(dead_code) 消除未读告警

#[allow(dead_code)]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct McpSection {
    #[serde(default)]
    enabled: bool,
}

#[allow(dead_code)]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceConfig {
    id: String,
    #[serde(default)]
    name: String,
    provider: String,
    url: String,
    #[serde(default)]
    branch: Option<String>,
}

#[allow(dead_code)]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledEntry {
    version: String,
    channel: String,
    enabled: bool,
    sha256: String,
    installed_at: String,
    error: Option<String>,
    permissions: Vec<String>,
}

/// plugins.json 的写端校验结构:字段与契约 B 逐一对应。
/// installed 条目全部字段必填(error/permissions 由安装器显式写入),
/// version/sources/mcp 带缺省以容忍手写精简文件。
#[allow(dead_code)]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginsState {
    #[serde(default = "default_state_version")]
    version: i64,
    #[serde(default)]
    sources: Vec<SourceConfig>,
    #[serde(default)]
    active_source_id: Option<String>,
    #[serde(default)]
    installed: BTreeMap<String, InstalledEntry>,
    #[serde(default = "default_mcp_section")]
    mcp: McpSection,
}

fn default_state_version() -> i64 {
    1
}

fn default_mcp_section() -> McpSection {
    McpSection { enabled: false }
}

fn validate_plugins_state(raw: &str) -> Result<(), String> {
    serde_json::from_str::<PluginsState>(raw)
        .map(|_| ())
        .map_err(|e| format!("plugins.json 格式不正确:{e}"))
}

fn default_state_value() -> Value {
    json!({
        "version": 1,
        "sources": [],
        "activeSourceId": null,
        "installed": {},
        "mcp": { "enabled": false }
    })
}

/// 从磁盘读状态(缺文件回退默认骨架,不落盘);解析失败报可读错误
fn load_state_value() -> Result<Value, String> {
    match std::fs::read_to_string(plugins_file_path()) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("plugins.json 解析失败:{e}")),
        Err(_) => Ok(default_state_value()),
    }
}

fn save_state_value(state: &Value) -> Result<(), String> {
    let json = serde_json::to_string_pretty(state).map_err(|e| format!("状态序列化失败:{e}"))?;
    crate::write_atomic(&plugins_file_path(), &json)
}

/// installed 条目写入(纯函数,单测覆盖);返回是否发生了变更
fn set_installed_entry(state: &mut Value, id: &str, entry: Value) -> bool {
    if !state.is_object() {
        return false;
    }
    if !state
        .get("installed")
        .is_some_and(|v| v.is_object())
    {
        return false;
    }
    if let Some(map) = state.get_mut("installed").and_then(|v| v.as_object_mut()) {
        map.insert(id.to_string(), entry);
        return true;
    }
    false
}

/// installed 条目移除(纯函数,单测覆盖);返回是否发生了变更
fn remove_installed_entry(state: &mut Value, id: &str) -> bool {
    state
        .get_mut("installed")
        .and_then(|v| v.as_object_mut())
        .map(|map| map.remove(id).is_some())
        .unwrap_or(false)
}

/* ---------- sha256 ---------- */

fn normalize_sha256(input: &str) -> Option<String> {
    let s = input.trim().to_lowercase();
    if s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(s)
    } else {
        None
    }
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/* ---------- zip 解包(zip-slip 防护) ---------- */

/// 接受两种包结构:① 根级 manifest.json;② 单一顶层目录/<目录>/manifest.json。
/// 返回条目名需要剥掉的目录前缀("" 或 "dir/")。
fn detect_package_layout(names: &[String]) -> Result<String, String> {
    if names.iter().any(|n| n == "manifest.json") {
        return Ok(String::new());
    }
    let mut top_dirs: Vec<&str> = Vec::new();
    let mut has_root_files = false;
    for n in names {
        match n.split_once('/') {
            Some((dir, _)) => {
                if !top_dirs.contains(&dir) {
                    top_dirs.push(dir);
                }
            }
            None => has_root_files = true,
        }
    }
    if top_dirs.len() == 1 && !has_root_files {
        let prefix = format!("{}/", top_dirs[0]);
        if names
            .iter()
            .any(|n| n.as_str() == format!("{prefix}manifest.json"))
        {
            return Ok(prefix);
        }
        return Err("插件包内缺少 manifest.json".to_string());
    }
    Err("插件包结构不正确:应为根级 manifest.json 或单一顶层目录".to_string())
}

/// 相对路径安全判定:仅接受普通组件,拒绝绝对路径 / `..` / `.` / 盘符前缀 / NUL
fn safe_rel_path(rel: &str) -> Option<PathBuf> {
    if rel.contains('\0') {
        return None;
    }
    let p = Path::new(rel);
    if p.is_absolute() {
        return None;
    }
    let all_normal = p
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)));
    all_normal.then(|| p.to_path_buf())
}

fn entry_names<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<Vec<String>, String> {
    (0..archive.len())
        .map(|i| {
            archive
                .by_index_raw(i)
                .map(|f| f.name().to_string())
                .map_err(|e| format!("读取 zip 条目失败:{e}"))
        })
        .collect()
}

/// 解压到 dest(已做包结构判定 + 逐条目 zip-slip 防护 + 软链拒绝)。
/// 解压限额防 zip 炸弹:条目数 ≤ MAX_ZIP_ENTRIES、单条目解压 ≤
/// MAX_ENTRY_UNCOMPRESSED_BYTES、累计 ≤ MAX_TOTAL_UNCOMPRESSED_BYTES;
/// 全部流式边读边计,任一超限立即 Err(不先解压后检查),超限字节不落盘。
/// 任何条目失败即整体失败,由调用方清理半成品目录。
fn extract_plugin_zip(zip_bytes: &[u8], dest: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes))
        .map_err(|e| format!("插件包不是有效的 zip:{e}"))?;
    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(format!(
            "插件包条目数({})超过上限 {MAX_ZIP_ENTRIES},已拒绝解压",
            archive.len()
        ));
    }
    let prefix = detect_package_layout(&entry_names(&mut archive)?)?;
    let mut total_uncompressed: usize = 0;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip 条目失败:{e}"))?;
        if file.is_dir() {
            continue;
        }
        let name = file.name().to_string();
        let Some(rel) = name.strip_prefix(&prefix) else {
            return Err(format!("插件包内出现清单目录之外的条目:{name}"));
        };
        if rel.is_empty() {
            continue;
        }
        // unix 高位标识文件类型:S_IFLNK = 0o120000,软链条目一律拒绝
        if file.unix_mode().is_some_and(|m| m & 0o170_000 == 0o120_000) {
            return Err(format!("插件包含软链接条目,已拒绝:{name}"));
        }
        let Some(rel_path) = safe_rel_path(rel) else {
            return Err(format!("插件包内含不安全路径:{name}"));
        };
        let out_path = dest.join(rel_path);
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败:{e}"))?;
        }
        let mut out = std::fs::File::create(&out_path)
            .map_err(|e| format!("写入插件文件失败:{e}"))?;
        // 流式限额拷贝:分块边读边计,单条目/累计任一超限立即拒绝,
        // 超出的那一块不写入(而非解压完再检查)
        let mut buf = vec![0u8; 64 * 1024];
        let mut entry_uncompressed: usize = 0;
        loop {
            let n = file
                .read(&mut buf)
                .map_err(|e| format!("解压条目失败:{e}"))?;
            if n == 0 {
                break;
            }
            entry_uncompressed += n;
            if entry_uncompressed > MAX_ENTRY_UNCOMPRESSED_BYTES {
                return Err(format!(
                    "插件包单条目解压体积超过 8MB 上限,已拒绝:{name}"
                ));
            }
            total_uncompressed += n;
            if total_uncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES {
                return Err(format!(
                    "插件包累计解压体积超过 64MB 上限,已拒绝(条目:{name})"
                ));
            }
            out.write_all(&buf[..n])
                .map_err(|e| format!("解压条目失败:{e}"))?;
        }
    }
    Ok(())
}

/* ---------- 安装管线核心 ---------- */

/// 安装失败分类:sha256 不符需删缓存,其余错误保留缓存便于重试
#[derive(Debug)]
enum InstallError {
    ShaMismatch(String),
    Other(String),
}

#[derive(Debug)]
struct InstallOutcome {
    /// 契约 B 形状的 installed 条目(含 zip 内 manifest 的 permissions 快照)
    entry: Value,
    /// 切换前旧版本目录名(回滚点;与新版相同则无;生产路径仅测试断言读取)
    #[allow(dead_code)]
    old_version: Option<String>,
}

/// 从 zip 字节安装(sha 校验 → 结构判定 → manifest 校验 → 解压 → 指针切换 → 回滚清理)。
/// downloads/网络不在此层,由命令外壳负责;plugins.json 的更新也由调用方负责,
/// 便于在状态文件缺失/损坏时给出独立错误。
fn install_from_bytes(
    root: &PluginRoot,
    zip_bytes: &[u8],
    expect_sha256: &str,
    channel: &str,
    expect_id: &str,
    expect_version: &str,
    app_version: &str,
    prev_enabled: Option<bool>,
) -> Result<InstallOutcome, InstallError> {
    ensure_plugin_id(expect_id).map_err(InstallError::Other)?;
    if !matches!(channel, "release" | "beta") {
        return Err(InstallError::Other("通道只能是 release 或 beta".to_string()));
    }

    // ① sha256 校验(不符即止,调用方删缓存)
    let actual = sha256_hex(zip_bytes);
    if actual != expect_sha256 {
        return Err(InstallError::ShaMismatch(
            "插件包 sha256 校验失败:下载内容与清单不一致".to_string(),
        ));
    }

    // ② 包结构判定 + 读取 manifest.json(校验全部通过前不写任何文件)
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes))
        .map_err(|e| InstallError::Other(format!("插件包不是有效的 zip:{e}")))?;
    let names = entry_names(&mut archive).map_err(InstallError::Other)?;
    let prefix = detect_package_layout(&names).map_err(InstallError::Other)?;
    let manifest_name = format!("{prefix}manifest.json");
    let manifest_idx = names
        .iter()
        .position(|n| n.as_str() == manifest_name)
        .ok_or_else(|| InstallError::Other("插件包内缺少 manifest.json".to_string()))?;
    let manifest_bytes = {
        let mut f = archive
            .by_index(manifest_idx)
            .map_err(|e| InstallError::Other(format!("读取 manifest.json 失败:{e}")))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)
            .map_err(|e| InstallError::Other(format!("读取 manifest.json 失败:{e}")))?;
        buf
    };
    let manifest: Value = serde_json::from_slice(&manifest_bytes)
        .map_err(|_| InstallError::Other("manifest.json 不是有效的 JSON".to_string()))?;

    // ③ manifest 校验:id / version 与清单条目一致;minAppVersion 门
    let manifest_id = manifest
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| InstallError::Other("manifest.json 缺少 id".to_string()))?;
    if manifest_id != expect_id {
        return Err(InstallError::Other(format!(
            "插件包 id({manifest_id})与清单条目({expect_id})不一致,已拒绝安装"
        )));
    }
    let manifest_version = manifest
        .get("version")
        .and_then(|v| v.as_str())
        .ok_or_else(|| InstallError::Other("manifest.json 缺少 version".to_string()))?;
    if manifest_version != expect_version {
        return Err(InstallError::Other(format!(
            "插件包版本({manifest_version})与清单条目({expect_version})不一致,已拒绝安装"
        )));
    }
    if let Some(min_app) = manifest.get("minAppVersion").and_then(|v| v.as_str()) {
        if !app_meets_min_version(min_app, app_version) {
            return Err(InstallError::Other(format!(
                "应用版本过低:该插件要求 ≥ {min_app},当前应用版本 {app_version}"
            )));
        }
    }
    let permissions: Vec<String> = manifest
        .get("permissions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| p.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();

    // ④ 解压到版本目录(先清掉同版本残留,失败即删半成品)
    let target = root.store_dir(expect_id).join(expect_version);
    let _ = std::fs::remove_dir_all(&target);
    if std::fs::create_dir_all(&target).is_err() {
        let _ = std::fs::remove_dir_all(&target);
        return Err(InstallError::Other("创建插件版本目录失败".to_string()));
    }
    if let Err(e) = extract_plugin_zip(zip_bytes, &target) {
        let _ = std::fs::remove_dir_all(&target);
        return Err(InstallError::Other(e));
    }

    // ⑤ 原子切换 current 指针,保留上一版本为回滚点,清理更旧版本
    let old_version = root.current_version(expect_id);
    if let Err(e) = root.set_current_version(expect_id, expect_version) {
        let _ = std::fs::remove_dir_all(&target);
        return Err(InstallError::Other(format!("切换插件版本失败:{e}")));
    }
    let mut keep = vec![expect_version];
    if let Some(old) = &old_version {
        if old != expect_version {
            keep.push(old);
        }
    }
    prune_versions(root, expect_id, &keep);

    // ⑥ 生成契约 B 形状的 installed 条目(permissions 快照来自 zip 内 manifest)
    let entry = json!({
        "version": manifest_version,
        "channel": channel,
        "enabled": prev_enabled.unwrap_or(true),
        "sha256": expect_sha256,
        "installedAt": crate::now_iso_utc(),
        "error": null,
        "permissions": permissions,
    });
    Ok(InstallOutcome {
        entry,
        old_version,
    })
}

/// 只保留 keep 列出的版本目录,其余版本目录(更旧的)删除;
/// 非目录与 current 指针文件一律不动
fn prune_versions(root: &PluginRoot, id: &str, keep: &[&str]) {
    let Ok(entries) = std::fs::read_dir(root.store_dir(id)) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        if !path.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if keep.contains(&name.as_str()) {
            continue;
        }
        let _ = std::fs::remove_dir_all(path);
    }
}

/// 卸载产物清理:store/<id>/ 与 data/<id>/ 整目录删除(不存在即幂等成功)
fn uninstall_artifacts(root: &PluginRoot, id: &str) {
    let _ = std::fs::remove_dir_all(root.store_dir(id));
    let _ = std::fs::remove_dir_all(root.data_dir(id));
}

/* ---------- 沙箱 KV ---------- */

fn kv_read(path: &Path, key: &str) -> Result<Option<Value>, String> {
    if key.is_empty() {
        return Err("key 不能为空".to_string());
    }
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return Ok(None), // 尚未写入过任何键
    };
    let obj: Value =
        serde_json::from_str(&raw).map_err(|e| format!("kv.json 解析失败:{e}"))?;
    Ok(obj.get(key).cloned())
}

fn kv_write(path: &Path, key: &str, value: Value) -> Result<(), String> {
    if key.is_empty() || key.len() > 128 {
        return Err("key 长度需在 1-128 字节".to_string());
    }
    let encoded = serde_json::to_string(&value).map_err(|e| format!("值序列化失败:{e}"))?;
    if encoded.len() > KV_VALUE_MAX_BYTES {
        return Err(format!("单个键值过大(上限 {KV_VALUE_MAX_BYTES} 字节)"));
    }
    let mut obj: Value = match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("kv.json 解析失败:{e}"))?,
        Err(_) => json!({}),
    };
    let Some(map) = obj.as_object_mut() else {
        return Err("kv.json 格式不正确:应为对象".to_string());
    };
    map.insert(key.to_string(), value);
    let json = serde_json::to_string_pretty(&obj).map_err(|e| format!("kv 序列化失败:{e}"))?;
    crate::write_atomic(path, &json)
}

/* ---------- 调用者校验(P0 跨窗口加固) ---------- */

/// 仅主窗口放行:插件窗口冒充宿主调用 main-only 命令(改状态/装卸插件/写凭据)
/// 一律拒绝。主窗 webview 内的插件绕过桥直调 invoke 时 label 恒为 "main",
/// 命令层无法区分宿主与插件 —— 这是 D1 可信插件模型的已接受结构性边界,
/// 跨窗口维度之外的防护不在此实现(docs §8 两维威胁模型)。
pub(crate) fn ensure_caller_main(caller_label: &str) -> Result<(), String> {
    if caller_label == crate::MAIN_LABEL {
        Ok(())
    } else {
        Err("该命令仅限主窗口调用".to_string())
    }
}

/// 主窗口或「本插件自己的窗口」放行:self = 调用者窗口 label 与参数 plugin_id
/// 逐字匹配(pv-plugin-<plugin_id>),防 A 插件窗口冒充 B 插件读包文件、
/// 以 B 身份取数、操作 B 的窗口。逐字比较(区分大小写、非前缀匹配);
/// 无 plugin_id 参数的命令(plugin_credential_configured)以调用者自身
/// label 剥前缀得到的 id 传入,语义退化为「任意插件窗口可查」。
pub(crate) fn ensure_caller_self_or_main(
    caller_label: &str,
    plugin_id: &str,
) -> Result<(), String> {
    if caller_label == crate::MAIN_LABEL
        || caller_label == format!("{PLUGIN_WINDOW_PREFIX}{plugin_id}")
    {
        Ok(())
    } else {
        Err("插件窗口只能操作自身".to_string())
    }
}

/// 仅插件窗口放行(main 不放行):通知是插件专属副作用通道,宿主自身不发
/// 「插件通知」。返回剥前缀后的 plugin_id(credential_configured 的 label 剥
/// 前缀先例 —— 插件窗口 label 由宿主以 pv-plugin-<id> 创建,无歧义;id 来自
/// 调用者自身 label 而非可传参数,A 插件窗口无法借此冒充 B 插件)。
pub(crate) fn ensure_caller_plugin_window(caller_label: &str) -> Result<String, String> {
    caller_label
        .strip_prefix(PLUGIN_WINDOW_PREFIX)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "该命令仅限插件窗口调用".to_string())
}

/* ---------- 命令 ---------- */

/// 拉取激活源的插件清单(host 仅 gitea 平台使用;四平台 ref 回退见 refs_to_try)。
/// async 命令:调用者校验留在外层;ref 推导/URL/SSRF 校验、DNS、HTTP、清单解析
/// 全链整体进阻塞池,不冻结主窗口事件循环。
#[tauri::command]
pub async fn plugin_fetch_source(
    window: tauri::WebviewWindow,
    provider: String,
    owner: String,
    repo: String,
    branch: Option<String>,
    host: Option<String>,
) -> Result<SourceManifest, String> {
    ensure_caller_main(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        plugin_fetch_source_with(provider, owner, repo, branch, host)
    })
    .await
    .map_err(|e| format!("后台任务执行失败:{e}"))?
}

/// 命令体(调用者校验后执行;与签名解耦便于单测)
fn plugin_fetch_source_with(
    provider: String,
    owner: String,
    repo: String,
    branch: Option<String>,
    host: Option<String>,
) -> Result<SourceManifest, String> {
    for git_ref in refs_to_try(branch.as_deref()) {
        let url = source_raw_url(
            &provider,
            owner.trim(),
            repo.trim(),
            host.as_deref(),
            &git_ref,
        )?;
        let parsed = crate::net::validate_url(&url)?;
        // 源 URL 是宿主行为(非插件联网),不做插件白名单,SSRF 校验必须过
        crate::net::assert_public_target(&parsed)?;
        match http_get_bytes(&parsed, MAX_MANIFEST_BYTES) {
            Ok(bytes) => {
                let body = String::from_utf8_lossy(&bytes).into_owned();
                return parse_source_manifest(&body);
            }
            Err(FetchFail::NotFound) => continue, // 该分支无清单,试下一个 ref
            Err(FetchFail::Other(e)) => return Err(format!("拉取插件清单失败:{e}")),
        }
    }
    Err("插件清单不存在:main 与 master 分支都未找到 pv-plugins.json".to_string())
}

/// 安装/更新插件:下载 → sha256 → 解压 → 校验 → 落盘 → 更新 plugins.json。
/// expect_* 四参数来自市场清单条目,zip 内 manifest 必须与之逐字一致。
/// async 命令:调用者校验留在外层;通道/参数校验与 DNS、HTTP、解压、写盘全链
/// 整体进阻塞池,不冻结主窗口事件循环。
#[tauri::command]
pub async fn plugin_install(
    window: tauri::WebviewWindow,
    url: String,
    sha256: String,
    channel: String,
    expect_id: String,
    expect_version: String,
) -> Result<Value, String> {
    ensure_caller_main(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        plugin_install_with(url, sha256, channel, expect_id, expect_version)
    })
    .await
    .map_err(|e| format!("后台任务执行失败:{e}"))?
}

/// 命令体(调用者校验后执行)
fn plugin_install_with(
    url: String,
    sha256: String,
    channel: String,
    expect_id: String,
    expect_version: String,
) -> Result<Value, String> {
    if !matches!(channel.as_str(), "release" | "beta") {
        return Err("通道只能是 release 或 beta".to_string());
    }
    ensure_plugin_id(&expect_id)?;
    let expect_sha = normalize_sha256(&sha256)
        .ok_or_else(|| "sha256 不合法:应为 64 位十六进制串".to_string())?;
    let parsed = crate::net::validate_url(&url)?;
    crate::net::assert_public_target(&parsed)?;

    let root = PluginRoot::discover();
    let bytes = http_get_bytes(&parsed, MAX_PACKAGE_BYTES)
        .map_err(|e| match e {
            FetchFail::NotFound => "插件包下载失败:HTTP 404".to_string(),
            FetchFail::Other(m) => format!("插件包下载失败:{m}"),
        })?;

    // 先落缓存(sha256 为文件名,便于失败重试不重复下载)
    let cache_path = root.cache_dir().join(format!("{expect_sha}.zip"));
    std::fs::create_dir_all(root.cache_dir()).map_err(|e| format!("创建缓存目录失败:{e}"))?;
    std::fs::write(&cache_path, &bytes).map_err(|e| format!("写入缓存失败:{e}"))?;

    // 已安装条目的 enabled 状态在更新时保留(首次安装默认启用)
    let prev_enabled = load_state_value()
        .ok()
        .and_then(|v| {
            v.get("installed")?
                .get(&expect_id)?
                .get("enabled")?
                .as_bool()
        });

    match install_from_bytes(
        &root,
        &bytes,
        &expect_sha,
        &channel,
        &expect_id,
        &expect_version,
        env!("CARGO_PKG_VERSION"),
        prev_enabled,
    ) {
        Ok(outcome) => {
            let mut state = load_state_value()?;
            let entry = outcome.entry.clone();
            if !set_installed_entry(&mut state, &expect_id, outcome.entry) {
                return Err("plugins.json 缺少 installed 对象,无法记录安装状态".to_string());
            }
            save_state_value(&state)?;
            Ok(entry)
        }
        Err(InstallError::ShaMismatch(msg)) => {
            let _ = std::fs::remove_file(&cache_path);
            Err(msg)
        }
        Err(InstallError::Other(msg)) => Err(msg),
    }
}

/// 卸载插件:删 store/<id>/ 与 data/<id>/,更新 plugins.json;重复调用幂等
#[tauri::command]
pub fn plugin_uninstall(window: tauri::WebviewWindow, id: String) -> Result<(), String> {
    ensure_caller_main(window.label())?;
    plugin_uninstall_with(id)
}

/// 命令体(调用者校验后执行)
fn plugin_uninstall_with(id: String) -> Result<(), String> {
    ensure_plugin_id(&id)?;
    let root = PluginRoot::discover();
    uninstall_artifacts(&root, &id);
    // 状态文件缺失/损坏时不报错:目录已清理,残留条目由下次写状态覆盖
    let mut state = load_state_value()?;
    remove_installed_entry(&mut state, &id);
    save_state_value(&state)?;
    Ok(())
}

/// 宿主读取 plugins.json;文件缺失返回默认骨架(不落盘),损坏返回可读错误
#[tauri::command]
pub fn plugin_read_state(window: tauri::WebviewWindow) -> Result<String, String> {
    ensure_caller_main(window.label())?;
    plugin_read_state_with()
}

/// 命令体(调用者校验后执行)
fn plugin_read_state_with() -> Result<String, String> {
    match std::fs::read_to_string(plugins_file_path()) {
        Ok(raw) => {
            validate_plugins_state(&raw)?;
            Ok(raw)
        }
        Err(_) => Ok(serde_json::to_string_pretty(&default_state_value())
            .unwrap_or_else(|_| "{}".to_string())),
    }
}

/// 宿主写入 plugins.json:字符串透传 + serde 校验,写盘复用 write_atomic
#[tauri::command]
pub fn plugin_write_state(
    window: tauri::WebviewWindow,
    json: String,
) -> Result<(), String> {
    ensure_caller_main(window.label())?;
    plugin_write_state_with(json)
}

/// 命令体(调用者校验后执行)
fn plugin_write_state_with(json: String) -> Result<(), String> {
    validate_plugins_state(&json)?;
    crate::write_atomic(&plugins_file_path(), &json)
}

/// 插件沙箱 KV 读取(键不存在返回 null)
#[tauri::command]
pub fn plugin_kv_get(
    window: tauri::WebviewWindow,
    plugin_id: String,
    key: String,
) -> Result<Option<Value>, String> {
    ensure_caller_self_or_main(window.label(), &plugin_id)?;
    plugin_kv_get_with(plugin_id, key)
}

/// 命令体(调用者校验后执行)
fn plugin_kv_get_with(plugin_id: String, key: String) -> Result<Option<Value>, String> {
    ensure_plugin_id(&plugin_id)?;
    let root = PluginRoot::discover();
    kv_read(&root.data_dir(&plugin_id).join("kv.json"), &key)
}

/// 插件沙箱 KV 写入
#[tauri::command]
pub fn plugin_kv_set(
    window: tauri::WebviewWindow,
    plugin_id: String,
    key: String,
    value: Value,
) -> Result<(), String> {
    ensure_caller_self_or_main(window.label(), &plugin_id)?;
    plugin_kv_set_with(plugin_id, key, value)
}

/// 命令体(调用者校验后执行)
fn plugin_kv_set_with(plugin_id: String, key: String, value: Value) -> Result<(), String> {
    ensure_plugin_id(&plugin_id)?;
    let root = PluginRoot::discover();
    kv_write(
        &root.data_dir(&plugin_id).join("kv.json"),
        &key,
        value,
    )
}

/// 插件包内文件大小上限 2MB(main.js 与语言包 JSON 均为小文本;与插件包同限)
const MAX_ENTRY_BYTES: usize = 2 * 1024 * 1024;

/// 读取当前版本目录下相对路径文件内容(pv-1 内联注入用:宿主取 main.js 源码
/// 包进 IIFE 执行,语言包插件取 <语言码>.json;不再暴露文件路径走 asset 协议)。
/// rel_path 过 safe_rel_path(穿越/绝对路径/NUL 拒绝);文件缺失返回 None;
/// 非 UTF-8 或超过 2MB 返回可读错误。root 可注入,命令外壳与单测共用。
fn read_entry(
    root: &PluginRoot,
    plugin_id: &str,
    rel_path: &str,
) -> Result<Option<String>, String> {
    ensure_plugin_id(plugin_id)?;
    let Some(dir) = root.resolve_version_dir(plugin_id) else {
        return Ok(None);
    };
    let Some(rel) = safe_rel_path(rel_path) else {
        return Err(format!(
            "插件文件路径不合法:{rel_path}(拒绝绝对路径与目录穿越)"
        ));
    };
    let path = dir.join(rel);
    let Ok(meta) = std::fs::metadata(&path) else {
        return Ok(None); // 文件缺失由调用方决定语义(如语言包码缺文件 → 跳过)
    };
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() as usize > MAX_ENTRY_BYTES {
        return Err(format!("插件文件过大(上限 {MAX_ENTRY_BYTES} 字节):{rel_path}"));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("读取插件文件失败:{e}"))?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| format!("插件文件不是有效的 UTF-8 文本:{rel_path}"))
}

#[tauri::command]
pub fn plugin_read_entry(
    window: tauri::WebviewWindow,
    plugin_id: String,
    rel_path: String,
) -> Result<Option<String>, String> {
    ensure_caller_self_or_main(window.label(), &plugin_id)?;
    read_entry(&PluginRoot::discover(), &plugin_id, &rel_path)
}

/// 已安装插件包内 manifest.json 内容(宿主展示名称/ui 形态/错误恢复用)
#[tauri::command]
pub fn plugin_installed_manifest(
    window: tauri::WebviewWindow,
    plugin_id: String,
) -> Result<Option<Value>, String> {
    ensure_caller_self_or_main(window.label(), &plugin_id)?;
    plugin_installed_manifest_with(plugin_id)
}

/// 命令体(调用者校验后执行)
fn plugin_installed_manifest_with(plugin_id: String) -> Result<Option<Value>, String> {
    ensure_plugin_id(&plugin_id)?;
    let root = PluginRoot::discover();
    let Some(dir) = root.resolve_version_dir(&plugin_id) else {
        return Ok(None);
    };
    match std::fs::read_to_string(dir.join("manifest.json")) {
        Ok(raw) => match serde_json::from_str(&raw) {
            Ok(v) => Ok(Some(v)),
            Err(_) => Ok(None),
        },
        Err(_) => Ok(None),
    }
}

/// 打开插件专属窗口(label = pv-plugin-<id>;已存在则唤起)。
/// 尺寸由宿主传入(来自插件 pv.window.setup 声明),缺省 320×240;
/// x/y 为记忆位置(物理像素,Rust 拖动防抖写入 kv),有值则换算为逻辑像素
/// 经 builder.position 直接可见定位创建 —— 与"先 set_position 后 show"等效防闪跳。
/// 必须是 async 命令:Tauri v2 在 Windows 上同步命令里创建窗口会死锁
/// (webview 创建需等待事件循环,而同步命令正占用主线程;官方文档明确要求),
/// async 命令在运行时线程执行,事件循环保持空闲可完成 webview 初始化。
#[tauri::command]
pub async fn plugin_open_window(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    plugin_id: String,
    width: Option<f64>,
    height: Option<f64>,
    x: Option<i32>,
    y: Option<i32>,
) -> Result<(), String> {
    ensure_caller_self_or_main(window.label(), &plugin_id)?;
    plugin_open_window_with(app, plugin_id, width, height, x, y)
}

/// 命令体(调用者校验后执行)
fn plugin_open_window_with(
    app: tauri::AppHandle,
    plugin_id: String,
    width: Option<f64>,
    height: Option<f64>,
    x: Option<i32>,
    y: Option<i32>,
) -> Result<(), String> {
    ensure_plugin_id(&plugin_id)?;
    let label = format!("{PLUGIN_WINDOW_PREFIX}{plugin_id}");
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    let title = plugin_installed_manifest_with(plugin_id.clone())
        .ok()
        .flatten()
        .and_then(|m| m.get("name").and_then(|n| n.as_str()).map(str::to_string))
        .unwrap_or_else(|| plugin_id.clone());
    let width = width.unwrap_or(320.0);
    let height = height.unwrap_or(240.0);
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(format!("index.html?plugin={plugin_id}").into()),
    )
    .title(format!("Prompt Vault · {title}"))
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .inner_size(width, height);
    match (x, y) {
        (Some(px), Some(py)) => {
            // 记忆位置(物理像素)→ 逻辑像素(按主窗缩放,兜底 1.0)
            let scale = app
                .get_webview_window(crate::MAIN_LABEL)
                .and_then(|m| m.scale_factor().ok())
                .unwrap_or(1.0);
            builder = builder.position(px as f64 / scale, py as f64 / scale);
        }
        _ => {
            // 缺省定位:尽力跟随主窗口居中,失败用系统默认位置
            if let Some(main) = app.get_webview_window(crate::MAIN_LABEL) {
                if let (Ok(pos), Ok(size)) = (main.outer_position(), main.inner_size()) {
                    let scale = main.scale_factor().unwrap_or(1.0);
                    let x = pos.x as f64 + (size.width as f64 / scale - width) / 2.0;
                    let y = pos.y as f64 + (size.height as f64 / scale - height) / 2.0;
                    builder = builder.position(x.max(0.0), y.max(0.0));
                }
            }
        }
    }
    builder
        .build()
        .map_err(|e| format!("创建插件窗口失败:{e}"))?;
    Ok(())
}

/// 调整插件窗口尺寸(逻辑像素;球窗右键菜单临时扩窗,收起后由插件恢复 84×84)
#[tauri::command]
pub fn plugin_resize_window(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    plugin_id: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    ensure_caller_self_or_main(window.label(), &plugin_id)?;
    plugin_resize_window_with(app, plugin_id, width, height)
}

/// 命令体(调用者校验后执行)
fn plugin_resize_window_with(
    app: tauri::AppHandle,
    plugin_id: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    ensure_plugin_id(&plugin_id)?;
    if !width.is_finite() || !height.is_finite() || width <= 0.0 || height <= 0.0 {
        return Err("窗口尺寸需为正数".to_string());
    }
    let label = format!("{PLUGIN_WINDOW_PREFIX}{plugin_id}");
    let Some(window) = app.get_webview_window(&label) else {
        return Err("插件窗口不存在".to_string());
    };
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| format!("调整插件窗口尺寸失败:{e}"))
}

/// 启动球窗系统拖动循环(必须处于鼠标按下状态,由插件 mousemove 阈值分支调用)。
/// 走自定义命令而非 core:window|start_dragging:自定义命令不经 capability 校验,
/// 避免 core 权限面差异导致拖动静默失效(冒烟实测);拖动终点位置仍由
/// Moved 防抖独占落盘,架构上位置写入权在 Rust 不变。
#[tauri::command]
pub fn plugin_start_drag(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    plugin_id: String,
) -> Result<(), String> {
    ensure_caller_self_or_main(window.label(), &plugin_id)?;
    plugin_start_drag_with(app, plugin_id)
}

/// 命令体(调用者校验后执行)
fn plugin_start_drag_with(app: tauri::AppHandle, plugin_id: String) -> Result<(), String> {
    ensure_plugin_id(&plugin_id)?;
    let label = format!("{PLUGIN_WINDOW_PREFIX}{plugin_id}");
    let Some(window) = app.get_webview_window(&label) else {
        return Err("插件窗口不存在".to_string());
    };
    window
        .start_dragging()
        .map_err(|e| format!("启动拖动失败:{e}"))
}

/// 球窗唤出主窗口并激活本插件详情面板:show main → emit pv-open-plugin-panel
/// (payload = plugin_id,主窗口切插件分栏并打开对应页签)
#[tauri::command]
pub fn plugin_show_main_panel(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    plugin_id: String,
) -> Result<(), String> {
    ensure_caller_self_or_main(window.label(), &plugin_id)?;
    plugin_show_main_panel_with(app, plugin_id)
}

/// 命令体(调用者校验后执行)
fn plugin_show_main_panel_with(app: tauri::AppHandle, plugin_id: String) -> Result<(), String> {
    ensure_plugin_id(&plugin_id)?;
    crate::show_main_window(&app);
    let _ = app.emit_to(crate::MAIN_LABEL, "pv-open-plugin-panel", plugin_id);
    Ok(())
}

/// 关闭插件窗口(停用/卸载前由宿主调用;不存在则静默)
#[tauri::command]
pub fn plugin_close_window(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    plugin_id: String,
) -> Result<(), String> {
    ensure_caller_self_or_main(window.label(), &plugin_id)?;
    plugin_close_window_with(app, plugin_id)
}

/// 命令体(调用者校验后执行)
fn plugin_close_window_with(app: tauri::AppHandle, plugin_id: String) -> Result<(), String> {
    if ensure_plugin_id(&plugin_id).is_ok() {
        if let Some(w) = app.get_webview_window(&format!("{PLUGIN_WINDOW_PREFIX}{plugin_id}")) {
            let _ = w.close();
        }
    }
    Ok(())
}

/* ---------- 插件系统通知(pv.notify 的 Rust 侧) ---------- */

/// 通知标题友好截断上限(字符数;非安全边界,仅为系统通知弹窗可读性)
const NOTIFY_TITLE_MAX_CHARS: usize = 100;
/// 通知正文友好截断上限(字符数;非安全边界,仅为系统通知弹窗可读性)
const NOTIFY_BODY_MAX_CHARS: usize = 300;

/// 按字符数截断(char 计,不切 UTF-8 多字节;非安全边界 —— 上限只为弹窗可读性,
/// 不承担注入/长度攻击防护,那是权限校验与系统通知管线的职责)
fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// 插件系统通知(Windows 通知中心):仅插件窗口可调,plugin_id 由调用者 label
/// 剥前缀推导(不可传参冒充,main 不放行);permissions 安装时快照须含 "notify"。
/// 通知经 tauri-plugin-notification 的 Rust API 发送,不经其 JS 命令,
/// capabilities 零改动(权限双层校验:桥面 manifest 快照 + 本命令层快照)。
#[tauri::command]
pub fn plugin_notify(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    let plugin_id = ensure_caller_plugin_window(window.label())?;
    let permissions = crate::net::permissions_for(&plugin_id)?;
    if !permissions.iter().any(|p| p == "notify") {
        return Err("插件未声明通知权限".to_string());
    }
    // 便携版通知可达性:确保 AUMID 快捷方式存在,失败即报错(插件侧按「宁重勿漏」
    // 于下次取数重试,且不写去重状态)
    ensure_aumid_shortcut(app.config().identifier.as_str())?;
    // 友好截断(校验后、发送前):系统通知弹窗承载有限,超长文案就地截断
    let title = truncate_chars(&title, NOTIFY_TITLE_MAX_CHARS);
    let body = truncate_chars(&body, NOTIFY_BODY_MAX_CHARS);
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| format!("通知发送失败:{e}"))
}

/* ---------- 便携版通知可达性(开始菜单 AUMID 快捷方式) ---------- */

/// AUMID 快捷方式的文件名(Windows 通知平台按 AUMID 查此快捷方式决定投递)
#[cfg(windows)]
const AUMID_SHORTCUT_NAME: &str = "Prompt Vault.lnk";
/// 并发互斥:多个插件窗口同时 notify 时避免并发写同一 .lnk(覆盖写竞态防损坏)
#[cfg(windows)]
static AUMID_SHORTCUT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 确保「开始菜单\程序」下存在 AppUserModelID = app_id 的快捷方式(每次调用覆盖写,
/// 兼容便携 exe 任意挪动;用户可写目录无需管理员)。
///
/// 背景(2026-11-15 排查):WinRT 通知 `CreateToastNotifierWithId(app_id)` 要求
/// AUMID 对应一个已注册的开始菜单快捷方式 —— NSIS 安装版由安装器创建,便携版
/// 裸跑没有 → 通知被 Windows **静默丢弃**而 `show()` 仍返回 Ok,插件侧误判已
/// 送达并写去重状态,整个 5h 窗口不再重试(红点有、消息始终无)。token-monitor
/// 告警通知即栽在此处。快捷方式指向当前 exe,NSIS 安装版共存时同 AUMID 切换
/// target,投递不受影响。
#[cfg(windows)]
pub(crate) fn ensure_aumid_shortcut(app_id: &str) -> Result<(), String> {
    use windows::core::{HSTRING, Interface, PWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemAlloc, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PROPVARIANT};
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, PSGetPropertyKeyFromName};

    let _guard = AUMID_SHORTCUT_LOCK.lock().map_err(|e| format!("AUMID 锁中毒:{e}"))?;

    // 目标:开始菜单\程序\Prompt Vault.lnk → 当前 exe(可写目录,无需管理员)
    let appdata = std::env::var("APPDATA").map_err(|_| "无法读取 APPDATA 环境变量".to_string())?;
    let programs_dir = std::path::PathBuf::from(appdata)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs");
    std::fs::create_dir_all(&programs_dir).map_err(|e| format!("创建开始菜单目录失败:{e}"))?;
    let lnk_path = programs_dir.join(AUMID_SHORTCUT_NAME);
    let exe_path = std::env::current_exe().map_err(|e| format!("读取当前 exe 路径失败:{e}"))?;

    unsafe {
        // COM 就绪:S_FALSE(本线程已初始化)与 RPC_E_CHANGED_MODE(线程已是其他
        // 套间,COM 仍可用)都可容忍;其余错误放弃本次,下次通知重试
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        if hr.is_err() && hr != windows::core::HRESULT(0x8001_0106_u32 as i32) {
            return Err(format!("COM 初始化失败:{hr:?}"));
        }

        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("创建 ShellLink 失败:{e}"))?;
        let exe_hs = HSTRING::from(exe_path.as_os_str());
        link.SetPath(&exe_hs)
            .map_err(|e| format!("设置快捷方式目标失败:{e}"))?;
        link.SetIconLocation(&exe_hs, 0)
            .map_err(|e| format!("设置快捷方式图标失败:{e}"))?;
        if let Some(parent) = exe_path.parent() {
            link.SetWorkingDirectory(&HSTRING::from(parent.as_os_str()))
                .map_err(|e| format!("设置快捷方式工作目录失败:{e}"))?;
        }
        link.SetDescription(&HSTRING::from("Prompt Vault 本地 Prompt 收藏工具"))
            .map_err(|e| format!("设置快捷方式描述失败:{e}"))?;

        // PKEY_AppUserModel_ID 按属性名解析(不硬编码 GUID);值 = VT_LPWSTR,
        // 需 CoTaskMemAlloc 缓冲(属性表契约),SetValue 内部拷贝后即清
        let store: IPropertyStore = link.cast().map_err(|e| format!("获取属性表失败:{e}"))?;
        let mut key = windows::Win32::Foundation::PROPERTYKEY::default();
        PSGetPropertyKeyFromName(&HSTRING::from("System.AppUserModel.ID"), &mut key)
            .map_err(|e| format!("解析 AppUserModelID 属性键失败:{e}"))?;
        let wide: Vec<u16> = app_id.encode_utf16().chain(core::iter::once(0)).collect();
        let mem = CoTaskMemAlloc(wide.len() * 2);
        if mem.is_null() {
            return Err("CoTaskMemAlloc 失败".to_string());
        }
        core::ptr::copy_nonoverlapping(wide.as_ptr(), mem.cast::<u16>(), wide.len());
        let mut prop = PROPVARIANT::default();
        // union 字段写入:整结构体赋值(零值旧内容无自有资源,覆写安全)
        *prop.Anonymous.Anonymous = windows::Win32::System::Com::StructuredStorage::PROPVARIANT_0_0 {
            vt: VT_LPWSTR,
            wReserved1: 0,
            wReserved2: 0,
            wReserved3: 0,
            Anonymous: windows::Win32::System::Com::StructuredStorage::PROPVARIANT_0_0_0 {
                pwszVal: PWSTR::from_raw(mem.cast::<u16>()),
            },
        };
        let set_result = store.SetValue(&key, &prop);
        let _ = PropVariantClear(&mut prop); // SetValue 已拷贝,就地释放缓冲
        set_result.map_err(|e| format!("写入 AUMID 属性失败:{e}"))?;
        store.Commit().map_err(|e| format!("提交 AUMID 属性失败:{e}"))?;

        let lnk_hs = HSTRING::from(lnk_path.as_os_str());
        let persist: IPersistFile = link.cast().map_err(|e| format!("获取 IPersistFile 失败:{e}"))?;
        persist
            .Save(&lnk_hs, true)
            .map_err(|e| format!("保存快捷方式失败:{e}"))?;
    }
    Ok(())
}

/// 非 Windows 平台:通知走系统原生通道,无需快捷方式
#[cfg(not(windows))]
pub(crate) fn ensure_aumid_shortcut(_app_id: &str) -> Result<(), String> {
    Ok(())
}

/* ---------- 球窗位置持久化(Rust 独占写,插件 JS 不感知) ---------- */

/// 拖动防抖静默期:最后一次 Moved 后 300ms 无新事件才落盘
const POSITION_SAVE_DEBOUNCE_MS: u64 = 300;

/// 在途防抖计时器登记:label → 已派生计时器( Mutex<Option<Map> 以便 const 初始化)
static POSITION_SAVE_PENDING: std::sync::Mutex<Option<BTreeMap<String, ()>>> =
    std::sync::Mutex::new(None);

/// Moved 事件挂点(lib.rs on_window_event 调用):每 label 一个在途计时器,
/// 首个 Moved 派生防抖线程,静默期内的后续 Moved 不重复派生 —— 计时器到点时
/// 重新读取窗口当前位置落盘,天然收敛到最终位置。
pub(crate) fn schedule_plugin_position_save(app: tauri::AppHandle, label: String) {
    let Some(plugin_id) = label.strip_prefix(PLUGIN_WINDOW_PREFIX).map(str::to_string) else {
        return;
    };
    let Ok(mut pending) = POSITION_SAVE_PENDING.lock() else {
        return; // Mutex 中毒:放弃本次落盘(下次 Moved 重试)
    };
    let map = pending.get_or_insert_with(BTreeMap::new);
    if map.contains_key(&label) {
        return; // 已有计时器在途,静默期内不重复派生
    }
    map.insert(label.clone(), ());
    drop(pending);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(POSITION_SAVE_DEBOUNCE_MS));
        // 先摘除在途登记再落盘:落盘期间的新 Moved 会派生新计时器,最终收敛
        if let Ok(mut pending) = POSITION_SAVE_PENDING.lock() {
            if let Some(map) = pending.as_mut() {
                map.remove(&label);
            }
        }
        // 窗口可能已关闭:静默跳过(此前拖动过的位置已在此前轮落盘)
        let Some(window) = app.get_webview_window(&label) else {
            return;
        };
        if let Ok(pos) = window.outer_position() {
            let root = PluginRoot::discover();
            let _ = persist_window_position(&root, &plugin_id, pos.x, pos.y);
        }
    });
}

/// 把插件窗口位置写入该插件 kv.json 的 window:x / window:y(物理像素)。
/// 复用沙箱 KV 的读写函数直接落盘,不经 IPC;插件 JS 不读写这两个键。
fn persist_window_position(
    root: &PluginRoot,
    plugin_id: &str,
    x: i32,
    y: i32,
) -> Result<(), String> {
    ensure_plugin_id(plugin_id)?;
    let path = root.data_dir(plugin_id).join("kv.json");
    kv_write(&path, "window:x", json!(x))?;
    kv_write(&path, "window:y", json!(y))
}

/* ---------- 测试 ---------- */

/// 三方共用的 plugins.json 契约样例(开工卡 B):
/// 本文件的写端校验(PluginsState)、net.rs 的 permissions 读端、
/// mcp/mod.rs 的 mcp.enabled 读端,三方测试断言同一份样例。
#[cfg(test)]
pub(crate) mod contract_sample {
    pub(crate) const PLUGINS_JSON: &str = r#"{
  "version": 1,
  "sources": [
    {
      "id": "official",
      "name": "Prompt Vault 官方插件源",
      "provider": "github",
      "url": "https://github.com/prompt-vault/plugins",
      "branch": null
    }
  ],
  "activeSourceId": "official",
  "installed": {
    "token-monitor": {
      "version": "1.0.0",
      "channel": "release",
      "enabled": true,
      "sha256": "3f79bb7b435b05321651dcef1f4d0c6ea6c9a6debd7d9c4b7d1b6d5a5f5a5f5a",
      "installedAt": "2026-11-13T08:00:00.000Z",
      "error": null,
      "permissions": [
        "net:open.bigmodel.cn",
        "net:ark.cn-beijing.volcengineapi.com",
        "net:opencode.ai",
        "credential:glm",
        "window:float"
      ]
    }
  },
  "mcp": { "enabled": false }
}"#;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PluginRoot {
        let dir = std::env::temp_dir().join(format!(
            "pv-plugins-test-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        PluginRoot(dir)
    }

    /// AUMID 快捷方式端到端:真实走一遍 COM(IShellLink + 属性表 + IPersistFile),
    /// 验证开始菜单 .lnk 生成后清理(便携版通知可达性的关键路径)
    #[test]
    #[cfg(windows)]
    fn aumid_shortcut_creates_lnk() {
        ensure_aumid_shortcut("com.zklmiao.prompt-vault")
            .expect("AUMID 快捷方式创建应成功");
        let lnk = std::env::var("APPDATA")
            .map(std::path::PathBuf::from)
            .unwrap()
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join(AUMID_SHORTCUT_NAME);
        assert!(lnk.exists(), "快捷方式应已生成:{}", lnk.display());
        std::fs::remove_file(&lnk).expect("测试清理应成功");
    }

    /// 人工确认测试:与 tauri-plugin-notification 同一后端(tauri-winrt-notification),
    /// 同一 AUMID,发一条真实弹窗 —— 需要人眼确认横幅是否显示(后端对「静默丢弃」
    /// 与「真实显示」都返回 Ok,机器无法区分,这正是本次 bug 的根源)。
    /// 会在屏幕弹真窗,默认忽略;手动跑:cargo test toast_user_visible_confirmation -- --ignored
    #[test]
    #[cfg(windows)]
    #[ignore]
    fn toast_user_visible_confirmation() {
        ensure_aumid_shortcut("com.zklmiao.prompt-vault").expect("AUMID 快捷方式创建应成功");
        use tauri_winrt_notification::Toast;
        Toast::new("com.zklmiao.prompt-vault")
            .title("Prompt Vault 通知测试")
            .text1("如果你看到这条弹窗,Windows 通知链路已打通")
            .show()
            .expect("toast show 应成功");
    }

    /// 测试 zip 构造器:条目为 (name, content);symlink 条目为 (name, target)
    fn make_zip(entries: &[(&str, &[u8])], symlinks: &[(&str, &str)]) -> Vec<u8> {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut w = zip::ZipWriter::new(cursor);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in entries {
            w.start_file(*name, opts).unwrap();
            w.write_all(content).unwrap();
        }
        for (name, target) in symlinks {
            w.add_symlink(*name, *target, opts).unwrap();
        }
        w.finish().unwrap().into_inner()
    }

    const GOOD_MANIFEST: &str = r#"{
        "id": "demo-hello",
        "name": "演示插件",
        "version": "1.0.0",
        "minAppVersion": "0.1.0",
        "type": "standard",
        "ui": "none",
        "permissions": ["net:example.com", "window:float"]
    }"#;

    /// 版本门向量夹具:token-monitor 形状的 manifest,可传任意 minAppVersion
    fn token_monitor_manifest(min_app_version: &str) -> String {
        format!(
            r#"{{ "id": "token-monitor", "name": "Coding 套餐用量监控", "version": "1.0.0", "minAppVersion": "{min_app_version}", "type": "standard", "ui": "window", "permissions": ["net:open.bigmodel.cn"] }}"#
        )
    }

    /* ---- 源 URL 推导与 ref 回退 ---- */

    #[test]
    fn source_raw_url_covers_four_platforms() {
        assert_eq!(
            source_raw_url("github", "pv", "plugins", None, "main").unwrap(),
            "https://raw.githubusercontent.com/pv/plugins/main/pv-plugins.json"
        );
        assert_eq!(
            source_raw_url("gitee", "pv", "plugins", None, "dev").unwrap(),
            "https://gitee.com/pv/plugins/raw/dev/pv-plugins.json"
        );
        assert_eq!(
            source_raw_url("gitlab", "pv", "plugins", None, "main").unwrap(),
            "https://gitlab.com/pv/plugins/-/raw/main/pv-plugins.json"
        );
        assert_eq!(
            source_raw_url("gitea", "pv", "plugins", Some("git.example.com:3000"), "main")
                .unwrap(),
            "https://git.example.com:3000/pv/plugins/raw/main/pv-plugins.json"
        );
        // 自建源跟随主页地址 scheme:http 前缀 → http raw URL
        assert_eq!(
            source_raw_url("gitea", "pv", "plugins", Some("http://192.168.1.5:8899"), "main")
                .unwrap(),
            "http://192.168.1.5:8899/pv/plugins/raw/main/pv-plugins.json"
        );
        // IPv6 方括号形式
        assert_eq!(
            source_raw_url("gitea", "pv", "plugins", Some("[240e:1:2::9]:8899"), "main")
                .unwrap(),
            "https://[240e:1:2::9]:8899/pv/plugins/raw/main/pv-plugins.json"
        );
        assert!(source_raw_url("gitea", "pv", "plugins", None, "main").is_err());
        assert!(source_raw_url("sourcehut", "pv", "plugins", None, "main").is_err());
    }

    #[test]
    fn refs_fallback_explicit_branch_wins() {
        assert_eq!(refs_to_try(Some("dev")), vec!["dev"]);
        assert_eq!(refs_to_try(Some("  dev  ")), vec!["dev"]);
        assert_eq!(refs_to_try(Some("   ")), vec!["main", "master"]);
        assert_eq!(refs_to_try(None), vec!["main", "master"]);
    }

    #[test]
    fn repo_segment_and_ref_validation() {
        assert!(validate_repo_segment("prompt-vault", "owner").is_ok());
        assert!(validate_repo_segment("a.b_c-1", "repo").is_ok());
        for bad in ["", "..", ".", "a/b", "a b", "中文", "a+b"] {
            assert!(
                validate_repo_segment(bad, "owner").is_err(),
                "「{bad}」应被拒绝"
            );
        }
        assert!(validate_git_ref("release/v1").is_ok());
        for bad in ["", "a b", "a#b", "a?b", "../x", "/abs", "%2e"] {
            assert!(validate_git_ref(bad).is_err(), "「{bad}」应被拒绝");
        }
        assert!(validate_gitea_host("git.example.com").is_ok());
        assert!(validate_gitea_host("git.example.com:3000").is_ok());
        assert!(validate_gitea_host("http://git.example.com").is_ok());
        assert!(validate_gitea_host("[240e:1:2::9]:8899").is_ok());
        assert!(validate_gitea_host("[240e:1:2::9]").is_ok());
        for bad in [
            "",
            "git.example.com/path",
            "user@git.example.com",
            "gi..t.example.com",
            "git.example.com:",
            "git.example.com:30a0",
            "[240e:1:2::9",
            "[fe80::1%25]:8899",
        ] {
            assert!(validate_gitea_host(bad).is_err(), "「{bad}」应被拒绝");
        }
    }

    /* ---- 清单防御式解析 ---- */

    fn manifest_json(plugins: &str) -> String {
        format!(r#"{{ "name": "测试源", "plugins": {plugins} }}"#)
    }

    #[test]
    fn manifest_parses_valid_entries_and_skips_bad_ones() {
        let raw = manifest_json(
            r#"[
            {
              "id": "demo-hello", "name": "演示插件", "desc": "d",
              "channels": {
                "release": { "version": "1.0.0", "url": "https://x/1.0.0.zip", "sha256": "AA11" },
                "beta": { "version": "1.1.0-beta.1", "url": "https://x/1.1.0.zip", "sha256": "bb22" }
              },
              "minAppVersion": "0.1.0",
              "permissions": ["net:example.com", 42, "window:float", ""]
            },
            { "id": "BAD_ID", "name": "坏 id", "channels": { "release": { "version": "1", "url": "https://x", "sha256": "x" } } },
            { "id": "no-channels", "name": "无通道" },
            { "name": "缺 id" },
            { "id": "empty-channel", "name": "空通道", "channels": { "release": { "version": "", "url": "https://x", "sha256": "x" } } },
            { "id": "ftp-url", "name": "非 http 通道", "channels": { "beta": { "version": "1", "url": "ftp://x/y.zip", "sha256": "x" } } }
        ]"#,
        );
        let manifest = parse_source_manifest(&raw).unwrap();
        assert_eq!(manifest.name, "测试源");
        assert_eq!(manifest.plugins.len(), 1, "只应保留完全合法的条目");
        let entry = &manifest.plugins[0];
        assert_eq!(entry.id, "demo-hello");
        assert_eq!(entry.release.as_ref().unwrap().version, "1.0.0");
        assert_eq!(entry.beta.as_ref().unwrap().version, "1.1.0-beta.1");
        assert_eq!(entry.release.as_ref().unwrap().sha256, "aa11", "sha 统一小写");
        // 非字符串与空串权限被过滤
        assert_eq!(entry.permissions, vec!["net:example.com", "window:float"]);
    }

    #[test]
    fn manifest_rejects_non_json_and_missing_plugins() {
        let err = parse_source_manifest("not json").unwrap_err();
        assert!(err.contains("JSON"), "整体非 JSON 应报可读错误:{err}");
        assert!(parse_source_manifest(r#"{"name": "x"}"#)
            .unwrap_err()
            .contains("plugins"));
    }

    /* ---- semver ---- */

    #[test]
    fn semver_spec_ordering_vector() {
        // semver.org §11 优先级示例(逐项升序)
        let ascending = [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
            "1.0.1",
            "1.1.0",
            "2.0.0",
        ];
        for pair in ascending.windows(2) {
            let a = parse_semver(pair[0]).unwrap_or_else(|| panic!("解析失败:{}", pair[0]));
            let b = parse_semver(pair[1]).unwrap_or_else(|| panic!("解析失败:{}", pair[1]));
            assert_eq!(
                compare_semver(&a, &b),
                std::cmp::Ordering::Less,
                "{} 应小于 {}",
                pair[0],
                pair[1]
            );
            assert_eq!(compare_semver(&b, &a), std::cmp::Ordering::Greater);
        }
        // 数字标识符 < 字母数字标识符;构建元数据不参与比较
        let num = parse_semver("1.0.0-2").unwrap();
        let text = parse_semver("1.0.0-alpha").unwrap();
        assert_eq!(compare_semver(&num, &text), std::cmp::Ordering::Less);
        let with_build = parse_semver("1.0.0+build.1").unwrap();
        let plain = parse_semver("1.0.0").unwrap();
        assert_eq!(compare_semver(&with_build, &plain), std::cmp::Ordering::Equal);
    }

    #[test]
    fn version_gate_current_app_behaviour() {
        // 开工卡关键事实:app 0.1.9-alpha.2,token-monitor 要求 0.2.0 → 拒绝
        assert!(!app_meets_min_version("0.2.0", "0.1.9-alpha.2"));
        assert!(app_meets_min_version("0.1.9-alpha.1", "0.1.9-alpha.2"));
        // 同核心版本:正式版 > pre-release
        assert!(!app_meets_min_version("0.1.9", "0.1.9-alpha.2"));
        assert!(app_meets_min_version("0.1.9-alpha.2", "0.1.9-alpha.2"));
        assert!(app_meets_min_version("0.2.0", "1.0.0"));
        // 无法解析的版本要求 → 保守拒绝
        assert!(!app_meets_min_version("latest", "0.1.9"));
        assert!(!app_meets_min_version("0.2", "0.1.9"));
    }

    /* ---- 包结构判定与 zip-slip ---- */

    #[test]
    fn layout_detects_root_and_nested_packages() {
        let root_zip = make_zip(
            &[("manifest.json", GOOD_MANIFEST.as_bytes()), ("main.js", b"//x")],
            &[],
        );
        assert_eq!(detect_package_layout(&entry_names(&mut zip::ZipArchive::new(std::io::Cursor::new(root_zip)).unwrap()).unwrap()).unwrap(), "");
        let nested_zip = make_zip(
            &[
                ("demo-hello/manifest.json", GOOD_MANIFEST.as_bytes()),
                ("demo-hello/main.js", b"//x"),
                ("demo-hello/assets/a.json", b"{}"),
            ],
            &[],
        );
        assert_eq!(
            detect_package_layout(&entry_names(&mut zip::ZipArchive::new(std::io::Cursor::new(nested_zip)).unwrap()).unwrap())
                .unwrap(),
            "demo-hello/"
        );
    }

    #[test]
    fn layout_rejects_broken_packages() {
        let cases: Vec<(String, Vec<u8>)> = vec![
            ("没有 manifest".into(), make_zip(&[("main.js", b"//x")], &[])),
            (
                "两个顶层目录".into(),
                make_zip(
                    &[
                        ("a/manifest.json", GOOD_MANIFEST.as_bytes()),
                        ("b/x.js", b"//x"),
                    ],
                    &[],
                ),
            ),
            (
                "根文件与目录混装".into(),
                make_zip(
                    &[
                        ("stray.txt", b"x"),
                        ("a/manifest.json", GOOD_MANIFEST.as_bytes()),
                    ],
                    &[],
                ),
            ),
            (
                "顶层目录缺 manifest".into(),
                make_zip(&[("a/main.js", b"//x")], &[]),
            ),
        ];
        for (label, bytes) in cases {
            let names =
                entry_names(&mut zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap())
                    .unwrap();
            assert!(detect_package_layout(&names).is_err(), "{label} 应被拒绝");
        }
    }

    #[test]
    fn safe_rel_path_rejects_traversal_and_absolute() {
        for bad in [
            "../evil.txt",
            "/abs.txt",
            "C:/abs.txt",
            "a/../../b.txt",
            "./x.txt",
            "..",
            "a\0b",
        ] {
            assert!(safe_rel_path(bad).is_none(), "「{bad}」应被拒绝");
        }
        for ok in ["main.js", "assets/a.json", "assets/deep/b.png"] {
            assert!(safe_rel_path(ok).is_some(), "「{ok}」应放行");
        }
    }

    #[test]
    fn extract_rejects_zip_slip_and_symlinks() {
        let root = temp_root("zip-slip");

        // 三类恶意条目:相对穿越 / 绝对路径 / 软链
        let traversal = make_zip(
            &[
                ("manifest.json", GOOD_MANIFEST.as_bytes()),
                ("../evil.txt", b"pwn"),
            ],
            &[],
        );
        assert!(
            extract_plugin_zip(&traversal, &root.0).is_err(),
            "「../」条目应被拒绝"
        );
        let absolute = make_zip(
            &[
                ("manifest.json", GOOD_MANIFEST.as_bytes()),
                ("/abs/evil.txt", b"pwn"),
            ],
            &[],
        );
        assert!(
            extract_plugin_zip(&absolute, &root.0).is_err(),
            "绝对路径条目应被拒绝"
        );
        let symlink = make_zip(
            &[("manifest.json", GOOD_MANIFEST.as_bytes())],
            &[("link", "/etc/passwd")],
        );
        let err = extract_plugin_zip(&symlink, &root.0).unwrap_err();
        assert!(err.contains("软链"), "软链条目应被拒绝:{err}");
        // 半成品不应落到根目录之外
        assert!(
            !root.0.join("evil.txt").exists(),
            "穿越目标不应被写出"
        );
    }

    /* ---- zip 炸弹加固:解压限额(单条目/累计/条目数,流式边读边计) ---- */

    /// 高压缩比 payload:全零字节 deflate 后极小,解压即膨胀
    fn zeros(len: usize) -> Vec<u8> {
        vec![0u8; len]
    }

    #[test]
    fn extract_rejects_single_entry_over_uncompressed_limit() {
        let root = temp_root("zip-bomb-entry");
        // 9MB 单条目(超 8MB 上限):压缩包本身很小,通过下载体积检查,
        // 解压侧必须按实际膨胀字节数拒绝
        let zip_bytes = make_zip(
            &[
                ("manifest.json", GOOD_MANIFEST.as_bytes()),
                ("assets/big.bin", &zeros(9 * 1024 * 1024)),
            ],
            &[],
        );
        assert!(
            zip_bytes.len() < MAX_PACKAGE_BYTES,
            "夹具压缩包应小于下载体积上限(否则夹具失去意义)"
        );
        let err = extract_plugin_zip(&zip_bytes, &root.0).unwrap_err();
        assert!(err.contains("单条目"), "应报单条目超限:{err}");
        assert!(err.contains("8MB"), "应报 8MB 限额:{err}");
    }

    #[test]
    fn extract_rejects_cumulative_over_uncompressed_limit() {
        let root = temp_root("zip-bomb-total");
        // 14 × 5MB = 70MB:每条目均低于单条目 8MB 上限,累计超 64MB 拒绝
        let chunk = zeros(5 * 1024 * 1024);
        let names: Vec<String> = (0..14).map(|i| format!("assets/part{i:02}.bin")).collect();
        let mut entries: Vec<(&str, &[u8])> = vec![("manifest.json", GOOD_MANIFEST.as_bytes())];
        for name in &names {
            entries.push((name.as_str(), &chunk));
        }
        let zip_bytes = make_zip(&entries, &[]);
        let err = extract_plugin_zip(&zip_bytes, &root.0).unwrap_err();
        assert!(err.contains("累计"), "应报累计超限:{err}");
        assert!(err.contains("64MB"), "应报 64MB 限额:{err}");
    }

    #[test]
    fn extract_rejects_entry_count_over_limit() {
        let root = temp_root("zip-bomb-count");
        // manifest + 513 个填充条目 = 514 > 512 上限;单条目体积极小,不触体积限额
        let names: Vec<String> = (0..513).map(|i| format!("assets/f{i:03}.txt")).collect();
        let mut entries: Vec<(&str, &[u8])> = vec![("manifest.json", GOOD_MANIFEST.as_bytes())];
        for name in &names {
            entries.push((name.as_str(), "x".as_bytes()));
        }
        let zip_bytes = make_zip(&entries, &[]);
        // temp_root 只构造路径;先建目录,便于断言「无任何文件写出」
        std::fs::create_dir_all(&root.0).unwrap();
        let err = extract_plugin_zip(&zip_bytes, &root.0).unwrap_err();
        assert!(err.contains("条目数"), "应报条目数超限:{err}");
        assert!(err.contains("512"), "应报 512 限额:{err}");
        // 计数超限在解压任何文件前拒绝,dest 内不应有内容
        let wrote: Vec<_> = std::fs::read_dir(&root.0).unwrap().collect();
        assert!(wrote.is_empty(), "条目数超限不应写出任何文件");
    }

    /* ---- 安装成功路径(双包结构)与失败路径 ---- */

    fn sha_of(bytes: &[u8]) -> String {
        sha256_hex(bytes)
    }

    #[test]
    fn install_success_root_layout_writes_store_and_entry() {
        let root = temp_root("install-root");
        let zip_bytes = make_zip(
            &[
                ("manifest.json", GOOD_MANIFEST.as_bytes()),
                ("main.js", b"pv.panel.register({});"),
                ("assets/a.json", b"{}"),
            ],
            &[],
        );
        let sha = sha_of(&zip_bytes);
        let outcome = install_from_bytes(
            &root, &zip_bytes, &sha, "release", "demo-hello", "1.0.0", "0.1.9-alpha.2", None,
        )
        .unwrap_or_else(|e| panic!("安装应成功:{e:?}"));

        // 版本目录与文件落盘
        let dir = root.store_dir("demo-hello").join("1.0.0");
        assert_eq!(std::fs::read_to_string(dir.join("main.js")).unwrap(), "pv.panel.register({});");
        assert!(dir.join("assets/a.json").is_file());
        // current 指针指向新版本
        assert_eq!(root.current_version("demo-hello").as_deref(), Some("1.0.0"));
        // 条目符合契约 B 字段;permissions 快照来自 zip 内 manifest
        let entry = &outcome.entry;
        assert_eq!(entry["version"], "1.0.0");
        assert_eq!(entry["channel"], "release");
        assert_eq!(entry["enabled"], true, "首次安装默认启用");
        assert_eq!(entry["sha256"], sha);
        assert_eq!(entry["error"], Value::Null);
        assert_eq!(
            entry["permissions"],
            json!(["net:example.com", "window:float"])
        );
        assert!(entry.get("installedAt").is_some_and(|v| v.is_string()));
    }

    #[test]
    fn install_success_nested_layout_flattens_top_dir() {
        let root = temp_root("install-nested");
        let zip_bytes = make_zip(
            &[
                ("demo-hello/manifest.json", GOOD_MANIFEST.as_bytes()),
                ("demo-hello/main.js", b"//demo"),
            ],
            &[],
        );
        let sha = sha_of(&zip_bytes);
        install_from_bytes(
            &root, &zip_bytes, &sha, "beta", "demo-hello", "1.0.0", "0.1.9-alpha.2", None,
        )
        .unwrap_or_else(|e| panic!("单顶层目录包应安装成功:{e:?}"));
        let dir = root.store_dir("demo-hello").join("1.0.0");
        assert_eq!(std::fs::read_to_string(dir.join("main.js")).unwrap(), "//demo");
        assert!(!dir.join("demo-hello").exists(), "顶层目录前缀应被剥掉");
    }

    #[test]
    fn install_rejects_sha_mismatch_before_writing() {
        let root = temp_root("install-sha");
        let zip_bytes = make_zip(&[("manifest.json", GOOD_MANIFEST.as_bytes())], &[]);
        let wrong_sha = "0".repeat(64);
        let err = install_from_bytes(
            &root, &zip_bytes, &wrong_sha, "release", "demo-hello", "1.0.0", "0.1.9-alpha.2",
            None,
        )
        .unwrap_err();
        assert!(matches!(err, InstallError::ShaMismatch(_)));
        assert!(
            !root.store_dir("demo-hello").exists(),
            "sha 不符不应产生任何落盘"
        );
    }

    #[test]
    fn install_rejects_id_version_mismatch() {
        let root = temp_root("install-mismatch");
        let zip_bytes = make_zip(&[("manifest.json", GOOD_MANIFEST.as_bytes())], &[]);
        let sha = sha_of(&zip_bytes);
        // id 不一致
        let err = install_from_bytes(
            &root, &zip_bytes, &sha, "release", "other-id", "1.0.0", "0.1.9-alpha.2", None,
        )
        .unwrap_err();
        assert!(matches!(err, InstallError::Other(ref m) if m.contains("不一致")));
        // version 不一致
        let err = install_from_bytes(
            &root, &zip_bytes, &sha, "release", "demo-hello", "2.0.0", "0.1.9-alpha.2", None,
        )
        .unwrap_err();
        assert!(matches!(err, InstallError::Other(ref m) if m.contains("不一致")));
        assert!(!root.store_dir("demo-hello").exists(), "校验不符不应落盘");
    }

    #[test]
    fn install_version_gate_app_version_vectors() {
        // 向量式版本门:显式传 app 版本,与环境 CARGO_PKG_VERSION 解耦
        // (升版 0.2.0-alpha 后判定反转的根因:semver 预发布 < 正式版)
        let install_with = |min: &str, app: &str, tag: &str| {
            let root = temp_root(tag);
            let manifest = token_monitor_manifest(min);
            let zip_bytes = make_zip(&[("manifest.json", manifest.as_bytes())], &[]);
            let result = install_from_bytes(
                &root,
                &zip_bytes,
                &sha_of(&zip_bytes),
                "release",
                "token-monitor",
                "1.0.0",
                app,
                None,
            );
            (root, result)
        };
        for (min, app, expect_ok, tag) in [
            // 卡面断言集
            ("0.2.0-alpha", "0.2.0-alpha", true, "gate-eq-pre"), // 本家未发布插件:同版本放行
            ("0.2.0", "0.2.0-alpha", false, "gate-pre-lt-stable"), // 预发布 < 正式版 → 拒
            ("0.1.9", "0.2.0-alpha", true, "gate-old-min"),      // 0.1.x 老要求放行
            ("0.1.0", "0.2.0-alpha", true, "gate-old-min2"),
            // 保留批次 1 既有覆盖:相等放行 / 更低 app 拒绝
            ("0.2.0", "0.2.0", true, "gate-eq-stable"),
            ("0.2.0", "0.1.9-alpha.2", false, "gate-legacy-reject"),
        ] {
            let (root, result) = install_with(min, app, tag);
            match (expect_ok, result) {
                (true, Ok(_)) => {
                    assert!(
                        root.store_dir("token-monitor").exists(),
                        "app={app} ≥ min={min} 应落盘安装"
                    );
                }
                (false, Err(InstallError::Other(msg))) => {
                    assert!(
                        msg.contains("应用版本过低"),
                        "app={app} < min={min} 应报版本门错误:{msg}"
                    );
                    assert!(!root.store_dir("token-monitor").exists(), "拒绝后不应落盘");
                }
                (expect, got) => panic!(
                    "向量 min={min} app={app} 判定不符:期望放行={expect},实际={got:?}"
                ),
            }
        }
    }

    #[test]
    fn update_switches_pointer_and_keeps_rollback_then_prunes() {
        let root = temp_root("install-update");
        let mk = |version: &str| {
            let manifest = format!(
                r#"{{ "id": "demo-hello", "name": "演示插件", "version": "{version}", "minAppVersion": "0.1.0", "type": "standard", "ui": "none", "permissions": [] }}"#
            );
            let name = format!("demo-hello/main.js");
            make_zip(&[("demo-hello/manifest.json", manifest.as_bytes()), (name.as_str(), b"//v")], &[])
        };

        let v1 = mk("1.0.0");
        install_from_bytes(
            &root, &v1, &sha_of(&v1), "release", "demo-hello", "1.0.0", "0.1.9-alpha.2", None,
        )
        .unwrap();
        // 更新到 2.0.0:current 切换,1.0.0 保留为回滚点
        let v2 = mk("2.0.0");
        let outcome = install_from_bytes(
            &root, &v2, &sha_of(&v2), "release", "demo-hello", "2.0.0", "0.1.9-alpha.2", Some(false),
        )
        .unwrap();
        assert_eq!(outcome.old_version.as_deref(), Some("1.0.0"));
        assert_eq!(root.current_version("demo-hello").as_deref(), Some("2.0.0"));
        assert!(root.store_dir("demo-hello").join("1.0.0").is_dir(), "回滚点保留");
        assert_eq!(outcome.entry["enabled"], false, "更新保留既有 enabled 状态");
        // 再次更新到 3.0.0:更旧的 1.0.0 被清理,保留 2.0.0 与 3.0.0
        let v3 = mk("3.0.0");
        install_from_bytes(
            &root, &v3, &sha_of(&v3), "release", "demo-hello", "3.0.0", "0.1.9-alpha.2", Some(false),
        )
        .unwrap();
        assert!(root.store_dir("demo-hello").join("2.0.0").is_dir());
        assert!(!root.store_dir("demo-hello").join("1.0.0").exists(), "更旧版本应被清理");
        // current 指针文件不是目录,不应被误删
        assert_eq!(root.current_version("demo-hello").as_deref(), Some("3.0.0"));
    }

    /* ---- 卸载与状态迁移 ---- */

    #[test]
    fn uninstall_removes_dirs_and_state_entry_idempotent() {
        let root = temp_root("uninstall");
        let zip_bytes = make_zip(
            &[("manifest.json", GOOD_MANIFEST.as_bytes()), ("main.js", b"//x")],
            &[],
        );
        install_from_bytes(
            &root, &zip_bytes, &sha_of(&zip_bytes), "release", "demo-hello", "1.0.0",
            "0.1.9-alpha.2", None,
        )
        .unwrap();
        // 模拟 KV 数据
        let kv_path = root.data_dir("demo-hello").join("kv.json");
        kv_write(&kv_path, "pos", json!({"x": 1})).unwrap();
        assert!(root.store_dir("demo-hello").is_dir());
        assert!(root.data_dir("demo-hello").is_dir());

        let mut state = json!({
            "version": 1,
            "installed": {
                "demo-hello": { "version": "1.0.0" },
                "other": { "version": "0.9.0" }
            }
        });
        assert!(remove_installed_entry(&mut state, "demo-hello"));
        assert!(state["installed"].get("other").is_some(), "其他条目不受影响");

        uninstall_artifacts(&root, "demo-hello");
        assert!(!root.store_dir("demo-hello").exists());
        assert!(!root.data_dir("demo-hello").exists());
        // 幂等:重复清理与重复移除均安全
        uninstall_artifacts(&root, "demo-hello");
        assert!(!remove_installed_entry(&mut state, "demo-hello"));
    }

    #[test]
    fn set_installed_entry_requires_object_shapes() {
        let mut state = json!({ "version": 1, "installed": {} });
        let entry = json!({ "version": "1.0.0", "channel": "release" });
        assert!(set_installed_entry(&mut state, "demo-hello", entry));
        assert_eq!(state["installed"]["demo-hello"]["version"], "1.0.0");
        // installed 缺失/非对象时拒绝写入(命令层会先报错)
        let mut bad = json!({ "version": 1 });
        assert!(!set_installed_entry(&mut bad, "demo-hello", json!({})));
        let mut arr = json!([]);
        assert!(!set_installed_entry(&mut arr, "demo-hello", json!({})));
    }

    /* ---- 沙箱 KV ---- */

    #[test]
    fn kv_roundtrip_and_overwrite() {
        let dir = std::env::temp_dir().join(format!("pv-kv-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("kv.json");
        assert_eq!(kv_read(&path, "pos").unwrap(), None, "未写入时读取为空");
        kv_write(&path, "pos", json!({"x": 10, "y": 20})).unwrap();
        assert_eq!(kv_read(&path, "pos").unwrap(), Some(json!({"x": 10, "y": 20})));
        kv_write(&path, "pos", json!({"x": 30, "y": 40})).unwrap();
        kv_write(&path, "theme", json!("dark")).unwrap();
        assert_eq!(kv_read(&path, "pos").unwrap(), Some(json!({"x": 30, "y": 40})));
        assert_eq!(kv_read(&path, "theme").unwrap(), Some(json!("dark")));
        assert_eq!(kv_read(&path, "missing").unwrap(), None);
    }

    #[test]
    fn kv_rejects_bad_key_and_oversized_value() {
        let dir = std::env::temp_dir().join(format!("pv-kv-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("kv.json");
        assert!(kv_write(&path, "", json!("v")).is_err());
        assert!(kv_write(&path, &"k".repeat(129), json!("v")).is_err());
        assert!(kv_read(&path, "").is_err());
        let big = "x".repeat(64 * 1024 + 1);
        assert!(kv_write(&path, "big", json!(big)).is_err(), "超限值应被拒绝");
        assert!(!path.exists(), "被拒绝的写入不应产生文件");
    }

    /// kv key 无字符集限制(仅非空 + ≤128 字节):多账号 cache 键含中文 label
    /// (`cache:<provider>:<label>`)必须可存可读(开工卡 §A.5)
    #[test]
    fn kv_key_accepts_multibyte_labels() {
        let dir = std::env::temp_dir().join(format!("pv-kv-utf8-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("kv.json");
        let key = "cache:glm:主号";
        assert!(key.len() <= 128, "中文 label 的 cache 键应在上限内");
        kv_write(&path, key, json!({"fiveHour": {"percent": 12.5}})).unwrap();
        assert_eq!(
            kv_read(&path, key).unwrap(),
            Some(json!({"fiveHour": {"percent": 12.5}}))
        );
        // 账号清单键同样可存(数组值)
        kv_write(&path, "tm.accounts", json!([{"provider": "glm", "label": "主号"}])).unwrap();
        assert_eq!(
            kv_read(&path, "tm.accounts").unwrap(),
            Some(json!([{"provider": "glm", "label": "主号"}]))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Moved 位置落盘(Moved 防抖事件链本身人工验):persist_window_position
    /// 应把物理像素坐标写进该插件 kv.json 的 window:x / window:y,且不破坏既有键
    #[test]
    fn persist_window_position_writes_kv_xy() {
        let dir = std::env::temp_dir().join(format!("pv-pos-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = PluginRoot(dir.clone());
        // 先写一个插件自有键,验证位置键追加不覆盖
        kv_write(&root.data_dir("token-monitor").join("kv.json"), "ball.provider", json!("glm")).unwrap();
        persist_window_position(&root, "token-monitor", 1234, -567).unwrap();
        let path = root.data_dir("token-monitor").join("kv.json");
        assert_eq!(kv_read(&path, "window:x").unwrap(), Some(json!(1234)));
        assert_eq!(kv_read(&path, "window:y").unwrap(), Some(json!(-567)));
        assert_eq!(kv_read(&path, "ball.provider").unwrap(), Some(json!("glm")));
        // 二次落盘覆盖旧值
        persist_window_position(&root, "token-monitor", 200, 300).unwrap();
        assert_eq!(kv_read(&path, "window:x").unwrap(), Some(json!(200)));
        // 非法 id 拒绝
        assert!(persist_window_position(&root, "Bad_Id", 1, 1).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn plugin_id_validation_guards_path_traversal() {
        for bad in [
            "",
            "../etc",
            "a/b",
            "..",
            "A",
            "a_b",
            "a b",
            "-lead",
            "trail-",
            "中",
            &"a".repeat(65),
        ] {
            assert!(ensure_plugin_id(bad).is_err(), "「{bad}」应被拒绝");
        }
        for ok in ["a", "demo-hello", "token-monitor", "a1-b2-c3"] {
            assert!(ensure_plugin_id(ok).is_ok(), "「{ok}」应放行");
        }
    }

    /* ---- 包内文件读取(plugin_read_entry,pv-1 内联注入通道) ---- */

    /// 预置一个已安装插件:main.js + assets/a.json,返回临时根目录
    fn setup_installed(root: &PluginRoot) {
        let zip_bytes = make_zip(
            &[
                ("manifest.json", GOOD_MANIFEST.as_bytes()),
                ("main.js", b"pv.panel.register({});"),
                ("assets/a.json", b"{}"),
            ],
            &[],
        );
        install_from_bytes(
            root,
            &zip_bytes,
            &sha_of(&zip_bytes),
            "release",
            "demo-hello",
            "1.0.0",
            "0.1.9-alpha.2",
            None,
        )
        .unwrap();
    }

    #[test]
    fn read_entry_reads_files_from_current_version() {
        let root = temp_root("read-entry-ok");
        setup_installed(&root);
        assert_eq!(
            read_entry(&root, "demo-hello", "main.js").unwrap(),
            Some("pv.panel.register({});".to_string())
        );
        assert_eq!(
            read_entry(&root, "demo-hello", "assets/a.json").unwrap(),
            Some("{}".to_string())
        );
    }

    #[test]
    fn read_entry_rejects_traversal_and_bad_paths() {
        let root = temp_root("read-entry-traversal");
        setup_installed(&root);
        for bad in ["../evil.txt", "/abs.txt", "C:/x.txt", "a\0b", ".."] {
            let err = read_entry(&root, "demo-hello", bad).unwrap_err();
            assert!(err.contains("不合法"), "「{bad}」应报路径不合法:{err}");
        }
        // 穿越 payload 即使被拒绝也不应落到 store 之外
        assert!(!root.0.join("evil.txt").exists());
    }

    #[test]
    fn read_entry_missing_returns_none() {
        let root = temp_root("read-entry-missing");
        // 未安装的插件:None
        assert_eq!(read_entry(&root, "demo-hello", "main.js").unwrap(), None);
        // 已安装但文件缺失:None(语言包缺 <码>.json 时由调用方跳过)
        setup_installed(&root);
        assert_eq!(read_entry(&root, "demo-hello", "assets/missing.json").unwrap(), None);
        assert_eq!(read_entry(&root, "no-such", "main.js").unwrap(), None);
        // 非法 id:Err(不静默)
        assert!(read_entry(&root, "../evil", "main.js").is_err());
    }

    #[test]
    fn read_entry_rejects_oversized_file() {
        let root = temp_root("read-entry-oversize");
        setup_installed(&root);
        let big_path = root.store_dir("demo-hello").join("1.0.0").join("big.js");
        let mut f = std::fs::File::create(&big_path).unwrap();
        for _ in 0..(MAX_ENTRY_BYTES / 4096 + 1) {
            f.write_all(&[b'x'; 4096]).unwrap();
        }
        drop(f);
        let err = read_entry(&root, "demo-hello", "big.js").unwrap_err();
        assert!(err.contains("过大"), "超限应报可读错误:{err}");
    }

    #[test]
    fn read_entry_rejects_invalid_utf8() {
        let root = temp_root("read-entry-utf8");
        setup_installed(&root);
        let path = root
            .store_dir("demo-hello")
            .join("1.0.0")
            .join("binary.js");
        std::fs::write(&path, [0xC0, 0xC1, 0xF5, 0xFF, 0xFE]).unwrap();
        let err = read_entry(&root, "demo-hello", "binary.js").unwrap_err();
        assert!(err.contains("UTF-8"), "非法 UTF-8 应报可读错误:{err}");
    }

    /* ---- 调用者校验 helper(P0 跨窗口加固) ---- */

    #[test]
    fn caller_main_allows_only_exact_main_label() {
        assert!(ensure_caller_main("main").is_ok(), "主窗放行");
        // 大小写与空白边界:逐字比较
        for bad in ["Main", "MAIN", "main ", " main", "quickpick", "pv-plugin-demo-hello", ""] {
            assert!(ensure_caller_main(bad).is_err(), "「{bad}」应被拒绝");
        }
        // 拒绝消息可读
        let err = ensure_caller_main("pv-plugin-demo-hello").unwrap_err();
        assert!(err.contains("仅限主窗口调用"), "拒绝消息应可读:{err}");
    }

    #[test]
    fn caller_self_or_main_three_states() {
        // ① main 放行
        assert!(ensure_caller_self_or_main("main", "demo-hello").is_ok());
        // ② 自身窗口放行(label 与 plugin_id 逐字拼合匹配)
        assert!(ensure_caller_self_or_main("pv-plugin-demo-hello", "demo-hello").is_ok());
        // ③ 他人插件窗口拒绝
        assert!(ensure_caller_self_or_main("pv-plugin-other", "demo-hello").is_err());
        assert!(ensure_caller_self_or_main("pv-plugin-demo-hello", "other").is_err());
        assert!(ensure_caller_self_or_main("quickpick", "demo-hello").is_err());
        assert!(ensure_caller_self_or_main("", "demo-hello").is_err());
        // 拒绝消息可读
        let err = ensure_caller_self_or_main("pv-plugin-other", "demo-hello").unwrap_err();
        assert!(err.contains("只能操作自身"), "拒绝消息应可读:{err}");
    }

    #[test]
    fn caller_self_prefix_and_case_boundaries() {
        // 前缀形近但不等长:pv-plugin-demo 是「demo」窗口与「demo-hello」不匹配
        assert!(ensure_caller_self_or_main("pv-plugin-demo", "demo-hello").is_err());
        // 非前缀匹配:调用者 label 多一层后缀不等于目标 id
        assert!(ensure_caller_self_or_main("pv-plugin-demo-hello-extra", "demo-hello").is_err());
        // 大小写敏感:大写变体一律拒绝
        assert!(ensure_caller_self_or_main("PV-PLUGIN-demo-hello", "demo-hello").is_err());
        assert!(ensure_caller_self_or_main("pv-Plugin-demo-hello", "demo-hello").is_err());
        // 无 plugin_id 参数命令的退化形:调用者 label 剥前缀得到自身 id 恒匹配
        let label = "pv-plugin-token-monitor";
        let self_id = label.strip_prefix(PLUGIN_WINDOW_PREFIX).unwrap_or("");
        assert!(ensure_caller_self_or_main(label, self_id).is_ok(), "退化形:插件窗口查自身");
        // 非 main 非插件窗口(quickpick)剥前缀失败 → 空 id → 拒绝
        let qp = "quickpick";
        let qp_id = qp.strip_prefix(PLUGIN_WINDOW_PREFIX).unwrap_or("");
        assert!(ensure_caller_self_or_main(qp, qp_id).is_err(), "退化形:非插件窗口拒绝");
    }

    /* ---- 通知通道(caller 三态 + 友好截断) ---- */

    #[test]
    fn caller_plugin_window_three_states() {
        // ① 插件窗口放行:剥前缀得 plugin_id
        assert_eq!(
            ensure_caller_plugin_window("pv-plugin-token-monitor").unwrap(),
            "token-monitor",
            "插件窗口应放行且 id 剥前缀无歧义"
        );
        // ② main 拒绝:通知是插件专属通道,宿主不发「插件通知」
        assert!(ensure_caller_plugin_window(crate::MAIN_LABEL).is_err(), "main 不放行");
        // ③ 其他窗口一律拒绝(quickpick / 空串 / 前缀形近 / 大小写变体 / 裸前缀)
        for bad in ["quickpick", "", "pv-plugin-", "pv-plugin", "pv-Plugin-token-monitor"] {
            assert!(ensure_caller_plugin_window(bad).is_err(), "「{bad}」应被拒绝");
        }
        // 拒绝消息可读
        let err = ensure_caller_plugin_window("main").unwrap_err();
        assert!(err.contains("仅限插件窗口调用"), "拒绝消息应可读:{err}");
    }

    #[test]
    fn truncate_chars_boundary_and_multibyte() {
        // 恰等于上限:原样返回
        let s100 = "a".repeat(100);
        assert_eq!(truncate_chars(&s100, 100), s100);
        // 超限一个字符:截到上限
        let s101 = "a".repeat(101);
        assert_eq!(truncate_chars(&s101, 100).chars().count(), 100);
        // 多字节按 char 计:30 个汉字截到 20,不切出非法 UTF-8
        let cn: String = "警".repeat(30);
        assert_eq!(truncate_chars(&cn, 20), "警".repeat(20));
        // 正文上限 300 同理
        let s300 = "b".repeat(300);
        assert_eq!(truncate_chars(&s300, 300), s300);
        assert_eq!(truncate_chars(&"b".repeat(301), 300).chars().count(), 300);
        // 空串无害
        assert_eq!(truncate_chars("", 100), "");
    }

    /* ---- 契约样例(三方共用,写端断言) ---- */

    #[test]
    fn contract_sample_matches_write_side_schema() {
        // 写端 serde 校验通过(字段齐全、类型正确)
        validate_plugins_state(contract_sample::PLUGINS_JSON)
            .unwrap_or_else(|e| panic!("契约样例应通过写端校验:{e}"));
        // 结构断言:与契约 B 逐字段对照
        let v: Value = serde_json::from_str(contract_sample::PLUGINS_JSON).unwrap();
        assert_eq!(v["version"], 1);
        assert_eq!(v["activeSourceId"], "official");
        let source = &v["sources"][0];
        assert_eq!(source["id"], "official");
        assert_eq!(source["provider"], "github");
        assert_eq!(source["url"], "https://github.com/prompt-vault/plugins");
        assert_eq!(source["branch"], Value::Null);
        let entry = &v["installed"]["token-monitor"];
        assert_eq!(entry["version"], "1.0.0");
        assert_eq!(entry["channel"], "release");
        assert_eq!(entry["enabled"], true);
        assert_eq!(entry["error"], Value::Null);
        assert_eq!(entry["permissions"].as_array().unwrap().len(), 5);
        assert_eq!(v["mcp"]["enabled"], false);
        // 缺 error 字段(契约必填)应被写端校验拒绝
        let missing_error = r#"{"version":1,"sources":[],"activeSourceId":null,"installed":{"x":{"version":"1","channel":"release","enabled":true,"sha256":"s","installedAt":"t"}},"mcp":{"enabled":false}}"#;
        assert!(validate_plugins_state(missing_error).is_err());
    }
}
