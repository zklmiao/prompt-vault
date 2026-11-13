//! 数据文件变更监听(GUI 路径):外部写入(如 MCP headless 的 save_prompt)
//! 后向主窗口发 `data-changed`,由前端静默刷新。
//!
//! - notify 监听数据文件所在目录,按事件路径过滤出数据文件本身
//!   (`.tmp` / `.bak` 等旁路文件不触发);
//! - 尾沿防抖 500ms:事件停止 500ms 后才发一次,避免连续写盘触发刷新风暴;
//! - 仅两处挂点:app setup(config.json 已有 data_path)、set_data_path 成功之后;
//! - watcher 保存在 managed state 里,替换数据文件时 drop 旧实例即停止监听,
//!   事件线程随通道关闭自动退出。

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::Duration;

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};

const DEBOUNCE: Duration = Duration::from_millis(500);
/// 与 lib.rs 的 MAIN_LABEL 一致(该常量为本模块私有,避免扩散 GUI 内部逻辑)
const MAIN_LABEL: &str = "main";

/// watcher 保活句柄;drop 即停止监听
pub(crate) struct DataWatchState(Mutex<Option<RecommendedWatcher>>);

fn ensure_state(app: &AppHandle) {
    let _ = app.manage(DataWatchState(Mutex::new(None)));
}

/// 首次启动监听(setup 挂点)
pub(crate) fn start(app: &AppHandle, data_path: PathBuf) {
    ensure_state(app);
    spawn(app, data_path);
}

/// 更换数据文件后重启监听(set_data_path 挂点)
pub(crate) fn restart(app: &AppHandle, data_path: PathBuf) {
    ensure_state(app);
    if let Ok(mut guard) = app.state::<DataWatchState>().0.lock() {
        *guard = None; // drop 旧 watcher → 其事件通道关闭
    }
    spawn(app, data_path);
}

fn spawn(app: &AppHandle, data_path: PathBuf) {
    let Some(parent) = data_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
    else {
        eprintln!("数据文件路径缺少父目录,跳过 watcher:{data_path:?}");
        return;
    };
    // 目录里可能大小写混用,统一小写比较
    let target = data_path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if target.is_empty() {
        return;
    }

    let (tx, rx) = mpsc::channel::<()>();
    let mut watcher = match RecommendedWatcher::new(
        move |res: notify::Result<Event>| {
            if let Ok(event) = res {
                // 只关心数据文件本身;write_atomic 的 .tmp/.bak 不触发
                let hit = event.paths.iter().any(|p| {
                    p.file_name()
                        .map(|n| n.to_string_lossy().to_lowercase())
                        .as_deref()
                        == Some(target.as_str())
                });
                if hit {
                    let _ = tx.send(());
                }
            }
        },
        notify::Config::default(),
    ) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("创建数据文件 watcher 失败:{e}");
            return;
        }
    };
    if let Err(e) = watcher.watch(&parent, RecursiveMode::NonRecursive) {
        eprintln!("监听数据文件目录失败({parent:?}):{e}");
        return;
    }

    let app_thread = app.clone();
    std::thread::spawn(move || {
        loop {
            if rx.recv().is_err() {
                return; // watcher 已被替换/停用
            }
            // 尾沿防抖:持续等 500ms 静默期,期间来新事件则重置窗口
            loop {
                match rx.recv_timeout(DEBOUNCE) {
                    Ok(()) => continue,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            let _ = app_thread.emit_to(MAIN_LABEL, "data-changed", ());
        }
    });

    if let Ok(mut guard) = app.state::<DataWatchState>().0.lock() {
        *guard = Some(watcher);
    }
}
