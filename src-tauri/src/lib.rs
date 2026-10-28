use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// 首次启动时建议的数据文件位置(按共识默认指向工程内 data 目录)
const DEFAULT_DATA_PATH: &str = r"E:\Agent\Proj\prompt-vault\data\prompts.json";
const MAIN_LABEL: &str = "main";
const QUICKPICK_LABEL: &str = "quickpick";
const QUICKPICK_WIDTH: f64 = 680.0;
const QUICKPICK_HEIGHT: f64 = 470.0;
const DEFAULT_HOTKEY_QUICKPICK: &str = "alt+q";
const DEFAULT_HOTKEY_CLIPBOARD: &str = "alt+shift+n";

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
#[serde(default)]
struct WindowRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

/// 全局热键配置;字段缺省时用 Default 的默认组合键
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(default)]
struct HotkeyConfig {
    quickpick: String,
    clipboard_new: String,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            quickpick: DEFAULT_HOTKEY_QUICKPICK.to_string(),
            clipboard_new: DEFAULT_HOTKEY_CLIPBOARD.to_string(),
        }
    }
}

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
#[serde(default)]
struct AppConfig {
    data_path: Option<String>,
    window: Option<WindowRect>,
    hotkeys: Option<HotkeyConfig>,
}

fn config_file_path() -> PathBuf {
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .or_else(|_| {
            std::env::var("USERPROFILE")
                .map(|h| PathBuf::from(h).join("AppData").join("Roaming"))
        })
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("prompt-vault").join("config.json")
}

fn read_config() -> AppConfig {
    fs::read_to_string(config_file_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_config(cfg: &AppConfig) -> Result<(), String> {
    let path = config_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn save_main_window_state(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        return;
    };
    let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else {
        return;
    };
    let mut cfg = read_config();
    cfg.window = Some(WindowRect {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    });
    if let Err(e) = write_config(&cfg) {
        eprintln!("save window state failed: {e}");
    }
}

fn ensure_quickpick(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(w) = app.get_webview_window(QUICKPICK_LABEL) {
        return Ok(w);
    }
    let mut builder = WebviewWindowBuilder::new(app, QUICKPICK_LABEL, WebviewUrl::default())
        .title("Prompt Vault Quick Pick")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(true)
        .inner_size(QUICKPICK_WIDTH, QUICKPICK_HEIGHT);
    // 屏幕顶部居中,主显示器
    if let Ok(Some(monitor)) = app.primary_monitor() {
        let scale = monitor.scale_factor();
        let mpos = monitor.position().to_logical::<f64>(scale);
        let msize = monitor.size().to_logical::<f64>(scale);
        let x = mpos.x + (msize.width - QUICKPICK_WIDTH) / 2.0;
        let y = mpos.y + 120.0;
        builder = builder.position(x, y);
    }
    builder.build()
}

fn show_quickpick(app: &AppHandle) {
    let window = match app.get_webview_window(QUICKPICK_LABEL) {
        Some(w) => w,
        None => match ensure_quickpick(app) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("create quickpick failed: {e}");
                return;
            }
        },
    };
    let _ = window.show();
    let _ = window.set_focus();
    // 通知前端清空输入并聚焦
    let _ = app.emit_to(QUICKPICK_LABEL, "quickpick-shown", ());
}

fn toggle_quickpick(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(QUICKPICK_LABEL) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            return;
        }
    }
    show_quickpick(app);
}

/// 全局热键:从剪贴板新建(唤起主窗口并预填)
fn clipboard_new(app: &AppHandle) {
    show_main_window(app);
    let text = app.clipboard().read_text().ok();
    let _ = app.emit_to(MAIN_LABEL, "clipboard-new", text);
}

static FIRST_HIDE_TOASTED: AtomicBool = AtomicBool::new(false);

/// 当前生效的全局热键(快速拾取, 剪贴板新建)。
/// 用全局状态而非闭包捕获,配置修改后才能立即对事件分发生效。
static ACTIVE_HOTKEYS: Mutex<Option<(Shortcut, Shortcut)>> = Mutex::new(None);

fn parse_hotkey(input: &str, label: &str) -> Result<Shortcut, String> {
    input.parse::<Shortcut>().map_err(|_| {
        format!("「{input}」不是有效的组合键({label}示例:alt+q、ctrl+shift+space)")
    })
}

