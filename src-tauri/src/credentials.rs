//! 插件凭据服务:Windows 凭据管理器(keyring)的写入/删除封装。
//!
//! 约定:凭据条目 service 统一为 `prompt-vault`,user = scope;
//! 火山方舟(volcengine)因 AK/SK 双值,单条 secret 按 `"AK\nSK"` 两行编码存储,
//! 读取约定见 net.rs 的 load_credential。
//!
//! 安全边界:对外只暴露 set/delete 两条命令,**不提供任何读取命令**;
//! 凭据读取只发生在网络代理拼装认证时(net.rs),Key 明文全程不出 Rust 进程。

use keyring::Entry;

const KEYRING_SERVICE: &str = "prompt-vault";
const SCOPE_MAX_LEN: usize = 32;
const SECRET_MAX_LEN: usize = 4096;

/// 凭据存储抽象:真实实现走 Windows 凭据管理器,单测用内存 mock,不真写系统凭据
pub(crate) trait KeyringBackend: Send + Sync {
    /// 写入(覆盖已存在条目)
    fn set(&self, scope: &str, secret: &str) -> Result<(), String>;
    /// 删除;条目不存在时也应返回成功(幂等)
    fn delete(&self, scope: &str) -> Result<(), String>;
    /// 仅限 Rust 内部拼装网络认证时调用,绝不作为命令暴露给 JS
    fn get(&self, scope: &str) -> Result<Option<String>, String>;
}

pub(crate) struct SystemKeyring;

impl KeyringBackend for SystemKeyring {
    fn set(&self, scope: &str, secret: &str) -> Result<(), String> {
        let entry =
            Entry::new(KEYRING_SERVICE, scope).map_err(|e| format!("凭据管理器不可用:{e}"))?;
        entry
            .set_password(secret)
            .map_err(|e| format!("凭据写入失败:{e}"))
    }

    fn delete(&self, scope: &str) -> Result<(), String> {
        let entry =
            Entry::new(KEYRING_SERVICE, scope).map_err(|e| format!("凭据管理器不可用:{e}"))?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            // 条目不存在视为删除成功,保证卸载清理等幂等场景不报错
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("凭据删除失败:{e}")),
        }
    }

    fn get(&self, scope: &str) -> Result<Option<String>, String> {
        let entry =
            Entry::new(KEYRING_SERVICE, scope).map_err(|e| format!("凭据管理器不可用:{e}"))?;
        match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("凭据读取失败:{e}")),
        }
    }
}

