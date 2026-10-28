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

export interface PathMeta {
  isDir: boolean;
  size: number;
}

/** 拖放前的路径检查:是否目录、文件字节数 */
export const pathMeta = (path: string): Promise<PathMeta | null> =>
  invoke("path_meta", { path });

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