/// 把已注册热键恢复成给定的一组;失败静默(尽力回滚)
fn restore_hotkeys(app: &AppHandle, old: Option<&(Shortcut, Shortcut)>) {
    if let Some((old_quickpick, old_clipboard)) = old {
        let gs = app.global_shortcut();
        let _ = gs.register(old_quickpick.clone());
        let _ = gs.register(old_clipboard.clone());
    }
}

/// 注册一组新热键:先注销旧的,新键任一失败则回滚到旧键。
/// 成功后才更新 ACTIVE_HOTKEYS。
fn register_hotkeys(
    app: &AppHandle,
    quickpick: &str,
    clipboard_new: &str,
) -> Result<(), String> {
    let new_quickpick = parse_hotkey(quickpick, "快速拾取")?;
    let new_clipboard = parse_hotkey(clipboard_new, "剪贴板新建")?;

    let old = ACTIVE_HOTKEYS.lock().ok().and_then(|guard| guard.clone());
    let gs = app.global_shortcut();
    if let Some((old_quickpick, old_clipboard)) = &old {
        let _ = gs.unregister(old_quickpick.clone());
        let _ = gs.unregister(old_clipboard.clone());
    }

    if gs.register(new_quickpick.clone()).is_err() {
        restore_hotkeys(app, old.as_ref());
        return Err(format!(
            "「{quickpick}」无法注册,可能已被系统或其他应用占用"
        ));
    }
    if gs.register(new_clipboard.clone()).is_err() {
        let _ = gs.unregister(new_quickpick.clone());
        restore_hotkeys(app, old.as_ref());
        return Err(format!(
            "「{clipboard_new}」无法注册,可能已被系统或其他应用占用"
        ));
    }

    if let Ok(mut guard) = ACTIVE_HOTKEYS.lock() {
        *guard = Some((new_quickpick, new_clipboard));
    }
    Ok(())
}

#[tauri::command]
fn get_data_path() -> Option<String> {
    read_config().data_path
}

#[tauri::command]
fn set_data_path(path: String) -> Result<(), String> {
    let mut cfg = read_config();
    cfg.data_path = Some(path);
    write_config(&cfg)
}

/// 返回当前热键配置;配置文件里损坏(无法解析)时回退默认值
#[tauri::command]
fn get_hotkeys() -> HotkeyConfig {
    let cfg = read_config().hotkeys.unwrap_or_default();
    let valid = cfg.quickpick.parse::<Shortcut>().is_ok()
        && cfg.clipboard_new.parse::<Shortcut>().is_ok();
    if valid {
        cfg
    } else {
        HotkeyConfig::default()
    }
}

/// 更新全局热键:解析 → 注销旧键 → 注册新键(失败回滚)→ 落盘配置
#[tauri::command]
fn set_hotkeys(
    app: AppHandle,
    quickpick: String,
    clipboard_new: String,
) -> Result<(), String> {
    let quickpick = quickpick.trim().to_lowercase();
    let clipboard_new = clipboard_new.trim().to_lowercase();
    if quickpick.is_empty() || clipboard_new.is_empty() {
        return Err("组合键不能为空".to_string());
    }
    if quickpick == clipboard_new {
        return Err("两个功能不能使用同一组合键".to_string());
    }
    // 先验证解析,再动已注册的键
    let _ = parse_hotkey(&quickpick, "快速拾取")?;
    let _ = parse_hotkey(&clipboard_new, "剪贴板新建")?;

    let previous = read_config().hotkeys.unwrap_or_default();
    register_hotkeys(&app, &quickpick, &clipboard_new)?;

    let mut cfg = read_config();
    cfg.hotkeys = Some(HotkeyConfig {
        quickpick: quickpick.clone(),
        clipboard_new: clipboard_new.clone(),
    });
    if let Err(e) = write_config(&cfg) {
        // 配置没落盘就回滚,避免"重启后又变回去"的困惑
        let _ = register_hotkeys(&app, &previous.quickpick, &previous.clipboard_new);
        return Err(format!("热键已切换但保存配置失败:{e}(已回滚)"));
    }
    Ok(())
}