/// scope 校验:等价于正则 `^[a-z0-9-]{1,32}$`,手写字符判定避免引入 regex 依赖
pub(crate) fn scope_valid(scope: &str) -> bool {
    !scope.is_empty()
        && scope.len() <= SCOPE_MAX_LEN
        && scope
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn validate_scope(scope: &str) -> Result<(), String> {
    if scope_valid(scope) {
        Ok(())
    } else {
        Err("scope 只能包含小写字母、数字和连字符(1-32 位)".to_string())
    }
}

/// 凭据写入(设置面板录入各家 Key 时直调)
#[tauri::command]
pub fn plugin_credential_set(scope: String, secret: String) -> Result<(), String> {
    credential_set_with(&SystemKeyring, &scope, &secret)
}

/// 凭据删除
#[tauri::command]
pub fn plugin_credential_delete(scope: String) -> Result<(), String> {
    credential_delete_with(&SystemKeyring, &scope)
}

/// scope 凭据是否已配置(设置面板/插件面板展示「已配置」用):
/// 环境变量优先(命名与空串语义复用 net.rs 的 credential_env_configured),
/// env 未配置再查 keyring 条目 —— get 后只判存在与非空,**秘密值绝不返回**。
#[tauri::command]
pub fn plugin_credential_configured(scope: String) -> Result<bool, String> {
    credential_configured_with(&SystemKeyring, &scope, &crate::net::real_env)
}

/// 命令体抽成 store + getenv 参数形式,单测可注入内存 mock 与假环境
pub(crate) fn credential_configured_with(
    store: &dyn KeyringBackend,
    scope: &str,
    getenv: &dyn Fn(&str) -> Option<String>,
) -> Result<bool, String> {
    validate_scope(scope)?;
    if crate::net::credential_env_configured_with(scope, getenv) {
        return Ok(true);
    }
    Ok(store
        .get(scope)?
        .map(|s| !s.is_empty())
        .unwrap_or(false))
}

/// 命令体抽成 store 参数形式,单测可注入内存 mock
pub(crate) fn credential_set_with(
    store: &dyn KeyringBackend,
    scope: &str,
    secret: &str,
) -> Result<(), String> {
    validate_scope(scope)?;
    if secret.is_empty() {
        return Err("凭据内容不能为空".to_string());
    }
    if secret.len() > SECRET_MAX_LEN {
        return Err(format!("凭据过长(上限 {SECRET_MAX_LEN} 字节)"));
    }
    store.set(scope, secret)
}

pub(crate) fn credential_delete_with(
    store: &dyn KeyringBackend,
    scope: &str,
) -> Result<(), String> {
    validate_scope(scope)?;
    store.delete(scope)
}

#[cfg(test)]
pub(crate) struct MemKeyring {
    entries: std::sync::Mutex<std::collections::BTreeMap<String, String>>,
}

#[cfg(test)]
impl MemKeyring {
    pub(crate) fn new() -> Self {
        Self {
            entries: std::sync::Mutex::new(std::collections::BTreeMap::new()),
        }
    }
}

#[cfg(test)]
impl KeyringBackend for MemKeyring {
    fn set(&self, scope: &str, secret: &str) -> Result<(), String> {
        self.entries
            .lock()
            .unwrap()
            .insert(scope.to_string(), secret.to_string());
        Ok(())
    }

    fn delete(&self, scope: &str) -> Result<(), String> {
        self.entries.lock().unwrap().remove(scope);
        Ok(())
    }

    fn get(&self, scope: &str) -> Result<Option<String>, String> {
        Ok(self.entries.lock().unwrap().get(scope).cloned())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        MemKeyring, credential_configured_with, credential_delete_with, credential_set_with,
        scope_valid, KeyringBackend,
    };

    /// 假环境:与 net.rs 测试的 env_map 同构(键值精确匹配,未列出的键返回 None)
    fn env_map<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name: &str| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.to_string())
        }
    }

    /// scope 正则 `^[a-z0-9-]{1,32}$` 的等价边界
    #[test]
    fn scope_validation_matches_regex_bounds() {
        for ok in ["glm", "opencode", "volcengine", "a", "a-b2", &"k".repeat(32)] {
            assert!(scope_valid(ok), "「{ok}」应通过 scope 校验");
        }
        for bad in [
            "",
            "GLM",
            "A",
            "a_b",
            "a b",
            "glm\n",
            "a.",
            "中文",
            &"k".repeat(33),
        ] {
            assert!(!scope_valid(bad), "「{bad}」不应通过 scope 校验");
        }
    }

    /// 凭据 trait 的内存 mock:写 → 读 → 覆盖写 → 删 → 读为空
    #[test]
    fn mock_keyring_write_read_delete_roundtrip() {
        let store = MemKeyring::new();
        assert_eq!(store.get("glm").unwrap(), None);
        store.set("glm", "test-glm-key").unwrap();
        assert_eq!(store.get("glm").unwrap().as_deref(), Some("test-glm-key"));
        store.set("glm", "test-glm-key-2").unwrap();
        assert_eq!(
            store.get("glm").unwrap().as_deref(),
            Some("test-glm-key-2"),
            "重复写入应覆盖旧值"
        );
        store.delete("glm").unwrap();
        assert_eq!(store.get("glm").unwrap(), None);
    }

    #[test]
    fn mock_keyring_delete_missing_is_idempotent_ok() {
        let store = MemKeyring::new();
        assert!(store.delete("opencode").is_ok());
    }

    /// 写入命令的校验:非法 scope / 空 secret / 超长 secret 拒绝,且不落任何条目
    #[test]
    fn command_set_validates_scope_and_secret() {
        let store = MemKeyring::new();
        assert!(credential_set_with(&store, "GLM", "test-glm-key").is_err());
        assert!(credential_set_with(&store, "", "test-glm-key").is_err());
        assert!(credential_set_with(&store, "glm", "").is_err());
        let too_long = "x".repeat(4097);
        assert!(credential_set_with(&store, "glm", &too_long).is_err());
        assert_eq!(store.get("glm").unwrap(), None, "被拒绝的写入不应落盘");
        credential_set_with(&store, "glm", "test-glm-key").unwrap();
        assert_eq!(store.get("glm").unwrap().as_deref(), Some("test-glm-key"));
    }

    #[test]
    fn command_delete_validates_scope() {
        let store = MemKeyring::new();
        store.set("glm", "test-glm-key").unwrap();
        assert!(credential_delete_with(&store, "Bad_Scope").is_err());
        credential_delete_with(&store, "glm").unwrap();
        assert_eq!(store.get("glm").unwrap(), None);
    }

    /* ---- plugin_credential_configured:env 优先,keyring 只判存在 ---- */

    /// env 命中:即使 keyring 为空也视为已配置
    #[test]
    fn configured_env_hit() {
        let store = MemKeyring::new();
        let env = env_map(&[("PROMPT_VAULT_GLM_KEY", "test-glm-key")]);
        assert_eq!(credential_configured_with(&store, "glm", &env).unwrap(), true);
        // 空串 env 语义与 load_credential 一致:视为未设置 → 落到 keyring(无)→ false
        let empty_env = env_map(&[("PROMPT_VAULT_GLM_KEY", "")]);
        assert_eq!(
            credential_configured_with(&store, "glm", &empty_env).unwrap(),
            false
        );
    }

    /// 仅 keyring:env 未配置但条目存在(含空串条目视为未配置)
    #[test]
    fn configured_keyring_only() {
        let store = MemKeyring::new();
        let no_env = env_map(&[]);
        assert_eq!(credential_configured_with(&store, "glm", &no_env).unwrap(), false);
        store.set("glm", "test-glm-key").unwrap();
        assert_eq!(credential_configured_with(&store, "glm", &no_env).unwrap(), true);
        store.set("opencode", "").unwrap();
        assert_eq!(
            credential_configured_with(&store, "opencode", &no_env).unwrap(),
            false,
            "空串条目应视为未配置(与 load_credential 空串语义一致)"
        );
    }

    /// 两者皆无:false
    #[test]
    fn configured_neither() {
        let store = MemKeyring::new();
        assert_eq!(credential_configured_with(&store, "opencode", &env_map(&[])).unwrap(), false);
    }

    /// volcengine:AK+SK 双值都非空才算配置;半配(env 只有 AK)落到 keyring 判定
    #[test]
    fn configured_volcengine_requires_both_ak_sk() {
        let store = MemKeyring::new();
        let half = env_map(&[("PROMPT_VAULT_VOLCENGINE_AK", "test-ak-1234")]);
        assert_eq!(credential_configured_with(&store, "volcengine", &half).unwrap(), false);
        let both = env_map(&[
            ("PROMPT_VAULT_VOLCENGINE_AK", "test-ak-1234"),
            ("PROMPT_VAULT_VOLCENGINE_SK", "test-sk-5678"),
        ]);
        assert_eq!(credential_configured_with(&store, "volcengine", &both).unwrap(), true);
        // 半配 env + keyring 有条目 → keyring 兜底为已配置
        store.set("volcengine", "test-ak-1234\ntest-sk-5678").unwrap();
        assert_eq!(credential_configured_with(&store, "volcengine", &half).unwrap(), true);
    }

    /// 非法 scope 报错(与 set/delete 同一校验)
    #[test]
    fn configured_rejects_invalid_scope() {
        let store = MemKeyring::new();
        assert!(credential_configured_with(&store, "GLM", &env_map(&[])).is_err());
        assert!(credential_configured_with(&store, "", &env_map(&[])).is_err());
    }
}
