//! 插件网络代理:插件联网请求的唯一出口(pv.net.fetch 的 Rust 侧)。
//!
//! 安全链路(顺序固定,任一步失败即拒绝):
//! ① URL 解析(scheme 仅 http/https)→ ② host 白名单(`plugins.json` 的
//! `installed[<plugin_id>].permissions` 快照中的 `net:<精确host>`,大小写不敏感)
//! → ③ authFrom 声明检查(`credential:<scope>` 须在 permissions 中)→ ④ SSRF 校验
//! (DNS 解析全部 A/AAAA 记录逐一拒绝环回/私网/链路本地/未指定/保留/组播地址)
//! → ⑤ 认证注入(Rust 内完成,凭据只来自环境变量或凭据管理器,Key 明文不出 Rust 进程)
//! → ⑥ ureq 请求(整体超时 15s,不跟随重定向)→ ⑦ 返回 status + body(截断上限 1MB)。

use std::collections::BTreeMap;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
use std::path::PathBuf;
use std::time::Duration;

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use url::{Host, Url};

use crate::credentials::{KeyringBackend, SystemKeyring, scope_valid};

type HmacSha256 = Hmac<Sha256>;

const REQUEST_TIMEOUT_SECS: u64 = 15;
const MAX_BODY_BYTES: usize = 1_048_576;
const MAX_HEADERS: usize = 32;
const MAX_HEADER_VALUE_LEN: usize = 4096;
const SSRF_REJECT_MSG: &str = "目标地址被 SSRF 防护拒绝:私网、环回或保留地址";
const PERM_NET_MSG: &str = "插件未声明该网络权限";
const PERM_CRED_MSG: &str = "插件未声明该凭据权限";
/// 火山 V4 签名固定参数(规格:service "ark"、region "cn-beijing")
const VOLC_REGION: &str = "cn-beijing";
const VOLC_SERVICE: &str = "ark";

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetFetchOpts {
    /// "credential:<scope>",scope 必须在插件 permissions 快照中声明
    auth_from: Option<String>,
    /// raw = Authorization: <key>;bearer = Authorization: Bearer <key>;
    /// volcengine = 火山 V4 HMAC-SHA256 签名(Rust 内完成)
    mode: Option<String>,
    method: Option<String>,
    body: Option<String>,
    headers: Option<BTreeMap<String, String>>,
}

#[derive(serde::Serialize)]
pub struct NetResponse {
    pub status: u16,
    pub body: String,
}

// ---------- URL 与 scheme 白名单 ----------

/// URL 解析 + scheme 白名单;解析结果供后续白名单/SSRF/签名步骤复用
fn validate_url(input: &str) -> Result<Url, String> {
    let parsed = Url::parse(input).map_err(|_| "URL 无法解析".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("仅允许 http/https 请求".to_string());
    }
    if parsed.host_str().is_none() {
        return Err("URL 缺少主机名".to_string());
    }
    Ok(parsed)
}

// ---------- host 白名单 ----------

/// 插件数据目录下的 plugins.json(与 lib.rs 的 config.json 同目录)
fn plugins_file_path() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .or_else(|_| {
            std::env::var("USERPROFILE")
                .map(|h| PathBuf::from(h).join("AppData").join("Roaming"))
        })
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("prompt-vault").join("plugins.json")
}

/// 防御式解析 plugins.json,取 `installed[<plugin_id>]` 安装时快照的 permissions 数组。
/// 文件缺失 / 解析失败 / 条目缺失 / permissions 缺失,一律按「插件未声明该网络权限」
/// 处理(白名单收紧语义,缺数据时宁可拒绝)。
fn extract_permissions(raw: &str, plugin_id: &str) -> Result<Vec<String>, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|_| PERM_NET_MSG.to_string())?;
    value
        .get("installed")
        .and_then(|v| v.get(plugin_id))
        .and_then(|v| v.get("permissions"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| p.as_str().map(|s| s.to_string()))
                .collect()
        })
        .ok_or_else(|| PERM_NET_MSG.to_string())
}

fn load_permissions(plugin_id: &str) -> Result<Vec<String>, String> {
    let raw = std::fs::read_to_string(plugins_file_path())
        .map_err(|_| PERM_NET_MSG.to_string())?;
    extract_permissions(&raw, plugin_id)
}

