//! i18n 手动语言包目录(批次2,见设计文档 §7)。
//!
//! 职责:
//! - `i18n_locales`:扫描 `%APPDATA%\prompt-vault\locales\*.json`,文件名去扩展名
//!   即语言码(^[a-zA-Z-]{2,12}$,不合格跳过);内容须为「字符串→字符串扁平对象」,
//!   坏文件在返回条目附 error 提示而非中断(语言包坏了不拖垮宿主);
//! - `i18n_locale_file`:按语言码读取对应 `<码>.json`(码先过同一正则,防拼路径;
//!   单文件上限 1MB;缺失返回 None,由前端回退内置 zh-CN)。
//!
//! 存储布局:%APPDATA%\prompt-vault\locales\<语言码>.json(目录不存在视为空)。
//! 安全边界:语言码先过正则再拼文件名,不含路径分隔符与穿越面;内容只做防御
//! 校验后作为纯数据并入翻译目录,不参与任何代码执行;与凭据/网络无关。

use std::path::Path;

/// 语言码合法性:^[a-zA-Z-]{2,12}$(与前端 coerce 同规则);拒绝空码/下划线/数字
fn is_valid_lang_code(code: &str) -> bool {
    let bytes = code.as_bytes();
    (2..=12).contains(&bytes.len())
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphabetic() || *b == b'-')
}

/// 语言包文件大小上限 1MB(纯文案数据,正常远小于此)
const MAX_LOCALE_FILE_BYTES: u64 = 1024 * 1024;

#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalesEntry {
    pub(crate) code: String,
    pub(crate) file_name: String,
    /// 非 None 表示文件内容校验失败(坏 JSON / 非扁平对象 / 超限),前端跳过该条
    pub(crate) error: Option<String>,
}

/// 「字符串→字符串扁平对象」校验(防御式;与前端 coerceCatalog 同语义)
fn validate_flat_catalog(raw: &str) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| format!("语言包不是有效的 JSON:{e}"))?;
    let Some(map) = value.as_object() else {
        return Err("语言包格式不正确:应为对象".to_string());
    };
    for (k, v) in map {
        if !v.is_string() {
            return Err(format!("语言包格式不正确:键「{k}」的值应为字符串"));
        }
    }
    Ok(())
}

/// 扫描 locales 目录(目录不存在视为空);dir 可注入,命令外壳与单测共用
fn scan_locales(dir: &Path) -> Vec<LocalesEntry> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") || !path.is_file() {
            continue;
        }
        let file_os = entry.file_name();
        let Some(stem) = file_os.to_str() else {
            continue;
        };
        let stem = stem.strip_suffix(".json").unwrap_or(stem);
        let Some(code) = Some(stem).filter(|s| is_valid_lang_code(s)) else {
            continue; // 文件名不是合法语言码:跳过
        };
        let file_name = entry.file_name().to_string_lossy().into_owned();
        let error = match std::fs::metadata(&path) {
            Ok(meta) if meta.len() > MAX_LOCALE_FILE_BYTES => {
                Some(format!("语言包文件过大(上限 {MAX_LOCALE_FILE_BYTES} 字节)"))
            }
            Ok(_) => match std::fs::read_to_string(&path) {
                Ok(raw) => validate_flat_catalog(&raw).err(),
                Err(e) => Some(format!("读取语言包失败:{e}")),
            },
            Err(e) => Some(format!("读取语言包失败:{e}")),
        };
        out.push(LocalesEntry {
            code: code.to_string(),
            file_name,
            error,
        });
    }
    out.sort_by(|a, b| a.code.cmp(&b.code));
    out
}

/// 读取指定语言码的语言包文件;dir 可注入,命令外壳与单测共用
fn read_locale_file(dir: &Path, code: &str) -> Result<Option<String>, String> {
    if !is_valid_lang_code(code) {
        return Err(format!("语言码不合法:{code}"));
    }
    let path = dir.join(format!("{code}.json"));
    let Ok(meta) = std::fs::metadata(&path) else {
        return Ok(None); // 缺失由调用方决定语义(回退内置目录)
    };
    if !meta.is_file() {
        return Ok(None);
    }
    if meta.len() > MAX_LOCALE_FILE_BYTES {
        return Err(format!(
            "语言包文件过大(上限 {MAX_LOCALE_FILE_BYTES} 字节):{code}.json"
        ));
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("读取语言包失败:{e}"))
}

/// locales 目录:%APPDATA%\prompt-vault\locales(与 config.json 同级)
fn locales_dir() -> std::path::PathBuf {
    crate::config_file_path().with_file_name("locales")
}

#[tauri::command]
pub fn i18n_locales() -> Vec<LocalesEntry> {
    scan_locales(&locales_dir())
}

#[tauri::command]
pub fn i18n_locale_file(code: String) -> Result<Option<String>, String> {
    read_locale_file(&locales_dir(), &code)
}

