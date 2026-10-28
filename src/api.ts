import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

export const getDataPath = (): Promise<string | null> =>
  invoke("get_data_path");

export const setDataPath = (path: string): Promise<void> =>
  invoke("set_data_path", { path });

export const readDataFile = (path: string): Promise<string | null> =>
  invoke("read_data", { path });

export const writeDataFile = (path: string, contents: string): Promise<void> =>
  invoke("write_data", { path, contents });

export const firstRunDefaultPath = (): Promise<string> =>
  invoke("first_run_default");

/** 用写前备份(.bak)覆盖损坏的主数据文件;返回是否找到了备份 */
export const restoreBackup = (path: string): Promise<boolean> =>
  invoke("restore_backup", { path });

/**
 * 复制计数 +1 并记录最近复制时间。
 * 读-改-写由 Rust 端全局互斥串行化,双窗口并发调用不会丢计数。
 */
export const bumpCopyStats = (path: string, id: string): Promise<void> =>
  invoke("bump_copy_stats", { path, id });

export interface PathMeta {
  isDir: boolean;
  size: number;
}

/** 拖放前的路径检查:是否目录、文件字节数 */
export const pathMeta = (path: string): Promise<PathMeta | null> =>
  invoke("path_meta", { path });

export interface Hotkeys {
  quickpick: string;
  clipboard_new: string;
}

/** 读取当前全局热键配置 */
export const getHotkeys = (): Promise<Hotkeys> => invoke("get_hotkeys");

/** 更新全局热键;失败(被占用/格式非法)时 Rust 返回可读错误并保持旧键 */
export const setHotkeys = (
  quickpick: string,
  clipboardNew: string,
): Promise<void> => invoke("set_hotkeys", { quickpick, clipboardNew });

export const hideQuickpick = (): Promise<void> =>
  invoke("hide_quickpick");

const JSON_FILTERS = [{ name: "JSON", extensions: ["json"] }];

export const chooseDataFileSave = (defaultPath: string): Promise<string | null> =>
  save({
    title: "选择 Prompt 数据文件保存位置",
    defaultPath,
    filters: JSON_FILTERS,
  });

export const chooseExportFile = (defaultPath: string): Promise<string | null> =>
  save({ title: "导出 Prompt 收藏", defaultPath, filters: JSON_FILTERS });

export const chooseImportFile = (): Promise<string | null> =>
  open({
    multiple: false,
    title: "导入 Prompt 收藏",
    filters: JSON_FILTERS,
  });

export const copyToClipboard = (text: string): Promise<void> =>
  writeText(text);

export const readClipboard = (): Promise<string | null> => readText();