/// `net:<host>` 权限串精确比对 host(大小写不敏感,子域名不算匹配)
fn host_allowed(permissions: &[String], host: &str) -> bool {
    let host = host.to_lowercase();
    permissions
        .iter()
        .filter_map(|p| p.strip_prefix("net:"))
        .any(|h| h.trim().to_lowercase() == host)
}

/// `credential:<scope>` 权限声明检查
fn credential_allowed(permissions: &[String], scope: &str) -> bool {
    permissions
        .iter()
        .any(|p| p.trim() == format!("credential:{scope}"))
}

// ---------- SSRF 防护 ----------

/// IPv4:环回、私网(10/8、172.16/12、192.168/16)、链路本地 169.254/16、
/// 未指定与保留(0/8)、保留(240/4,含广播)、组播(224/4)一律拒绝
fn is_forbidden_v4(ip: Ipv4Addr) -> bool {
    let first = ip.octets()[0];
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || first == 0
        || first >= 240
        || (224..=239).contains(&first)
}

/// IPv6:环回 ::1、未指定 ::、唯一本地 fc00::/7、链路本地 fe80::/10 拒绝;
/// IPv4-mapped 地址(::ffff:a.b.c.d)按内嵌 IPv4 规则判定,防止借道绕过
fn is_forbidden_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_forbidden_v4(v4);
    }
    ip.is_loopback() || ip.is_unspecified() || ip.is_unique_local() || ip.is_unicast_link_local()
}

pub(crate) fn is_forbidden_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_forbidden_v4(*v4),
        IpAddr::V6(v6) => is_forbidden_v6(*v6),
    }
}

/// SSRF 校验:IP 字面量直接判定;域名解析后全部 A/AAAA 记录逐一判定,
/// 任何一条命中即整体拒绝(必须全放行才放行)
fn assert_public_target(url: &Url) -> Result<(), String> {
    match url.host() {
        None => Err("URL 缺少主机名".to_string()),
        Some(Host::Ipv4(ip)) if is_forbidden_v4(ip) => Err(SSRF_REJECT_MSG.to_string()),
        Some(Host::Ipv6(ip)) if is_forbidden_v6(ip) => Err(SSRF_REJECT_MSG.to_string()),
        Some(Host::Ipv4(_) | Host::Ipv6(_)) => Ok(()),
        Some(Host::Domain(domain)) => {
            let port = url.port_or_known_default().unwrap_or(80);
            let addrs = (domain, port)
                .to_socket_addrs()
                .map_err(|_| format!("域名解析失败:{domain}"))?;
            let mut checked = 0;
            for addr in addrs {
                checked += 1;
                if is_forbidden_ip(&addr.ip()) {
                    return Err(SSRF_REJECT_MSG.to_string());
                }
            }
            if checked == 0 {
                Err(format!("域名解析失败:{domain}"))
            } else {
                Ok(())
            }
        }
    }
}

// ---------- 请求头与方法 ----------

/// 认证模式下受 Rust 保护的头,不允许插件自带值覆写(注入值优先)
const PROTECTED_HEADERS: [&str; 2] = ["authorization", "x-date"];

/// RFC 7230 token 字符(头名合法字符)
fn is_header_token_char(b: u8) -> bool {
    matches!(
        b,
        b'!' | b'#' | b'$' | b'%' | b'&' | b'\'' | b'*' | b'+' | b'-' | b'.' | b'^' | b'_'
            | b'`' | b'|' | b'~' | b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z'
    )
}

/// 防头注入:头名限 token 字符,头值禁 CR/LF/NUL
fn validate_header(name: &str, value: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 128 || !name.bytes().all(is_header_token_char) {
        return Err(format!("非法请求头名:{name}"));
    }
    if value.len() > MAX_HEADER_VALUE_LEN
        || value.chars().any(|c| c == '\r' || c == '\n' || c == '\0')
    {
        return Err("请求头值包含非法字符或过长".to_string());
    }
    Ok(())
}

