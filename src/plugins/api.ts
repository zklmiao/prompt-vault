// 插件系统 Tauri 命令封装(与 src/plugins/types.ts、src-tauri/src/plugins.rs 对应)

import { invoke } from "@tauri-apps/api/core";
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

/** 读取当前版本目录下的包内文件(main.js / 语言包 <码>.json);缺失返回 null */
export const pluginReadEntry = (id: string, relPath: string): Promise<string | null> =>
  invoke("plugin_read_entry", { pluginId: id, relPath });

export const pluginInstalledManifest = (id: string): Promise<PluginManifest | null> =>
  invoke("plugin_installed_manifest", { pluginId: id });

export const pluginOpenWindow = (
  id: string,
  size?: { width: number; height: number },
  pos?: { x?: number; y?: number },
): Promise<void> =>
  invoke("plugin_open_window", {
    pluginId: id,
    width: size?.width,
    height: size?.height,
    x: pos?.x,
    y: pos?.y,
  });

export const pluginCloseWindow = (id: string): Promise<void> =>
  invoke("plugin_close_window", { pluginId: id });

/** 球窗唤出主窗口并激活插件详情面板(跨窗口事件 pv-open-plugin-panel) */
export const pluginShowMainPanel = (id: string): Promise<void> =>
  invoke("plugin_show_main_panel", { pluginId: id });

/** 调整插件窗口尺寸(逻辑像素;球窗右键菜单临时扩窗用,收起后由插件恢复) */
export const pluginResizeWindow = (
  id: string,
  width: number,
  height: number,
): Promise<void> =>
  invoke("plugin_resize_window", { pluginId: id, width, height });

/* ---------- 凭据(桥面 credentials 通道;读取不存在任何命令) ---------- */

export const pluginCredentialSet = (scope: string, secret: string): Promise<void> =>
  invoke("plugin_credential_set", { scope, secret });

export const pluginCredentialDelete = (scope: string): Promise<void> =>
  invoke("plugin_credential_delete", { scope });

/** scope 凭据是否已配置(env 或 keyring;不含任何秘密值) */
export const pluginCredentialConfigured = (scope: string): Promise<boolean> =>
  invoke("plugin_credential_configured", { scope });

/** 插件联网一律走 Rust 代理(权限白名单 + SSRF 在 Rust 侧) */
export const pluginNetFetch = (
  pluginId: string,
  url: string,
  opts?: PvNetOpts,
): Promise<PvNetResponse> => invoke("plugin_net_fetch", { pluginId, url, opts });
