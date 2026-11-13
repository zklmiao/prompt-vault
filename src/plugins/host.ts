// 插件宿主:启动注入引擎与 plugins.json 状态的读写纠偏(前端侧)。
// 注入模型(设计 §2.3/§2.4,pv-1):主窗口就绪后按 plugins.json 的 enabled
// 顺序,经 plugin_read_entry 取 main.js 源码,包进 (function(pv){ … })
// (window.__pvSlot) 内联注入(同步执行);单插件注入后 3s 内未注册即标记
// error 并 toast,失败隔离,不影响其他插件与主窗口。

import { pluginInstalledManifest, pluginReadEntry, readPluginsState, writePluginsState } from "./api";
import { createBridge } from "./bridge";
import {
  getI18nDict,
  hasRegistered,
  pluginCommands,
  resetRegistry,
} from "./registry";
import { coerceCatalog, isValidLangCode, type Catalog } from "../i18n/core";
import {
  pushPluginDicts,
  resetPluginCatalogs,
  setI18nPacks,
  translate,
} from "../i18n";
import type { PluginPaletteCommand } from "./palette";
import type { InstalledEntry, PluginsState, SourceConfig } from "./types";

/** 注册超时:注入后 3s 内未调用任何 pv.* 注册 → 标记 error */
const REGISTER_TIMEOUT_MS = 3000;

export interface HostHooks {
  showToast(text: string, kind?: "ok" | "err"): void;
  /** 注册表变化(注入完成后)通知宿主刷新命令面板 */
  onCommandsChanged(): void;
  /** 宿主翻译函数(toast 前缀等界面文案;错误原文本身透传不翻译) */
  t(key: string, params?: Record<string, string | number>): string;
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
  if (typeof v !== "object" || v === null)
    throw new Error(translate("host.errBadStateJson"));
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
 * 消费语言包插件(type:"i18n",纯数据不注入脚本;修复批次1「字典永远无法生效」):
 * manifest 声明 languages 数组(码过 ^[a-zA-Z-]{2,12}$ 校验,非法项跳过 + warn)
 * → 逐码 plugin_read_entry 读包内 <码>.json → JSON.parse + 扁平字符串对象校验
 * (坏文件跳过 + warn)→ 并入 i18n 插件层目录(installed 键序)。
 * manifest 无 languages 的 i18n 插件:跳过 + warn(不报 error,不拖垮宿主)。
 */
async function consumeLanguagePack(id: string): Promise<Array<{ code: string; catalog: Catalog }>> {
  const out: Array<{ code: string; catalog: Catalog }> = [];
  const manifest = await pluginInstalledManifest(id).catch(() => null);
  const langs = Array.isArray(manifest?.languages)
    ? manifest.languages.filter((c): c is string => typeof c === "string")
    : null;
  if (!langs || langs.length === 0) {
    console.warn(`[pv] 语言包插件 ${id} 的 manifest 未声明 languages 数组,已跳过`);
    return out;
  }
  for (const rawCode of langs) {
    if (!isValidLangCode(rawCode)) {
      console.warn(`[pv] 语言包插件 ${id} 声明的语言码不合法,已跳过:${rawCode}`);
      continue;
    }
    const raw = await pluginReadEntry(id, `${rawCode}.json`).catch(() => null);
    if (raw === null) {
      console.warn(`[pv] 语言包插件 ${id} 缺少 ${rawCode}.json,已跳过`);
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      const catalog = coerceCatalog(parsed);
      if (!catalog) {
        console.warn(`[pv] 语言包插件 ${id} 的 ${rawCode}.json 不是扁平字符串对象,已跳过`);
        continue;
      }
      out.push({ code: rawCode, catalog });
    } catch {
      console.warn(`[pv] 语言包插件 ${id} 的 ${rawCode}.json 解析失败,已跳过`);
    }
  }
  return out;
}

/**
 * 按 plugins.json installed 键序重建语言包插件层(启用中的 i18n 型插件全部消费)。
 * 全量重建而非增量:任何 i18n 插件安装/启用后都保持与 installed 键序一致。
 */
async function rebuildLanguagePacks(state?: PluginsState): Promise<void> {
  let st = state;
  if (!st) {
    try {
      st = await loadPluginsState();
    } catch (e) {
      console.error("[pv] 语言包重建失败(plugins.json 读取失败):", e);
      setI18nPacks([]);
      return;
    }
  }
  const packs: Array<{ code: string; catalog: Catalog }> = [];
  for (const id of Object.keys(st.installed)) {
    if (!st.installed[id].enabled) continue;
    const manifest = await pluginInstalledManifest(id).catch(() => null);
    if (manifest?.type !== "i18n") continue;
    packs.push(...(await consumeLanguagePack(id)));
  }
  setI18nPacks(packs);
}

/** 插件字典(pv.i18n.register)按语言码拆条目;非扁平对象值跳过 + warn */
function dictToEntries(dict: unknown, pluginId: string): Array<{ code: string; catalog: Catalog }> {
  const out: Array<{ code: string; catalog: Catalog }> = [];
  if (typeof dict !== "object" || dict === null) return out;
  for (const [code, value] of Object.entries(dict as Record<string, unknown>)) {
    const catalog = coerceCatalog(value);
    if (!catalog) {
      console.warn(`[pv] 插件 ${pluginId} 的 pv.i18n 字典语言 ${code} 不是扁平字符串对象,已跳过`);
      continue;
    }
    out.push({ code, catalog });
  }
  return out;
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
  if (manifest && manifest.type === "i18n") {
    // 语言包为纯数据:不注入脚本,消费后即可生效(启用时即插即用)
    await rebuildLanguagePacks();
    return;
  }
  const source = await pluginReadEntry(pluginId, "main.js").catch(() => null);
  if (source === null || source.trim() === "") {
    throw new Error(translate("host.errNoEntry"));
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
    throw new Error(translate("host.errScript", { msg: syncErrors[0] }));
  }
  if (!hasRegistered(pluginId)) {
    const ok = await waitForRegistration(pluginId);
    if (!ok) {
      throw new Error(translate("host.errTimeout"));
    }
  }
  // 注入完成序:插件自带的 pv.i18n 字典并入 i18n 插件层(无字典则无操作)
  const dict = getI18nDict(pluginId);
  if (dict !== undefined) {
    pushPluginDicts(dictToEntries(dict, pluginId));
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
    // 错误原文(如 Rust 透传信息)不翻译,仅前缀走界面文案
    hooks.showToast(hooks.t("ph.toastLoadFailed", { msg: message }), "err");
  }
}

/** 应用启动:按 enabled 顺序注入全部插件(语言包插件先消费,再注入脚本) */
export async function bootstrapPlugins(hooks: HostHooks): Promise<void> {
  resetRegistry();
  resetPluginCatalogs();
  let state: PluginsState;
  try {
    state = await loadPluginsState();
  } catch (e) {
    console.error("[pv] plugins.json 读取失败:", e);
    return;
  }
  await rebuildLanguagePacks(state);
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