/* ---------- 测试 ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pv-i18n-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lang_code_validation() {
        // 与开工卡正则 ^[a-zA-Z-]{2,12}$ 逐字一致(首尾连字符放行,不参与拼路径之外的场景)
        for ok in ["en", "zh-CN", "pt-BR", "-en", "en-"] {
            assert!(is_valid_lang_code(ok), "「{ok}」应放行");
        }
        for bad in [
            "",
            "a",
            "x".repeat(13).as_str(),
            "zh_CN",
            "zh01",
            "nb-NO-x1",
            "中",
            "en.json",
            "a/b",
            "a\\b",
            "../en",
        ] {
            assert!(!is_valid_lang_code(bad), "「{bad}」应被拒绝");
        }
    }

    #[test]
    fn scan_lists_valid_json_files_only() {
        let dir = temp_dir("scan-ok");
        std::fs::write(dir.join("en.json"), r#"{"a":"A"}"#).unwrap();
        std::fs::write(dir.join("zh-CN.json"), r#"{"a":"甲","b":"乙"}"#).unwrap();
        std::fs::write(dir.join("bad_code.json"), "{}").unwrap(); // 码含下划线 → 跳过
        std::fs::write(dir.join("notes.txt"), "x").unwrap(); // 非 json → 跳过
        std::fs::create_dir_all(dir.join("sub.json")).unwrap(); // 目录伪装 → 跳过

        let entries = scan_locales(&dir);
        let codes: Vec<&str> = entries.iter().map(|e| e.code.as_str()).collect();
        assert_eq!(codes, vec!["en", "zh-CN"], "只应列出合法语言码并按码排序");
        assert!(entries.iter().all(|e| e.error.is_none()));
        assert_eq!(entries[0].file_name, "en.json");
    }

    #[test]
    fn scan_reports_bad_files_without_aborting() {
        let dir = temp_dir("scan-bad");
        std::fs::write(dir.join("en.json"), "not json").unwrap();
        std::fs::write(dir.join("fr.json"), r#"{"a": {"b": "非扁平"}}"#).unwrap();
        std::fs::write(dir.join("de.json"), r#"{"ok": "值", "bad": 42}"#).unwrap();
        std::fs::write(dir.join("it.json"), r#"{"ok": "值"}"#).unwrap();

        let entries = scan_locales(&dir);
        assert_eq!(entries.len(), 4, "坏文件应保留条目并附 error");
        let error_of = |code: &str| {
            entries
                .iter()
                .find(|e| e.code == code)
                .and_then(|e| e.error.clone())
                .unwrap_or_default()
        };
        assert!(error_of("en").contains("JSON"));
        // 嵌套对象:键「a」的值不是字符串
        assert!(error_of("fr").contains("字符串"));
        assert!(error_of("de").contains("字符串"));
        assert_eq!(error_of("it"), "", "好文件无 error");
    }

    #[test]
    fn scan_rejects_oversized_locale_file() {
        let dir = temp_dir("scan-oversize");
        let big = format!("{{\"a\":\"{}\"}}", "x".repeat(1024 * 1024 + 8));
        std::fs::write(dir.join("en.json"), big).unwrap();
        let entries = scan_locales(&dir);
        let en = entries.iter().find(|e| e.code == "en").unwrap();
        assert!(en.error.as_deref().unwrap_or_default().contains("过大"));
    }

    #[test]
    fn read_locale_file_roundtrip_and_missing() {
        let dir = temp_dir("read-ok");
        std::fs::write(dir.join("en.json"), r#"{"app.new":"New"}"#).unwrap();
        assert_eq!(
            read_locale_file(&dir, "en").unwrap().as_deref(),
            Some(r#"{"app.new":"New"}"#)
        );
        // 缺失:None
        assert_eq!(read_locale_file(&dir, "fr").unwrap(), None);
        // 目录不存在视为空
        let missing = std::env::temp_dir().join(format!("pv-i18n-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&missing);
        assert_eq!(scan_locales(&missing).len(), 0);
        assert_eq!(read_locale_file(&missing, "en").unwrap(), None);
    }

    #[test]
    fn read_locale_file_rejects_bad_code_and_oversize() {
        let dir = temp_dir("read-bad");
        // 坏码先被拒绝,不进入文件名拼接
        let err = read_locale_file(&dir, "../evil").unwrap_err();
        assert!(err.contains("不合法"), "{err}");
        // 超限:Err
        let big = format!("{{\"a\":\"{}\"}}", "x".repeat(1024 * 1024 + 8));
        std::fs::write(dir.join("en.json"), big).unwrap();
        let err = read_locale_file(&dir, "en").unwrap_err();
        assert!(err.contains("过大"), "{err}");
    }

    #[test]
    fn flat_catalog_validation_shapes() {
        assert!(validate_flat_catalog(r#"{"a":"x"}"#).is_ok());
        assert!(validate_flat_catalog("{}").is_ok());
        assert!(validate_flat_catalog("[]").is_err(), "数组应被拒绝");
        assert!(validate_flat_catalog(r#"{"a":1}"#).is_err());
        assert!(validate_flat_catalog(r#"{"a":null}"#).is_err());
        assert!(validate_flat_catalog(r#"{"a":{"b":"c"}}"#).is_err());
    }
}
