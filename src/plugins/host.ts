// 插件宿主:启动注入引擎与 plugins.json 状态的读写纠偏(前端侧)。
// 注入模型(设计 §2.3/§2.4,pv-1):主窗口就绪后按 plugins.json 的 enabled
// 顺序,经 plugin_read_entry 取 main.js 源码,包进 (function(pv){ … })
// (window.__pvSlot) 内联注入(同步执行);单插件注入后 3s 内未注册即标记
// error 并 toast,失败隔离,不影响其他插件与主窗口。

import { pluginInstalledManifest, pluginReadEntry, readPluginsState, writePluginsState } from "./api";
import { createBridge } from "./bridge";
import { hasRegistered, pluginCommands, resetRegistry } from "./registry";
import type { PluginPaletteCommand } from "./palette";
import type { InstalledEntry, PluginsState, SourceConfig } from "./types";

/** 注册超时:注入后 3s 内未调用任何 pv.* 注册 → 标记 error */
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

/* ---------- 注入引擎(pv-1:IIFE 参数闭包 + 一次性注入槽位) ---------- */

async function waitForRegistration(pluginId: string): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < REGISTER_TIMEOUT_MS) {
    if (hasRegistered(pluginId)) return true;
    await new Promise((r) => window.setTimeout(r, 100));
  }
  return hasRegistered(pluginId);
}

/**
 * 注入单个插件(安装/启用后即插即用也走这里);失败抛错由调用方隔离。
 *
 * pv-1 注入流程:
 * ① 经 plugin_read_entry 取当前版本 main.js 源码;
 * ② 临时挂 window error 监听(归因当前插件)并把桥赋给一次性槽位 __pvSlot;
 * ③ 源码包进 `(function(pv){ "use strict"; …源码… })(window.__pvSlot);`
 *    以 <script>.textContent 内联插入 —— textContent 不经 HTML 解析,源码含
 *    "</script>" 也安全;appendChild 同步执行脚本,pv 随 IIFE 参数闭包封闭;
 * ④ finally 清除 __pvSlot 并移除监听:全局不留任何可再次取得桥的入口,
 *    后续插件注入互不干扰(槽位安全:宿主每次注入前重赋值,读取只发生在
 *    同步执行瞬间,恶意插件改写 __pvSlot 不影响其他插件)。
 */
export async function injectOne(pluginId: string): Promise<void> {
  const manifest = await pluginInstalledManifest(pluginId).catch(() => null);
  if (manifest && manifest.type === "i18n") return; // 语言包无脚本,批次2改为启动消费
  const source = await pluginReadEntry(pluginId, "main.js").catch(() => null);
  if (source === null || source.trim() === "") {
    throw new Error("未找到当前版本的 main.js(插件文件缺失)");
  }
  const syncErrors: string[] = [];
  const onError = (ev: ErrorEvent) => {
    if (syncErrors.length === 0) syncErrors.push(ev.message);
  };
  window.addEventListener("error", onError);
  window.__pvSlot = createBridge(pluginId);
  try {
    const script = document.createElement("script");
    script.textContent = `;(function(pv){\n"use strict";\n${source}\n})(window.__pvSlot);`;
    document.head.appendChild(script); // 同步执行:返回后槽位即持本插件桥
  } finally {
    delete window.__pvSlot;
    window.removeEventListener("error", onError);
  }
  if (syncErrors.length > 0) {
    throw new Error(`插件脚本执行出错:${syncErrors[0]}`);
  }
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