/// 方法白名单:CONNECT/TRACE 等易被滥用作代理隧道的方法不在其列
fn normalize_method(method: &str) -> Result<&'static str, String> {
    match method.trim().to_uppercase().as_str() {
        "GET" => Ok("GET"),
        "POST" => Ok("POST"),
        "PUT" => Ok("PUT"),
        "DELETE" => Ok("DELETE"),
        "HEAD" => Ok("HEAD"),
        "PATCH" => Ok("PATCH"),
        other => Err(format!("不支持的请求方法:{other}")),
    }
}

/// 合并 opts.headers:校验合法性与数量;认证模式下剔除受保护头
fn merge_request_headers(
    headers: Option<&BTreeMap<String, String>>,
    auth_mode: Option<&str>,
) -> Result<Vec<(String, String)>, String> {
    let map = match headers {
        Some(m) => m,
        None => return Ok(Vec::new()),
    };
    if map.len() > MAX_HEADERS {
        return Err("请求头数量过多".to_string());
    }
    let mut out = Vec::with_capacity(map.len());
    for (name, value) in map {
        validate_header(name, value)?;
        if auth_mode.is_some() && PROTECTED_HEADERS.iter().any(|h| h.eq_ignore_ascii_case(name)) {
            continue;
        }
        out.push((name.clone(), value.clone()));
    }
    Ok(out)
}

// ---------- 火山方舟 V4 签名 ----------

fn hmac_sha256(key: &[u8], msg: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC-SHA256 接受任意长度密钥");
    mac.update(msg);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    hex_encode(&digest)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// 火山 V4 签名的 URI 编码:仅保留 RFC 3986 非保留字符 A-Za-z0-9-_.~,其余逐字节 %XX
fn volc_uri_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 规范化查询串:query_pairs 的解码键值对按火山规则重新编码,按键字节序排序
fn volc_canonical_query(url: &Url) -> String {
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .into_owned()
        .map(|(k, v)| (volc_uri_encode(&k), volc_uri_encode(&v)))
        .collect();
    pairs.sort();
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// epoch 秒 → UTC `yyyymmdd'T'hhmmss'Z'`(火山 X-Date 格式)。
/// 公历换算与 lib.rs 的 iso_from_epoch_secs 同源(Hinnant civil_from_days)。
fn xdate_from_epoch_secs(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hh, mm, ss) = (rem / 3_600, (rem % 3_600) / 60, rem % 60);
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}{m:02}{d:02}T{hh:02}{mm:02}{ss:02}Z")
}

fn now_xdate() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    xdate_from_epoch_secs(secs)
}

