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
const PROVIDER_MAX_LEN: usize = 32;
const LABEL_MAX_CHARS: usize = 16;
const SECRET_MAX_LEN: usize = 4096;

/// 默认账号的 label:无 label(`<provider>`,旧单账号形态)≡ label 为
/// "default" 的账号(迁移后形态)。两者的 env 映射与删除连带按 default 语义特判。
pub(crate) const DEFAULT_LABEL: &str = "default";

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

/// provider 段校验:等价正则 `^[a-z0-9-]{1,32}$`,手写字符判定避免引入 regex 依赖
pub(crate) fn provider_valid(provider: &str) -> bool {
    !provider.is_empty()
        && provider.len() <= PROVIDER_MAX_LEN
        && provider
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// label 段校验:等价正则 `[A-Za-z0-9_-\u4e00-\u9fa5]{1,16}`(按字符数计,
/// 中文一个字算一位)。禁冒号/斜杠/空白 —— 冒号会造出多段 scope 使前缀权限
/// 门控与 cache 键解析歧义,斜杠与空白防路径/展示层逃逸。
fn label_valid(label: &str) -> bool {
    let count = label.chars().count();
    count >= 1
        && count <= LABEL_MAX_CHARS
        && label.chars().all(|c| {
            c.is_ascii_alphanumeric() || c == '_' || c == '-' || ('\u{4e00}'..='\u{9fa5}').contains(&c)
        })
}

/// scope 语法:`<provider>[:<label>]`(单冒号;无 label ≡ 该 provider 的
/// default 账号)。等价于 provider 段与 label 段分别校验;`glm:a:b` 因 label
/// 段含冒号天然被拒。
pub(crate) fn scope_valid(scope: &str) -> bool {
    match scope.split_once(':') {
        None => provider_valid(scope),
        Some((provider, label)) => provider_valid(provider) && label_valid(label),
    }
}

/// scope 解析 → (provider, Option<label>);非法 scope 返回 None
pub(crate) fn scope_parts(scope: &str) -> Option<(&str, Option<&str>)> {
    if !scope_valid(scope) {
        return None;
    }
    Some(match scope.split_once(':') {
        None => (scope, None),
        Some((provider, label)) => (provider, Some(label)),
    })
}

fn validate_scope(scope: &str) -> Result<(), String> {
    if scope_valid(scope) {
        Ok(())
    } else {
        Err("scope 需为 <provider> 或 <provider>:<label>(provider:小写字母/数字/连字符 1-32 位;label:字母/数字/下划线/连字符/中文 1-16 位,禁冒号斜杠空白)".to_string())
    }
}

/// 凭据写入(设置面板录入各家 Key 时直调;main-only:插件窗口整体挡在门外)。
/// async 命令:调用者与 scope 纯内存校验留在外层,keyring IO 进阻塞池,
/// 不冻结主窗口事件循环。
#[tauri::command]
pub async fn plugin_credential_set(
    window: tauri::WebviewWindow,
    scope: String,
    secret: String,
) -> Result<(), String> {
    crate::plugins::ensure_caller_main(window.label())?;
    // scope 预校验:与 credential_set_with 的首检同一函数,失败立即返回不进阻塞池
    validate_scope(&scope)?;
    tauri::async_runtime::spawn_blocking(move || {
        credential_set_with(&SystemKeyring, &scope, &secret)
    })
    .await
    .map_err(|e| format!("后台任务执行失败:{e}"))?
}

/// 凭据删除(main-only)。async 命令:调用者与 scope 校验留在外层,keyring IO 进阻塞池。
#[tauri::command]
pub async fn plugin_credential_delete(
    window: tauri::WebviewWindow,
    scope: String,
) -> Result<(), String> {
    crate::plugins::ensure_caller_main(window.label())?;
    validate_scope(&scope)?;
    tauri::async_runtime::spawn_blocking(move || credential_delete_with(&SystemKeyring, &scope))
        .await
        .map_err(|e| format!("后台任务执行失败:{e}"))?
}

/// scope 凭据是否已配置(设置面板/插件面板展示「已配置」用):
/// 环境变量优先(命名与空串语义复用 net.rs 的 credential_env_configured),
/// env 未配置再查 keyring 条目 —— get 后只判存在与非空,**秘密值绝不返回**。
/// self-or-main 的退化形:参数是 scope 而无 plugin_id,逐字比对以调用者
/// 自身 label 剥前缀的 id 进行 —— 任意插件窗口可查存在性布尔(前端桥已
/// fail-closed 限定自身 manifest 的 scope),非 main/插件窗口一律拒绝。
/// async 命令:调用者与 scope 校验留在外层,keyring IO 进阻塞池。
#[tauri::command]
pub async fn plugin_credential_configured(
    window: tauri::WebviewWindow,
    scope: String,
) -> Result<bool, String> {
    let label = window.label();
    let self_id = label.strip_prefix(crate::plugins::PLUGIN_WINDOW_PREFIX).unwrap_or("");
    crate::plugins::ensure_caller_self_or_main(label, self_id)?;
    validate_scope(&scope)?;
    tauri::async_runtime::spawn_blocking(move || {
        credential_configured_with(&SystemKeyring, &scope, &crate::net::real_env)
    })
    .await
    .map_err(|e| format!("后台任务执行失败:{e}"))?
}

/// 命令体抽成 store + getenv 参数形式,单测可注入内存 mock 与假环境。
/// 解析链(顺序即优先级,label 由 scope 语法给出):
///   - 无 label(旧单账号形态,行为不变):env → keyring `<provider>`;
///   - label "default"(迁移后默认账号):keyring `<provider>:default` → env →
///     keyring `<provider>`(legacy 回落 —— 迁移不搬运旧条目,靠回落读到旧 Key);
///   - 其余 label:keyring `<provider>:<label>` → keyring `<provider>`(legacy 回落)。
/// env 固定映射 provider 的 default 账号(命名见 net.rs),不外溢到其他 label。
pub(crate) fn credential_configured_with(
    store: &dyn KeyringBackend,
    scope: &str,
    getenv: &dyn Fn(&str) -> Option<String>,
) -> Result<bool, String> {
    let Some((provider, label)) = scope_parts(scope) else {
        return Err("凭据 scope 不合法".to_string());
    };
    let has_entry = |name: &str| -> Result<bool, String> {
        Ok(store.get(name)?.map(|s| !s.is_empty()).unwrap_or(false))
    };
    match label {
        None => {
            if crate::net::credential_env_configured_with(provider, getenv) {
                return Ok(true);
            }
            has_entry(scope)
        }
        Some(DEFAULT_LABEL) => {
            if has_entry(scope)? {
                return Ok(true);
            }
            if crate::net::credential_env_configured_with(provider, getenv) {
                return Ok(true);
            }
            has_entry(provider)
        }
        Some(_) => {
            if has_entry(scope)? {
                return Ok(true);
            }
            has_entry(provider)
        }
    }
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

/// 凭据删除的 default 连带:label "default" 的账号删除时连 legacy 旧条目
/// (`<provider>`)一起删 —— 迁移不搬运旧条目,旧条目是该账号的凭据遗产,
/// 不连带删会经回落串号到之后新建的任意 `<provider>:<label>` 账号;
/// 其余 label 只删自身;无 label 即旧条目本身,只删自身。删除幂等(条目
/// 不存在也成功),因此 `glm:default` 无自名条目(纯迁移形态)时同样会清掉旧条目。
pub(crate) fn credential_delete_with(
    store: &dyn KeyringBackend,
    scope: &str,
) -> Result<(), String> {
    let Some((provider, label)) = scope_parts(scope) else {
        return Err("凭据 scope 不合法".to_string());
    };
    store.delete(scope)?;
    if label == Some(DEFAULT_LABEL) {
        store.delete(provider)?;
    }
    Ok(())
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
        scope_parts, scope_valid, KeyringBackend,
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

    /// scope 正则的等价边界:provider 段 `^[a-z0-9-]{1,32}$` +
    /// label 段 `[A-Za-z0-9_-\u4e00-\u9fa5]{1,16}`(单冒号,无 label ≡ default 账号)
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

    /// 带label scope 的边界:合法形态 / 含冒号 label 拒(多段 scope)/ 空与超长
    /// label 拒 / 中文与 16 字 label 过 / provider 段非法拒
    #[test]
    fn labeled_scope_validation_bounds() {
        for ok in [
            "glm:main",
            "glm:default",
            "volcengine:主号",
            "opencode:work-1",
            "glm:A_b-3",
            "glm:一二三四五六七八九十一二三四五六", // 16 字中文 label(48 字节)
        ] {
            assert!(scope_valid(ok), "「{ok}」应通过 scope 校验");
        }
        for bad in [
            "glm:",           // 空 label
            ":main",          // 空 provider
            "glm:a:b",        // label 含冒号(多段 scope)
            "glm:a/b",        // 斜杠禁入 label
            "glm:a b",        // 空白禁入 label
            "glm:a\tb",
            "glm:MAIN:2",     // 多段
            "GLM:main",       // provider 大写
            "glm:字字字字字字字字字字字字字字字字字", // 17 字超长
            "glm:main ",      // 尾随空白
        ] {
            assert!(!scope_valid(bad), "「{bad}」不应通过 scope 校验");
        }
    }

    /// scope_parts 解析:provider 段与 label 段拆分正确,非法 scope 返回 None
    #[test]
    fn scope_parts_splits_provider_and_label() {
        assert_eq!(scope_parts("glm"), Some(("glm", None)));
        assert_eq!(scope_parts("glm:main"), Some(("glm", Some("main"))));
        assert_eq!(scope_parts("volcengine:主号"), Some(("volcengine", Some("主号"))));
        assert_eq!(scope_parts(""), None);
        assert_eq!(scope_parts("glm:a:b"), None);
        assert_eq!(scope_parts("GLM"), None);
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
        assert!(credential_configured_with(&store, "glm:a:b", &env_map(&[])).is_err());
    }

    /* ---- 多账号:legacy 回落与 default 连带 ---- */

    /// labeled scope 回落三态之一(新名命中):`glm:main` 自名条目存在时直接命中,
    /// 且自录 Key 不被 default 账号的 env 遮蔽
    #[test]
    fn configured_labeled_scope_own_entry_wins_over_env() {
        let store = MemKeyring::new();
        let env = env_map(&[("PROMPT_VAULT_GLM_KEY", "test-glm-key")]);
        store.set("glm:main", "test-glm-key-2").unwrap();
        assert_eq!(
            credential_configured_with(&store, "glm:main", &env).unwrap(),
            true,
            "自名条目命中,env 不遮蔽"
        );
        // 删掉自名条目后(无回落可用):其他 label 不读 env → 未配置
        store.delete("glm:main").unwrap();
        assert_eq!(
            credential_configured_with(&store, "glm:main", &env).unwrap(),
            false,
            "非 default 的 label 账号不读 env(env 固定映射 default 账号)"
        );
    }

    /// labeled scope 回落三态之二(default 的 env 命中):`glm:default` 无自名
    /// 条目、env 命中 → 已配置(env 固定映射 default 账号的迁移形态)
    #[test]
    fn configured_default_label_reads_provider_env() {
        let store = MemKeyring::new();
        let env = env_map(&[("PROMPT_VAULT_GLM_KEY", "test-glm-key")]);
        assert_eq!(
            credential_configured_with(&store, "glm:default", &env).unwrap(),
            true
        );
        // 其他 label 不继承 default 的 env
        assert_eq!(
            credential_configured_with(&store, "glm:work", &env).unwrap(),
            false
        );
    }

    /// labeled scope 回落三态之三(回落旧名):`glm:default` 与 `glm:main` 在
    /// env 与自名条目均未命中时回落旧 `<provider>` 条目(迁移不搬运旧条目的关键)
    #[test]
    fn configured_labeled_scope_falls_back_to_legacy_entry() {
        let store = MemKeyring::new();
        let no_env = env_map(&[]);
        store.set("glm", "test-glm-key").unwrap();
        assert_eq!(
            credential_configured_with(&store, "glm:default", &no_env).unwrap(),
            true,
            "default 账号回落旧条目"
        );
        assert_eq!(
            credential_configured_with(&store, "glm:main", &no_env).unwrap(),
            true,
            "任意 label 回落旧条目(开工卡 §1.2 provider:任意label)"
        );
        // 空串旧条目视为未配置 → 回落失败
        let empty = MemKeyring::new();
        empty.set("glm", "").unwrap();
        assert_eq!(
            credential_configured_with(&empty, "glm:default", &no_env).unwrap(),
            false
        );
    }

    /// volcengine 的 labeled 账号:AK/SK 双值语义随 provider 段生效;
    /// 自名条目优先,回落旧条目,default 账号读完整成对的 env
    #[test]
    fn configured_labeled_volcengine_ak_sk() {
        let store = MemKeyring::new();
        let no_env = env_map(&[]);
        // 回落旧条目("AK\nSK" 两行编码)
        store.set("volcengine", "test-ak-1234\ntest-sk-5678").unwrap();
        assert_eq!(
            credential_configured_with(&store, "volcengine:main", &no_env).unwrap(),
            true
        );
        // 自名条目优先
        store.set("volcengine:main", "test-ak-9999\ntest-sk-8888").unwrap();
        assert_eq!(
            credential_configured_with(&store, "volcengine:main", &no_env).unwrap(),
            true
        );
        // default 账号:自名条目未建时 env 完整成对命中
        let both = env_map(&[
            ("PROMPT_VAULT_VOLCENGINE_AK", "test-ak-1234"),
            ("PROMPT_VAULT_VOLCENGINE_SK", "test-sk-5678"),
        ]);
        assert_eq!(
            credential_configured_with(&store, "volcengine:default", &both).unwrap(),
            true
        );
        // 非 default label 不读 env
        let only = MemKeyring::new();
        assert_eq!(
            credential_configured_with(&only, "volcengine:main", &both).unwrap(),
            false
        );
    }

    /// default 账号删除连带旧条目:`glm:default` 删除同时清 `glm:default` 与
    /// 旧 `glm`;其余 label 只删自身;无 label 即旧条目本身
    #[test]
    fn delete_default_label_cascades_legacy_entry() {
        let store = MemKeyring::new();
        store.set("glm", "test-glm-key").unwrap();
        store.set("glm:default", "test-glm-key-2").unwrap();
        store.set("glm:work", "test-glm-key-3").unwrap();
        credential_delete_with(&store, "glm:work").unwrap();
        assert_eq!(store.get("glm:work").unwrap(), None);
        assert_eq!(store.get("glm").unwrap().as_deref(), Some("test-glm-key"), "非 default label 删除不连带");
        credential_delete_with(&store, "glm:default").unwrap();
        assert_eq!(store.get("glm:default").unwrap(), None);
        assert_eq!(store.get("glm").unwrap(), None, "default 删除连旧条目一起删");
        // 纯迁移形态(自名条目不存在)同样清掉旧条目
        store.set("volcengine", "test-ak-1234\ntest-sk-5678").unwrap();
        credential_delete_with(&store, "volcengine:default").unwrap();
        assert_eq!(store.get("volcengine").unwrap(), None);
        // 无 label:只删自身(即旧条目本身)
        store.set("opencode", "test-oc-key").unwrap();
        credential_delete_with(&store, "opencode").unwrap();
        assert_eq!(store.get("opencode").unwrap(), None);
    }

    /// 非法 labeled scope 的写入/删除拒绝,不落任何条目
    #[test]
    fn command_set_delete_rejects_invalid_labeled_scope() {
        let store = MemKeyring::new();
        assert!(credential_set_with(&store, "glm:", "test-glm-key").is_err());
        assert!(credential_set_with(&store, "glm:a:b", "test-glm-key").is_err());
        assert!(credential_set_with(&store, "glm:a/b", "test-glm-key").is_err());
        assert!(credential_delete_with(&store, "glm:", ).is_err());
        assert_eq!(store.get("glm:").unwrap(), None, "被拒绝的写入不落盘");
        // 合法中文 label 可写入
        credential_set_with(&store, "glm:主号", "test-glm-key").unwrap();
        assert_eq!(store.get("glm:主号").unwrap().as_deref(), Some("test-glm-key"));
    }
}
