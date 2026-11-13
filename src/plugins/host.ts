// 插件宿主:启动注入引擎与 plugins.json 状态的读写纠偏(前端侧)。
// 注入模型(设计 §2.3/§2.4):主窗口就绪后按 plugins.json 的 enabled 顺序,
// 经 convertFileSrc(asset 协议)注入 <script>;单插件 onload 后 3s 内未注册
// 即标记 error 并 toast,失败隔离,不影响其他插件与主窗口。

import { pluginEntryPath, pluginInstalledManifest, readPluginsState, toAssetUrl, writePluginsState } from "./api";
import { createBridge } from "./bridge";
import { hasRegistered, pluginCommands, resetRegistry } from "./registry";
import type { PluginPaletteCommand } from "./palette";
import type { InstalledEntry, PluginsState, SourceConfig } from "./types";

/** 注册超时:脚本 onload 后 3s 内未调用任何 pv.* 注册 → 标记 error */
const REGISTER_TIMEOUT_MS = 3000;

export interface HostHooks {
  showToast(text: string, kind?: "ok" | "err"): void;
  /** 注册表变化(注入完成后)通知宿主刷新命令面板 */
  onCommandsChanged(): void;
}

/* ---------- plugins.json 状态纠偏(新字段可选,兼容旧数据) ---------- */

function coerceEntry(raw: unknown): InstalledEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.version !== "string") return null;
  const permissions = Array.isArray(v.permissions)
    ? v.permissions.filter((p): p is string => typeof p === "string")
    : [];
  return {
    version: v.version,
    channel: v.channel === "beta" ? "beta" : "release",
    enabled: v.enabled === true,
    sha256: typeof v.sha256 === "string" ? v.sha256 : "",
    installedAt: typeof v.installedAt === "string" ? v.installedAt : "",
    error: typeof v.error === "string" ? v.error : null,
    permissions,
  };
}

export function coercePluginsState(raw: string): PluginsState {
  const v: unknown = JSON.parse(raw);
  if (typeof v !== "object" || v === null) throw new Error("plugins.json 结构不正确");
  const obj = v as Record<string, unknown>;
  const installed: Record<string, InstalledEntry> = {};
  if (typeof obj.installed === "object" && obj.installed !== null) {
    for (const [id, entry] of Object.entries(obj.installed)) {
      const coerced = coerceEntry(entry);
      if (coerced) installed[id] = coerced;
    }
  }
  const sources: SourceConfig[] = Array.isArray(obj.sources)
    ? (obj.sources.filter(
        (s): s is SourceConfig =>
          typeof s === "object" &&
          s !== null &&
          typeof (s as SourceConfig).id === "string" &&
          typeof (s as SourceConfig).url === "string",
      ))
    : [];
  return {
    version: typeof obj.version === "number" ? obj.version : 1,
    sources,
    activeSourceId:
      typeof obj.activeSourceId === "string" ? obj.activeSourceId : null,
    installed,
    mcp: { enabled: (obj.mcp as { enabled?: unknown } | undefined)?.enabled === true },
  };
}

export async function loadPluginsState(): Promise<PluginsState> {
  const raw = await readPluginsState();
  return coercePluginsState(raw);
}

/** 状态写盘:透传序列化字符串,Rust 端做契约校验 */
export async function savePluginsState(state: PluginsState): Promise<void> {
  await writePluginsState(JSON.stringify(state, null, 2));
}

/* ---------- 注入引擎 ---------- */

function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = url;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("插件脚本加载失败(asset 协议拒绝或文件缺失)"));
    document.head.appendChild(el);
  });
}

async function waitForRegistration(pluginId: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < REGISTER_TIMEOUT_MS) {
    if (hasRegistered(pluginId)) return true;
    await new Promise((r) => window.setTimeout(r, 100));
  }
  return hasRegistered(pluginId);
}

/** 注入单个插件(安装/启用后即插即用也走这里);失败抛错由调用方隔离 */
export async function injectOne(pluginId: string): Promise<void> {
  const manifest = await pluginInstalledManifest(pluginId).catch(() => null);
  if (manifest && manifest.type === "i18n") return; // 语言包无脚本,批次1仅入库
  const path = await pluginEntryPath(pluginId).catch(() => null);
  if (!path) {
    throw new Error("未找到当前版本的 main.js(插件文件缺失)");
  }
  // 经典 script 注入:先把桥绑定到该插件,再加载脚本
  window.pv = createBridge(pluginId);
  await loadScript(toAssetUrl(path));
  if (!hasRegistered(pluginId)) {
    const ok = await waitForRegistration(pluginId);
    if (!ok) {
      throw new Error("加载超时:插件 3 秒内未调用任何 pv.* 注册");
    }
  }
}

/** 把错误写回 plugins.json 的 installed[id].error(UI 展示错误态用) */
export async function markPluginError(id: string, message: string): Promise<void> {
  try {
    const state = await loadPluginsState();
    const entry = state.installed[id];
    if (!entry) return;
    entry.error = message.slice(0, 200);
    await savePluginsState(state);
  } catch (e) {
    console.error("[pv] 写入插件错误状态失败:", e);
  }
}

/** 注入并做失败隔离:错误落盘 + toast,不影响其他插件 */
async function injectIsolated(id: string, hooks: HostHooks): Promise<void> {
  try {
    await injectOne(id);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await markPluginError(id, message);
    hooks.showToast(`插件加载失败:${message}`, "err");
  }
}

/** 应用启动:按 enabled 顺序注入全部插件 */
export async function bootstrapPlugins(hooks: HostHooks): Promise<void> {
  resetRegistry();
  let state: PluginsState;
  try {
    state = await loadPluginsState();
  } catch (e) {
    console.error("[pv] plugins.json 读取失败:", e);
    return;
  }
  for (const id of Object.keys(state.installed)) {
    if (state.installed[id].enabled) {
      await injectIsolated(id, hooks);
    }
  }
  hooks.onCommandsChanged();
}

/** 安装/启用成功后的即插即用注入 */
export async function injectAfterEnable(id: string, hooks: HostHooks): Promise<void> {
  await injectIsolated(id, hooks);
  hooks.onCommandsChanged();
}

/* ---------- 命令面板桥接 ---------- */

/** 注册表 → 命令面板条目(id 恒加 plugin:<pluginId>: 前缀,杜绝与内置命令冲突) */
export function buildPluginPaletteCommands(): PluginPaletteCommand[] {
  return pluginCommands().map(({ pluginId, def }) => ({
    id: `plugin:${pluginId}:${def.id}`,
    label: def.label,
    keywords: [...(def.keywords ?? []), pluginId],
    run: def.run,
  }));
}