/// 火山方舟 V4 HMAC-SHA256 签名链(service=ark、region=cn-beijing、签名头 host;x-date、
/// 空载荷哈希)。返回 (X-Date, Authorization) 两个头的值。
/// xdate 由调用方传入以便单测固定向量;单测期望值由 node crypto 独立计算(见测试注释)。
fn volcengine_sign(
    ak: &str,
    sk: &str,
    method: &str,
    url: &Url,
    xdate: &str,
) -> Result<(String, String), String> {
    let host = url.host_str().ok_or("URL 缺少主机名")?.to_lowercase();
    let canonical_query = volc_canonical_query(url);
    // 规范化请求:方法 \n 路径 \n 查询 \n 规范化头(每行尾随 \n,再补一个空行)
    // \n 签名头列表 \n 载荷哈希(GET 无 body,取空串 SHA-256)
    let canonical_request = format!(
        "{}\n{}\n{}\nhost:{}\nx-date:{}\n\nhost;x-date\n{}",
        method.to_uppercase(),
        url.path(),
        canonical_query,
        host,
        xdate,
        sha256_hex(b"")
    );
    let date = xdate.get(..8).ok_or("X-Date 格式不正确")?;
    let scope = format!("{date}/{VOLC_REGION}/{VOLC_SERVICE}/request");
    let string_to_sign = format!(
        "HMAC-SHA256\n{xdate}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );
    // 派生密钥链:kDate → kRegion → kService → kSigning("request")
    let k_date = hmac_sha256(sk.as_bytes(), date.as_bytes());
    let k_region = hmac_sha256(&k_date, VOLC_REGION.as_bytes());
    let k_service = hmac_sha256(&k_region, VOLC_SERVICE.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"request");
    let signature = hex_encode(&hmac_sha256(&k_signing, string_to_sign.as_bytes()));
    let authorization = format!(
        "HMAC-SHA256 Credential={ak}/{scope}, SignedHeaders=host;x-date, Signature={signature}"
    );
    Ok((xdate.to_string(), authorization))
}

// ---------- 凭据解析 ----------

/// 凭据解析结果:单值 Key(GLM/OpenCode)或火山 AK/SK 双值
enum AuthSecret {
    Single(String),
    AkSk(String, String),
}

/// scope → 单值 Key 的环境变量名:`PROMPT_VAULT_<SCOPE 大写、- 转 _>_KEY`
fn single_key_env_name(scope: &str) -> String {
    format!("PROMPT_VAULT_{}_KEY", scope.to_uppercase().replace('-', "_"))
}

/// 凭据只从环境变量或凭据管理器读取,环境变量优先;空串凭据一律视为未设置
/// (统一在本函数过滤,不依赖调用方);getenv 注入以便单测隔离真实环境。
fn load_credential(
    store: &dyn KeyringBackend,
    scope: &str,
    getenv: &dyn Fn(&str) -> Option<String>,
) -> Result<AuthSecret, String> {
    if !scope_valid(scope) {
        return Err("凭据 scope 不合法".to_string());
    }
    let not_empty = |s: &String| !s.is_empty();
    if scope == "volcengine" {
        // 命名例外:火山 AK/SK 双值环境变量
        let ak = getenv("PROMPT_VAULT_VOLCENGINE_AK").filter(not_empty);
        let sk = getenv("PROMPT_VAULT_VOLCENGINE_SK").filter(not_empty);
        return match (ak, sk) {
            (Some(ak), Some(sk)) => Ok(AuthSecret::AkSk(ak, sk)),
            (Some(_), None) | (None, Some(_)) => Err(
                "环境变量 PROMPT_VAULT_VOLCENGINE_AK 与 PROMPT_VAULT_VOLCENGINE_SK 需同时设置"
                    .to_string(),
            ),
            (None, None) => match store.get("volcengine")?.filter(not_empty) {
                // 凭据管理器条目约定:secret 为 "AK\nSK" 两行编码(写入侧见 credentials.rs)
                Some(secret) => {
                    let mut parts = secret.splitn(2, '\n');
                    match (parts.next(), parts.next()) {
                        (Some(ak), Some(sk)) if !ak.is_empty() && !sk.is_empty() => {
                            Ok(AuthSecret::AkSk(ak.to_string(), sk.to_string()))
                        }
                        _ => Err("volcengine 凭据格式不正确:应为 AK/SK 双值(以换行分隔)".to_string()),
                    }
                }
                None => Err(
                    "未找到 volcengine 凭据:请先在设置中录入 AK/SK,或设置环境变量".to_string(),
                ),
            },
        };
    }
    let env_name = single_key_env_name(scope);
    if let Some(key) = getenv(&env_name).filter(not_empty) {
        return Ok(AuthSecret::Single(key));
    }
    match store.get(scope)?.filter(not_empty) {
        Some(secret) => Ok(AuthSecret::Single(secret)),
        None => Err(format!(
            "未找到 {scope} 凭据:请先在设置中录入,或设置环境变量 {env_name}"
        )),
    }
}

/// 运行时环境变量读取;空串视为未设置
fn real_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|s| !s.is_empty())
}

// ---------- 命令 ----------

