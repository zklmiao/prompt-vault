// 插件系统 Tauri 命令封装(与 src/plugins/types.ts、src-tauri/src/plugins.rs 对应)

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type {
  PluginManifest,
  PvNetOpts,
  PvNetResponse,
  SourceManifest,
} from "./types";

export interface FetchSourceArgs {
  provider: string;
  owner: string;
  repo: string;
  branch?: string | null;
  host?: string | null;
}

export const fetchSource = (args: FetchSourceArgs): Promise<SourceManifest> =>
  invoke("plugin_fetch_source", { ...args });

export interface InstallArgs {
  url: string;
  sha256: string;
  channel: "release" | "beta";
  expectId: string;
  expectVersion: string;
}

export const installPlugin = (args: InstallArgs): Promise<Record<string, unknown>> =>
  invoke("plugin_install", { ...args });

export const uninstallPlugin = (id: string): Promise<void> =>
  invoke("plugin_uninstall", { id });

export const readPluginsState = (): Promise<string> => invoke("plugin_read_state");

export const writePluginsState = (json: string): Promise<void> =>
  invoke("plugin_write_state", { json });

export const kvGet = (pluginId: string, key: string): Promise<unknown> =>
  invoke("plugin_kv_get", { pluginId, key });

export const kvSet = (pluginId: string, key: string, value: unknown): Promise<void> =>
  invoke("plugin_kv_set", { pluginId, key, value });

/** 当前启用版本 main.js 的绝对路径;i18n 型/未安装返回 null */
export const pluginEntryPath = (id: string): Promise<string | null> =>
  invoke("plugin_entry_path", { pluginId: id });

export const pluginInstalledManifest = (id: string): Promise<PluginManifest | null> =>
  invoke("plugin_installed_manifest", { pluginId: id });

export const pluginOpenWindow = (
  id: string,
  size?: { width: number; height: number },
): Promise<void> =>
  invoke("plugin_open_window", {
    pluginId: id,
    width: size?.width,
    height: size?.height,
  });

export const pluginCloseWindow = (id: string): Promise<void> =>
  invoke("plugin_close_window", { pluginId: id });

/** 文件路径 → asset 协议 URL(插件 main.js 经此注入;浏览器预览由 mock 提供) */
export const toAssetUrl = (filePath: string): string =>
  convertFileSrc(filePath);

/** 插件联网一律走 Rust 代理(权限白名单 + SSRF 在 Rust 侧) */
export const pluginNetFetch = (
  pluginId: string,
  url: string,
  opts?: PvNetOpts,
): Promise<PvNetResponse> => invoke("plugin_net_fetch", { pluginId, url, opts });
