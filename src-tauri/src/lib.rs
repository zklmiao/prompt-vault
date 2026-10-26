use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
#[serde(default)]
struct WindowRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
#[serde(default)]
struct AppConfig {
    data_path: Option<String>,
    window: Option<WindowRect>,
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

/// 先把旧文件留作 .bak,写临时文件并 sync 落盘,再原子替换,
/// 任意时刻目标路径上要么是旧内容要么是新内容,不存在空窗
#[tauri::command]
fn write_data(path: String, contents: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if p.exists() {
        fs::copy(&p, format!("{}.bak", path)).map_err(|e| e.to_string())?;
    }
    let tmp = PathBuf::from(format!("{}.tmp", path));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(contents.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    replace_file(&tmp, &p).map_err(|e| e.to_string())
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
    // 全局快捷键:Alt+Q 快速拾取;Alt+Shift+N 从剪贴板新建
    let sc_quickpick: Shortcut = "alt+q".parse().expect("parse shortcut alt+q");
    let sc_clipboard: Shortcut = "alt+shift+n".parse().expect("parse shortcut alt+shift+n");
    let sc_quickpick_match = sc_quickpick.clone();
    let sc_clipboard_match = sc_clipboard.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 二次启动:唤起已有主窗口
            show_main_window(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &sc_quickpick_match {
                        toggle_quickpick(app);
                    } else if shortcut == &sc_clipboard_match {
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
            read_data,
            write_data,
            restore_backup,
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

            // 注册全局快捷键
            #[cfg(desktop)]
            {
                let gs = app.global_shortcut();
                gs.register(sc_quickpick).map_err(|e| e.to_string())?;
                gs.register(sc_clipboard).map_err(|e| e.to_string())?;
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