/// 插件网络代理命令。返回 HTTP status 与响应体(任何状态码都算成功返回);
/// 仅安全校验失败或传输层错误时返回 Err。
#[tauri::command]
pub fn plugin_net_fetch(
    plugin_id: String,
    url: String,
    opts: Option<NetFetchOpts>,
) -> Result<NetResponse, String> {
    let opts = opts.unwrap_or_default();
    let parsed = validate_url(&url)?;

    // ② host 白名单(安装时快照在 plugins.json 的 permissions)
    let permissions = load_permissions(&plugin_id)?;
    let host = parsed.host_str().ok_or("URL 缺少主机名")?;
    if !host_allowed(&permissions, host) {
        return Err(PERM_NET_MSG.to_string());
    }

    // ③ authFrom / mode 成对出现,scope 必须在 permissions 中声明
    let auth_from = opts.auth_from.as_deref();
    let mode = opts.mode.as_deref();
    if mode.is_some() != auth_from.is_some() {
        return Err("authFrom 与 mode 必须同时提供".to_string());
    }
    let scope = auth_from
        .map(|v| {
            v.strip_prefix("credential:")
                .map(|s| s.trim().to_string())
                .ok_or_else(|| "authFrom 仅支持 credential:<scope> 形式".to_string())
        })
        .transpose()?
        .unwrap_or_default();
    if auth_from.is_some() && !credential_allowed(&permissions, &scope) {
        return Err(PERM_CRED_MSG.to_string());
    }

    // ④ SSRF 校验(DNS 全记录逐一判定)
    assert_public_target(&parsed)?;

    // ⑤ 认证注入(Rust 内完成)
    let method = normalize_method(opts.method.as_deref().unwrap_or("GET"))?;
    let request_headers = merge_request_headers(opts.headers.as_ref(), mode)?;
    let has_content_type = request_headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("content-type"));

    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        // 不跟随重定向:防止白名单内域名经 3xx 跳转到内网地址绕过校验
        .redirects(0)
        .build();
    let mut req = agent.request(method, parsed.as_str());

    if let Some(mode_name) = mode {
        let secret = load_credential(&SystemKeyring, &scope, &real_env)?;
        match (mode_name, secret) {
            ("raw", AuthSecret::Single(key)) => {
                req = req.set("Authorization", &key);
            }
            ("bearer", AuthSecret::Single(key)) => {
                let value = format!("Bearer {key}");
                req = req.set("Authorization", &value);
            }
            ("volcengine", AuthSecret::AkSk(ak, sk)) => {
                let xdate = now_xdate();
                let (_, authorization) = volcengine_sign(&ak, &sk, method, &parsed, &xdate)?;
                req = req.set("X-Date", &xdate).set("Authorization", &authorization);
            }
            ("volcengine", AuthSecret::Single(_)) => {
                return Err("volcengine 凭据为 AK/SK 双值,不支持 raw/bearer 认证".to_string());
            }
            (_, AuthSecret::AkSk(..)) => {
                return Err("volcengine 凭据仅支持 volcengine 认证模式".to_string());
            }
            (other, _) => return Err(format!("不支持的认证模式:{other}")),
        }
    }
    for (name, value) in &request_headers {
        req = req.set(name, value);
    }
    // 带 body 且未显式给 Content-Type 时,按插件场景默认 JSON
    if opts.body.is_some() && !has_content_type {
        req = req.set("Content-Type", "application/json");
    }

    // ⑥ 发送(整体超时 15s;4xx/5xx 走 Error::Status 分支,响应照常返回给 JS)
    let response = match opts.body.as_deref() {
        Some(body) => req.send_string(body),
        None => req.call(),
    };
    match response {
        Ok(resp) => read_net_response(resp.status(), resp),
        Err(ureq::Error::Status(status, resp)) => read_net_response(status, resp),
        Err(e) => Err(format!("网络请求失败:{e}")),
    }
}