/// 读取数据文件;损坏或缺失时不做任何回退,
/// 由前端进入错误界面暂停读写,避免用陈旧 .bak 静默覆盖真实数据
#[tauri::command]
fn read_data(path: String) -> Option<String> {
    fs::read_to_string(&path).ok()
}

/// Windows 上用 MoveFileExW(REPLACE_EXISTING) 原子替换目标文件;
/// POSIX 的 rename 本身就是原子替换
#[cfg(windows)]
fn replace_file(tmp: &Path, dest: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(
            lpexistingfilename: *const u16,
            lpnewfilename: *const u16,
            dwflags: u32,
        ) -> i32;
    }
    let tmp_w: Vec<u16> = tmp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let dest_w: Vec<u16> = dest
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let ok = unsafe { MoveFileExW(tmp_w.as_ptr(), dest_w.as_ptr(), MOVEFILE_REPLACE_EXISTING) };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn replace_file(tmp: &Path, dest: &Path) -> std::io::Result<()> {
    fs::rename(tmp, dest)
}

/// epoch 秒 → UTC ISO-8601(毫秒位固定 .000Z),零第三方依赖。
/// 公历换算使用 Howard Hinnant 的 civil_from_days 算法。
fn iso_from_epoch_secs(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hh, mm, ss) = (rem / 3_600, (rem % 3_600) / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.000Z")
}

fn now_iso_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    iso_from_epoch_secs(secs)
}

