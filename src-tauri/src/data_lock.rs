//! 数据文件跨进程命名互斥:GUI 主窗口 / 快速拾取 / MCP headless 三方并发写同一
//! JSON 文件,进程内的 STATS_WRITE_LOCK 管不到跨进程,这里用 Win32 命名互斥体
//! `Global\prompt-vault-data-<sha256(小写路径)前 8 位>` 把写路径串行化。
//!
//! - 等待超时 5 秒,超时报错而不是无限卡死;
//! - 同线程重入安全(Win32 互斥体按线程递归计数),因此 save_prompt 在外层
//!   持锁后再调 write_atomic(内部再次加锁)不会自锁;
//! - WAIT_ABANDONED 视为获取成功:前一持有者可能已崩溃,但写盘走原子替换,
//!   文件内容要么是旧的要么是新的,继续执行是安全的。

use std::path::Path;

use sha2::{Digest, Sha256};

/// 默认等待超时(毫秒)
pub const LOCK_TIMEOUT_MS: u32 = 5_000;

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};

    // WaitForSingleObject 返回值( Win32 文档常量)
    pub const WAIT_OBJECT_0: u32 = 0x0000_0000;
    pub const WAIT_ABANDONED: u32 = 0x0000_0080;
    pub const WAIT_TIMEOUT: u32 = 0x0000_0102;

    pub(super) struct NamedMutex(HANDLE);

    impl NamedMutex {
        /// 创建/打开命名互斥体并等待持有;超时或系统错误返回 Err。
        pub fn acquire(name_wide: &[u16], timeout_ms: u32) -> Result<NamedMutex, String> {
            let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name_wide.as_ptr()) };
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                return Err(format!(
                    "创建数据文件互斥体失败:{}",
                    std::io::Error::last_os_error()
                ));
            }
            match unsafe { WaitForSingleObject(handle, timeout_ms) } {
                WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(NamedMutex(handle)),
                WAIT_TIMEOUT => {
                    unsafe { CloseHandle(handle) };
                    Err("等待数据文件互斥体超时,可能有其他 Prompt Vault 进程正在写入".to_string())
                }
                state => {
                    unsafe { CloseHandle(handle) };
                    Err(format!(
                        "等待数据文件互斥体失败(state={state}):{}",
                        std::io::Error::last_os_error()
                    ))
                }
            }
        }
    }

    impl Drop for NamedMutex {
        fn drop(&mut self) {
            unsafe {
                ReleaseMutex(self.0);
                CloseHandle(self.0);
            }
        }
    }
}

/// 互斥体名(不含 Global\ 前缀):sha256(小写路径) 前 8 位 hex,
/// Windows 路径大小写不敏感,统一小写保证不同写法命中同一把锁
pub(crate) fn mutex_name_for_path(path: &Path) -> String {
    let lower = path.to_string_lossy().to_lowercase();
    format!("prompt-vault-data-{}", sha256_hex_prefix8(lower.as_bytes()))
}

fn sha256_hex_prefix8(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(8);
    for b in digest.iter().take(4) {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// 持锁执行 f:返回 f 的结果;获取锁失败返回 Err(数据未被改动)
pub(crate) fn with_data_lock<T>(
    path: &Path,
    f: impl FnOnce() -> T,
) -> Result<T, String> {
    with_data_lock_timeout(path, LOCK_TIMEOUT_MS, f)
}

pub(crate) fn with_data_lock_timeout<T>(
    path: &Path,
    timeout_ms: u32,
    f: impl FnOnce() -> T,
) -> Result<T, String> {
    #[cfg(windows)]
    {
        let name = format!("Global\\{}", mutex_name_for_path(path));
        let mut name_wide: Vec<u16> = name.encode_utf16().collect();
        name_wide.push(0);
        let _guard = win::NamedMutex::acquire(&name_wide, timeout_ms)?;
        Ok(f())
    }
    #[cfg(not(windows))]
    {
        // 非 Windows 仅本进程内(项目仅发布 Windows 版,保留编译兼容)
        let _ = (path, timeout_ms);
        Ok(f())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Duration;

    fn temp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pv-lock-test-{}-{}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::create_dir_all(&dir);
        dir.join("data.json")
    }

    #[test]
    fn mutex_name_is_sha256_prefix_of_lowercased_path() {
        // 已知向量:sha256("abc") = ba7816bf8f01cfea…
        assert_eq!(mutex_name_for_path(Path::new("abc")), "prompt-vault-data-ba7816bf");
        // 大小写不敏感:同一文件的不同写法必须命中同一把锁
        let a = mutex_name_for_path(Path::new(r"C:\Data\PROMPTS.JSON"));
        let b = mutex_name_for_path(Path::new(r"c:\data\prompts.json"));
        assert_eq!(a, b);
        let name = a;
        assert_eq!(name.len(), "prompt-vault-data-".len() + 8);
        let hex = &name["prompt-vault-data-".len()..];
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn nested_same_thread_reacquire_is_recursive() {
        let path = temp_path("nested");
        // 外层持有 + 内层同线程再获取:Win32 互斥体递归计数,不应超时
        let outer = with_data_lock_timeout(&path, 100, || {
            let inner = with_data_lock_timeout(&path, 100, || 42);
            assert_eq!(inner.unwrap(), 42);
            "outer-ok"
        });
        assert_eq!(outer.unwrap(), "outer-ok");
    }

    #[test]
    fn other_thread_is_blocked_until_timeout_then_succeeds_after_release() {
        let path = temp_path("contention");
        let path2 = path.clone();
        let (tx, rx) = mpsc::channel::<()>();
        let holder = std::thread::spawn(move || {
            with_data_lock_timeout(&path2, 5_000, || {
                tx.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(300));
                7
            })
            .unwrap()
        });
        rx.recv().unwrap(); // 持有方已拿到锁

        let r = with_data_lock_timeout(&path, 50, || panic!("不应在持有期间获得锁"));
        assert!(r.is_err(), "另一线程持锁时应超时失败");
        assert!(r.unwrap_err().contains("超时"));

        assert_eq!(holder.join().unwrap(), 7);
        // 释放后可重新获取
        let after = with_data_lock_timeout(&path, 5_000, || "ok");
        assert_eq!(after.unwrap(), "ok");
    }
}