/// ⑦ 读取响应体:截断上限 1MB,非 UTF-8 按 lossy 处理,status 原样返回
fn read_net_response(status: u16, resp: ureq::Response) -> Result<NetResponse, String> {
    let mut reader = resp.into_reader().take((MAX_BODY_BYTES + 1) as u64);
    let mut buf = Vec::new();
    reader
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取响应失败:{e}"))?;
    buf.truncate(MAX_BODY_BYTES);
    Ok(NetResponse {
        status,
        body: String::from_utf8_lossy(&buf).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::MemKeyring;

    // ---------- SSRF 拦截 ----------

    /// 私网 / 环回 / 保留 / 组播 / 链路本地 / IPv6 内网地址全部拦截
    #[test]
    fn ssrf_blocks_private_loopback_reserved_ips() {
        let blocked = [
            // 私网三段(含边界)
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.255",
            "192.168.1.1",
            // 环回
            "127.0.0.1",
            // 未指定 / 0/8
            "0.0.0.0",
            "0.1.2.3",
            // 链路本地(云厂商元数据服务所在段)
            "169.254.169.254",
            // 组播 224/4
            "224.0.0.1",
            "239.255.255.255",
            // 保留 240/4(含广播)
            "240.0.0.1",
            "255.255.255.255",
            // IPv6
            "::1",
            "::",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            // IPv4-mapped 借道
            "::ffff:10.0.0.1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
        ];
        for s in blocked {
            let ip: IpAddr = s.parse().unwrap();
            assert!(is_forbidden_ip(&ip), "{s} 应被 SSRF 拦截");
        }
    }

    /// 合法公网地址放行(含私网段边界外侧与公网 IPv6、公网 mapped)
    #[test]
    fn ssrf_allows_public_ips() {
        let allowed = [
            "8.8.8.8",
            "1.1.1.1",
            "104.16.132.229",
            "9.255.255.255",  // 10/8 外侧边界
            "172.32.0.1",     // 172.16/12 外侧边界
            "192.169.0.1",    // 192.168/16 外侧边界
            "2606:4700::1111",
            "2001:4860:4860::8888",
            "::ffff:8.8.8.8",
        ];
        for s in allowed {
            let ip: IpAddr = s.parse().unwrap();
            assert!(!is_forbidden_ip(&ip), "{s} 是公网地址,不应拦截");
        }
    }

    // ---------- scheme 白名单 ----------

    #[test]
    fn non_http_schemes_are_rejected() {
        let rejected = [
            "ftp://open.bigmodel.cn/x",
            "file:///C:/Windows/system.ini",
            "data:text/html,hello",
            "javascript:alert(1)",
            "ws://open.bigmodel.cn/x",
        ];
        for bad in rejected {
            assert!(validate_url(bad).is_err(), "{bad} 应被拒绝");
        }
        // http/https 正常解析出 host;残缺 URL 拒绝
        assert_eq!(
            validate_url("https://open.bigmodel.cn/api")
                .unwrap()
                .host_str(),
            Some("open.bigmodel.cn")
        );
        assert!(validate_url("http://open.bigmodel.cn/api").is_ok());
        assert!(validate_url("not a url").is_err());
    }

    // ---------- host 白名单 ----------

    const PLUGINS_JSON: &str = r#"{
      "installed": {
        "token-monitor": {
          "permissions": [
            "net:open.bigmodel.cn",
            "net:ark.cn-beijing.volcengineapi.com",
            "net:opencode.ai",
            "credential:glm",
            "window:float"
          ]
        }
      }
    }"#;

    #[test]
    fn whitelist_declared_host_passes_undeclared_rejected() {
        let perms = extract_permissions(PLUGINS_JSON, "token-monitor").unwrap();
        assert_eq!(perms.len(), 5);
        assert!(host_allowed(&perms, "open.bigmodel.cn"));
        assert!(host_allowed(&perms, "ark.cn-beijing.volcengineapi.com"));
        // host 比对大小写不敏感
        assert!(host_allowed(&perms, "OPEN.BIGMODEL.CN"));
        // 未声明 host / 子域名(精确匹配,非后缀匹配)一律拒绝
        assert!(!host_allowed(&perms, "evil.com"));
        assert!(!host_allowed(&perms, "api.open.bigmodel.cn"));
        // `net:` 前缀之外的权限串不参与 host 匹配
        assert!(!host_allowed(&perms, "glm"));
    }

    /// 文件缺失 / 解析失败 / 条目缺失 / permissions 缺失 / 无 net: 条目,均按
    /// 「插件未声明该网络权限」拒绝(白名单收紧语义)
    #[test]
    fn whitelist_missing_data_fails_closed() {
        for raw in [
            "{ not json",
            "{}",
            r#"{"installed": {}}"#,
            r#"{"installed": {"token-monitor": {}}}"#,
            r#"{"installed": {"token-monitor": {"permissions": "net:open.bigmodel.cn"}}}"#,
        ] {
            let err = extract_permissions(raw, "token-monitor").unwrap_err();
            assert_eq!(err, "插件未声明该网络权限", "raw = {raw}");
        }
        // 有条目但无对应 net: → host_allowed false,命令层最终报同一错误
        let perms = extract_permissions(
            r#"{"installed": {"token-monitor": {"permissions": ["window:float"]}}}"#,
            "token-monitor",
        )
        .unwrap();
        assert!(!host_allowed(&perms, "open.bigmodel.cn"));
    }

    #[test]
    fn credential_scope_permission_gate() {
        let perms = extract_permissions(PLUGINS_JSON, "token-monitor").unwrap();
        assert!(credential_allowed(&perms, "glm"));
        assert!(!credential_allowed(&perms, "volcengine"), "快照里没声明");
        assert!(!credential_allowed(&perms, "anything-else"));
    }

    // ---------- 凭据解析(环境变量优先 → 凭据管理器兜底) ----------

    /// 构造 getenv 闭包,不触碰进程真实环境变量
    fn env_map(vars: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let vars: BTreeMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |name| vars.get(name).cloned()
    }

    #[test]
    fn credential_env_first_then_keyring_fallback() {
        let store = MemKeyring::new();
        // 环境变量优先
        let env = env_map(&[("PROMPT_VAULT_GLM_KEY", "test-glm-key")]);
        match load_credential(&store, "glm", &env).unwrap() {
            AuthSecret::Single(k) => assert_eq!(k, "test-glm-key"),
            _ => panic!("glm 应解析为单值 Key"),
        }
        // 无环境变量时回落凭据管理器
        let no_env = env_map(&[]);
        store.set("glm", "test-glm-keyring").unwrap();
        match load_credential(&store, "glm", &no_env).unwrap() {
            AuthSecret::Single(k) => assert_eq!(k, "test-glm-keyring"),
            _ => panic!("glm 应解析为单值 Key"),
        }
        // 空串环境变量视为未设置 → 仍回落凭据管理器
        let empty_env = env_map(&[("PROMPT_VAULT_GLM_KEY", "")]);
        match load_credential(&store, "glm", &empty_env).unwrap() {
            AuthSecret::Single(k) => assert_eq!(k, "test-glm-keyring"),
            _ => panic!("空串环境变量应视为未设置"),
        }
        // 两处都没有 → 报错
        assert!(load_credential(&store, "opencode", &no_env).is_err());
    }

    #[test]
    fn volcengine_ak_sk_resolution() {
        let store = MemKeyring::new();
        let no_env = env_map(&[]);
        // 凭据管理器条目按 "AK\nSK" 两行编码读取
        store.set("volcengine", "test-ak-1234\ntest-sk-5678").unwrap();
        match load_credential(&store, "volcengine", &no_env).unwrap() {
            AuthSecret::AkSk(ak, sk) => {
                assert_eq!(ak, "test-ak-1234");
                assert_eq!(sk, "test-sk-5678");
            }
            _ => panic!("volcengine 应解析为 AK/SK 双值"),
        }
        // 环境变量优先,但 AK/SK 必须成对出现
        let half = env_map(&[("PROMPT_VAULT_VOLCENGINE_AK", "test-ak-1234")]);
        assert!(load_credential(&store, "volcengine", &half).is_err());
        let both = env_map(&[
            ("PROMPT_VAULT_VOLCENGINE_AK", "test-ak-1234"),
            ("PROMPT_VAULT_VOLCENGINE_SK", "test-sk-5678"),
        ]);
        match load_credential(&store, "volcengine", &both).unwrap() {
            AuthSecret::AkSk(ak, sk) => {
                assert_eq!(ak, "test-ak-1234");
                assert_eq!(sk, "test-sk-5678");
            }
            _ => panic!("volcengine 应解析为 AK/SK 双值"),
        }
        // 条目缺 SK 行 → 报错
        let broken = MemKeyring::new();
        broken.set("volcengine", "only-ak-line").unwrap();
        assert!(load_credential(&broken, "volcengine", &no_env).is_err());
    }

    #[test]
    fn load_credential_rejects_invalid_scope() {
        let store = MemKeyring::new();
        let no_env = env_map(&[]);
        assert!(load_credential(&store, "GLM", &no_env).is_err());
        assert!(load_credential(&store, "", &no_env).is_err());
    }

    // ---------- 火山签名规范化 ----------

    #[test]
    fn volc_uri_encoding_keeps_unreserved_only() {
        assert_eq!(volc_uri_encode("Action=GetAFPUsage"), "Action%3DGetAFPUsage");
        assert_eq!(volc_uri_encode("a b+c&d/e?f"), "a%20b%2Bc%26d%2Fe%3Ff");
        assert_eq!(volc_uri_encode("A-z_0.9~"), "A-z_0.9~");
        assert_eq!(volc_uri_encode("2024-01-01"), "2024-01-01");
        // 非 ASCII 按 UTF-8 字节逐字节编码
        assert_eq!(volc_uri_encode("中"), "%E4%B8%AD");
    }

    #[test]
    fn volc_canonical_query_sorts_and_encodes() {
        // 按键字节序重排
        let url = validate_url(
            "https://ark.cn-beijing.volcengineapi.com/?Version=2024-01-01&Action=GetAFPUsage",
        )
        .unwrap();
        assert_eq!(
            volc_canonical_query(&url),
            "Action=GetAFPUsage&Version=2024-01-01"
        );
        // 值中的空格按 RFC 3986 编码为 %20(不是 +)
        let url = validate_url("https://ark.cn-beijing.volcengineapi.com/?b=x y&a=1").unwrap();
        assert_eq!(volc_canonical_query(&url), "a=1&b=x%20y");
    }

    /// X-Date 固定格式 yyyymmdd'T'hhmmss'Z'(与 lib.rs 已核实的日期向量同源)
    #[test]
    fn volc_xdate_format_is_yyyymmdd_thhmmssz() {
        assert_eq!(xdate_from_epoch_secs(0), "19700101T000000Z");
        assert_eq!(xdate_from_epoch_secs(1_700_000_000), "20231114T221320Z");
        assert_eq!(xdate_from_epoch_secs(1_709_164_800), "20240229T000000Z");
        assert_eq!(xdate_from_epoch_secs(1_767_225_599), "20251231T235959Z");
    }

    /// 固定向量全链路:期望签名由独立实现(node crypto)预先计算,
    /// 而非用本实现生成,防止实现与测试互相「抄答案」。凭据均为明显假串。
    #[test]
    fn volcengine_sign_matches_independent_fixed_vector() {
        let url = validate_url(
            "https://ark.cn-beijing.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01",
        )
        .unwrap();
        let (xdate, authorization) =
            volcengine_sign("test-ak-1234", "test-sk-5678", "GET", &url, "20261113T080000Z")
                .unwrap();
        assert_eq!(xdate, "20261113T080000Z");
        assert_eq!(
            authorization,
            "HMAC-SHA256 Credential=test-ak-1234/20261113/cn-beijing/ark/request, \
             SignedHeaders=host;x-date, \
             Signature=4794263ce553faa051b166eb4e4b01fd98c357cd3e97ec3b6eca026ce5c7aea1"
        );
    }

    // ---------- 请求头与方法 ----------

    #[test]
    fn header_validation_rejects_injection_and_garbage() {
        assert!(validate_header("content-type", "application/json").is_ok());
        assert!(validate_header("X-Tag", "a\tb").is_ok());
        assert!(validate_header("bad header", "v").is_err());
        assert!(validate_header("x-a", "line1\r\nX-Evil: 1").is_err());
        assert!(validate_header("x-a", "\0").is_err());
        assert!(validate_header("", "v").is_err());
    }

    /// 认证模式下 authorization/x-date 由 Rust 注入,插件不可覆写;其余头透传
    #[test]
    fn auth_mode_protects_authorization_and_xdate_headers() {
        let mut headers = BTreeMap::new();
        headers.insert("Authorization".to_string(), "fake-override".to_string());
        headers.insert("X-Date".to_string(), "20200101T000000Z".to_string());
        headers.insert("X-Tag".to_string(), "keep".to_string());
        // 无认证模式:自带头原样透传(插件调用自有公共端点场景)
        let plain = merge_request_headers(Some(&headers), None).unwrap();
        assert_eq!(plain.len(), 3);
        // 认证模式:受保护头被剔除
        let authed = merge_request_headers(Some(&headers), Some("raw")).unwrap();
        assert_eq!(authed, vec![("X-Tag".to_string(), "keep".to_string())]);
    }

    #[test]
    fn method_whitelist() {
        assert_eq!(normalize_method("get").unwrap(), "GET");
        assert_eq!(normalize_method("Post ").unwrap(), "POST");
        assert_eq!(normalize_method("PATCH").unwrap(), "PATCH");
        for bad in ["CONNECT", "TRACE", "OPTIONS", ""] {
            assert!(normalize_method(bad).is_err(), "「{bad}」应被拒绝");
        }
    }
}