/// 原子写入实现:目录 → .bak 备份 → 临时文件 sync → 原地替换
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let p = PathBuf::from(path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if p.exists() {
        fs::copy(&p, format!("{}.bak", p.display())).map_err(|e| e.to_string())?;
    }
    let tmp = PathBuf::from(format!("{}.tmp", p.display()));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(contents.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    replace_file(&tmp, &p).map_err(|e| e.to_string())
}

/// 先把旧文件留作 .bak,写临时文件并 sync 落盘,再原子替换,
/// 任意时刻目标路径上要么是旧内容要么是新内容,不存在空窗
#[tauri::command]
fn write_data(path: String, contents: String) -> Result<(), String> {
    write_atomic(Path::new(&path), &contents)
}

/// 串行化统计的"读-改-写",避免主窗口与快速拾取同时复制时丢计数
static STATS_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 纯函数:在数据文件 JSON 文本里给指定 id 的 prompt 计数 +1。
/// 其他字段与键顺序保持不变(preserve_order),未知 id / 结构异常返回 Err。
fn bump_prompt_stats_in_json(raw: &str, id: &str, copied_at: &str) -> Result<String, String> {
    let mut value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| e.to_string())?;
    let prompts = value
        .get_mut("prompts")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "数据格式不正确".to_string())?;
    let item = prompts
        .iter_mut()
        .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(id))
        .ok_or_else(|| "记录不存在".to_string())?;
    let count = item
        .get("copyCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
        + 1;
    let obj = item
        .as_object_mut()
        .ok_or_else(|| "记录格式不正确".to_string())?;
    obj.insert("copyCount".to_string(), serde_json::json!(count));
    obj.insert(
        "lastCopiedAt".to_string(),
        serde_json::json!(copied_at),
    );
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

/// 复制统计:copyCount+1、lastCopiedAt=now,原子写回后通知主窗口刷新。
/// 任何失败都返回 Err,由前端静默忽略(复制本身已经成功)。
#[tauri::command]
fn bump_copy_stats(app: AppHandle, path: String, id: String) -> Result<(), String> {
    let _guard = STATS_WRITE_LOCK
        .lock()
        .map_err(|_| "统计写入锁不可用".to_string())?;
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let contents = bump_prompt_stats_in_json(&raw, &id, &now_iso_utc())?;
    write_atomic(Path::new(&path), &contents)?;
    let _ = app.emit_to(MAIN_LABEL, "stats-changed", ());
    Ok(())
}

/// 用写前备份覆盖主数据文件;返回是否找到了备份
#[tauri::command]
fn restore_backup(path: String) -> Result<bool, String> {
    let bak = PathBuf::from(format!("{}.bak", path));
    if !bak.exists() {
        return Ok(false);
    }
    fs::copy(&bak, &path).map_err(|e| e.to_string())?;
    Ok(true)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PathMeta {
    is_dir: bool,
    size: u64,
}

/// 拖放前的路径检查:目录与文件大小,避免把超大文件读进内存
#[tauri::command]
fn path_meta(path: String) -> Option<PathMeta> {
    let md = fs::metadata(&path).ok()?;
    Some(PathMeta {
        is_dir: md.is_dir(),
        size: md.len(),
    })
}

/// 首次启动给保存对话框的建议路径,并尽量预创建目录
#[tauri::command]
fn first_run_default() -> String {
    let p = PathBuf::from(DEFAULT_DATA_PATH);
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    DEFAULT_DATA_PATH.to_string()
}

#[tauri::command]
fn hide_quickpick(app: AppHandle) {
    if let Some(w) = app.get_webview_window(QUICKPICK_LABEL) {
        let _ = w.hide();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次启动:唤起已有主窗口
            show_main_window(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    // 每次按键都读当前生效的组合键,设置修改后立即生效
                    let pair = ACTIVE_HOTKEYS
                        .lock()
                        .ok()
                        .and_then(|guard| guard.clone());
                    let Some((quickpick_shortcut, clipboard_shortcut)) = pair else {
                        return;
                    };
                    if shortcut == &quickpick_shortcut {
                        toggle_quickpick(app);
                    } else if shortcut == &clipboard_shortcut {
                        clipboard_new(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_data_path,
            set_data_path,
            get_hotkeys,
            set_hotkeys,
            read_data,
            write_data,
            restore_backup,
            path_meta,
            bump_copy_stats,
            first_run_default,
            hide_quickpick
        ])
        .setup(move |app| {
            // 恢复上次记住的主窗口位置与大小
            let cfg = read_config();
            if let (Some(window), Some(wr)) = (app.get_webview_window(MAIN_LABEL), cfg.window) {
                if wr.width >= 400 && wr.height >= 300 {
                    let _ = window.set_position(PhysicalPosition::new(wr.x, wr.y));
                    let _ = window.set_size(PhysicalSize::new(wr.width, wr.height));
                }
            }

            // 注册全局快捷键:配置优先,解析/注册失败回退默认并自愈配置
            #[cfg(desktop)]
            {
                let configured = read_config().hotkeys.unwrap_or_default();
                if let Err(err) = register_hotkeys(
                    app.handle(),
                    &configured.quickpick,
                    &configured.clipboard_new,
                ) {
                    eprintln!("热键注册失败:{err};尝试回退默认值");
                    let defaults = HotkeyConfig::default();
                    let differs = configured.quickpick != defaults.quickpick
                        || configured.clipboard_new != defaults.clipboard_new;
                    if differs
                        && register_hotkeys(
                            app.handle(),
                            &defaults.quickpick,
                            &defaults.clipboard_new,
                        )
                        .is_ok()
                    {
                        let mut cfg = read_config();
                        cfg.hotkeys = Some(defaults);
                        if let Err(e) = write_config(&cfg) {
                            eprintln!("写回默认热键配置失败:{e}");
                        }
                    }
                }
            }

            // 系统托盘
            let show_item = MenuItem::with_id(app, "show", "打开主窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Prompt Vault")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => {
                        save_main_window_state(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window(MAIN_LABEL) {
                            let visible = window.is_visible().unwrap_or(false);
                            let focused = window.is_focused().unwrap_or(false);
                            if visible && focused {
                                let _ = window.hide();
                            } else {
                                show_main_window(app);
                            }
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } if window.label() == MAIN_LABEL => {
                // 点 ✕ 隐藏到托盘,不退出;退出走托盘菜单
                let _ = window.hide();
                api.prevent_close();
                if !FIRST_HIDE_TOASTED.swap(true, Ordering::Relaxed) {
                    let _ = window.app_handle().emit_to(MAIN_LABEL, "hidden-to-tray", ());
                }
            }
            // 快速拾取窗口失焦即隐藏
            WindowEvent::Focused(false) if window.label() == QUICKPICK_LABEL => {
                let _ = window.hide();
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{bump_prompt_stats_in_json, iso_from_epoch_secs};

    const SAMPLE: &str = r#"{
  "version": 1,
  "prompts": [
    {
      "id": "a",
      "title": "审查",
      "body": "{{diff}}",
      "tags": ["编码"],
      "pinned": true,
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-24T02:10:00.000Z"
    },
    {
      "id": "b",
      "title": "翻译",
      "body": "{{text}}",
      "tags": [],
      "pinned": false,
      "createdAt": "2026-10-18T09:00:00.000Z",
      "updatedAt": "2026-10-22T08:00:00.000Z",
      "copyCount": 4,
      "lastCopiedAt": "2026-10-26T03:40:00.000Z"
    }
  ]
}"#;

    #[test]
    fn iso_from_epoch_matches_known_dates() {
        assert_eq!(iso_from_epoch_secs(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            iso_from_epoch_secs(1_700_000_000),
            "2023-11-14T22:13:20.000Z"
        );
        assert_eq!(
            iso_from_epoch_secs(1_767_225_599),
            "2025-12-31T23:59:59.000Z"
        );
        assert_eq!(
            iso_from_epoch_secs(1_709_164_800),
            "2024-02-29T00:00:00.000Z"
        );
    }

    #[test]
    fn bump_creates_stats_on_first_copy() {
        let out = bump_prompt_stats_in_json(SAMPLE, "a", "2026-10-28T12:00:00.000Z")
            .expect("bump should succeed");
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        let item = &value["prompts"][0];
        assert_eq!(item["copyCount"], 1);
        assert_eq!(item["lastCopiedAt"], "2026-10-28T12:00:00.000Z");
        // 其他记录不受影响;原有字段保留
        assert_eq!(value["prompts"][1]["copyCount"], 4);
        assert_eq!(item["title"], "审查");
        assert_eq!(item["pinned"], true);
        assert_eq!(item["body"], "{{diff}}");
    }

    #[test]
    fn bump_increments_existing_count() {
        let out = bump_prompt_stats_in_json(SAMPLE, "b", "2026-10-28T12:00:00.000Z")
            .expect("bump should succeed");
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value["prompts"][1]["copyCount"], 5);
        assert_eq!(
            value["prompts"][1]["lastCopiedAt"],
            "2026-10-28T12:00:00.000Z"
        );
        // 无统计字段的记录不应被凭空创建计数
        assert!(value["prompts"][0].get("copyCount").is_none());
    }

    #[test]
    fn bump_rejects_unknown_id_and_bad_json() {
        assert!(bump_prompt_stats_in_json(SAMPLE, "missing", "t").is_err());
        assert!(bump_prompt_stats_in_json("not json", "a", "t").is_err());
        assert!(bump_prompt_stats_in_json(r#"{"prompts": {}}"#, "a", "t").is_err());
    }
}

#[cfg(test)]
mod hotkey_parse_tests {
    use tauri_plugin_global_shortcut::Shortcut;

    fn parses(s: &str) -> bool {
        s.parse::<Shortcut>().is_ok()
    }

    #[test]
    fn defaults_parse() {
        assert!(parses(super::DEFAULT_HOTKEY_QUICKPICK));
        assert!(parses(super::DEFAULT_HOTKEY_CLIPBOARD));
        // 大小写不敏感
        assert!(parses("Alt+Q"));
        assert!(parses("ALT+SHIFT+N"));
    }

    #[test]
    fn frontend_token_forms_parse() {
        // 前端捕获器可能产出的全部形态(与 src/components/SettingsModal.tsx 的映射保持一致)
        let cases = [
            "ctrl+q",
            "ctrl+shift+q",
            "ctrl+alt+q",
            "ctrl+alt+shift+q",
            "super+q",
            "alt+1",
            "ctrl+shift+0",
            "alt+f1",
            "ctrl+f12",
            "alt+space",
            "alt+arrowup",
            "alt+arrowdown",
            "alt+arrowleft",
            "alt+arrowright",
        ];
        let rejected: Vec<&str> = cases.iter().copied().filter(|s| !parses(s)).collect();
        assert!(rejected.is_empty(), "解析失败的组合键: {rejected:?}");
    }

    #[test]
    fn garbage_is_rejected() {
        for bad in ["", "alt+", "+q", "notakey", "alt+ctrl+"] {
            assert!(!parses(bad), "「{bad}」不应被接受");
        }
    }
}
