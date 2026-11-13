// i18n React 运行时:I18nProvider + useI18n() + t()。
// 回退链(高→低):locales\<码>.json > 语言包插件(installed 键序)>
// 标准插件 pv.i18n.register 字典(注入完成序)> 内置 en(仅当前语言为 en)>
// 内置 zh-CN;双缺时显示键名 + 仅 dev console.warn。
// 语言偏好存 localStorage "pv-lang"("auto" | "zh-CN" | <提供的码>),
// 切换 = setState 即时重渲染,不 reload;locales 目录由本模块经 Rust 命令加载。

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import {
  coerceCatalog,
  interpolate,
  isValidLangCode,
  LANG_STORAGE_KEY,
  mergeCatalogs,
  resolveAutoLang,
  setCurrentLang,
  type Catalog,
} from "./core";
import { en } from "./en";
import { zhCN, type ZhKey } from "./zh-CN";
import { i18nLocaleFile, i18nLocales } from "../api";

export interface I18nApi {
  /** 翻译:缺键回退链,双缺显示键名 */
  t(key: string, params?: Record<string, string | number>): string;
  /** 已解析的当前语言码(auto 已按系统 locale 解析为具体码) */
  lang: string;
  /** 语言偏好原始值(pv-lang 存的 "auto" | 具体码) */
  langPref: string;
  /** 设置语言偏好并持久化(即时生效,不 reload) */
  setLang(pref: string): void;
  /** 检测到的语言码(locales 目录 ∪ 语言包插件 ∪ 插件字典,去重排序) */
  providedLangs: string[];
}

/* ---------- 外部目录存储(locales 文件 / 语言包插件 / 插件字典) ---------- */

interface I18nSnapshot {
  langPref: string;
  lang: string;
  locales: Catalog | null;
  /** 语言包插件条目(installed 键序) */
  packs: Array<{ code: string; catalog: Catalog }>;
  /** 标准插件字典条目(注入完成序) */
  dicts: Array<{ code: string; catalog: Catalog }>;
  /** 检测到的语言码(去重排序) */
  provided: string[];
}

let snapshot: I18nSnapshot = {
  langPref: "auto",
  lang: "zh-CN",
  locales: null,
  packs: [],
  dicts: [],
  provided: [],
};
const listeners = new Set<() => void>();
/** locales 目录检测到的全部语言码(设置里即使不是当前语言也要可选) */
let localeCodes: string[] = [];

function notify(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function readLangPref(): string {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved && (saved === "auto" || isValidLangCode(saved))) return saved;
  } catch {
    /* localStorage 不可用:跟随系统 */
  }
  return "auto";
}

function resolveLang(pref: string): string {
  if (pref === "auto") return resolveAutoLang(navigator.language);
  return pref;
}

function recomputeProvided(): string[] {
  const codes = new Set<string>(localeCodes);
  if (snapshot.locales) codes.add(snapshot.lang);
  for (const p of snapshot.packs) codes.add(p.code);
  for (const d of snapshot.dicts) codes.add(d.code);
  return [...codes].sort((a, b) => a.localeCompare(b));
}

function rebuildSnapshot(): void {
  const lang = resolveLang(snapshot.langPref);
  setCurrentLang(lang);
  snapshot = { ...snapshot, lang, provided: recomputeProvided() };
  notify();
}

/* ---------- 供宿主(host.ts)写入的目录来源 ---------- */

/** 整体替换语言包插件层(installed 键序;语言包插件 JSON) */
export function setI18nPacks(
  packs: Array<{ code: string; catalog: Catalog }>,
): void {
  snapshot = { ...snapshot, packs };
  rebuildSnapshot();
}

/** 追加标准插件 pv.i18n.register 字典(注入完成序;字典按语言码拆条目) */
export function pushPluginDicts(
  entries: Array<{ code: string; catalog: Catalog }>,
): void {
  if (entries.length === 0) return;
  snapshot = { ...snapshot, dicts: [...snapshot.dicts, ...entries] };
  rebuildSnapshot();
}

/** 重置插件层(bootstrap 注入轮开始前) */
export function resetPluginCatalogs(): void {
  snapshot = { ...snapshot, packs: [], dicts: [] };
  rebuildSnapshot();
}

/**
 * 加载 locales 目录中当前语言的手动语言包(目录缺失/无 Tauri 运行时静默跳过)。
 * 加载期间切走语言则以最新语言为准,旧结果丢弃。
 */
export async function reloadLocales(): Promise<void> {
  const lang = snapshot.lang;
  let catalog: Catalog | null = null;
  try {
    const entries = await i18nLocales();
    const entry = entries.find((e) => e.code === lang && !e.error);
    if (entry) {
      const raw = await i18nLocaleFile(lang);
      if (raw !== null) {
        try {
          const parsed: unknown = JSON.parse(raw);
          catalog = coerceCatalog(parsed);
          if (!catalog)
            console.warn(`[pv-i18n] locales/${lang}.json 不是扁平字符串对象,已忽略`);
        } catch {
          console.warn(`[pv-i18n] locales/${lang}.json 解析失败,已忽略`);
        }
      }
    }
  } catch {
    /* 浏览器预览/无 Tauri:无手动语言包 */
  }
  if (snapshot.lang === lang) {
    snapshot = { ...snapshot, locales: catalog };
    rebuildSnapshot();
  }
}

async function loadLocaleCodes(): Promise<void> {
  try {
    const entries = await i18nLocales();
    localeCodes = entries.filter((e) => !e.error).map((e) => e.code);
    rebuildSnapshot();
  } catch {
    /* 无 Tauri */
  }
}

/* ---------- Provider ---------- */

const I18nContext = createContext<I18nApi | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const snap = useSyncExternalStore(subscribe, () => snapshot);

  useEffect(() => {
    // 挂载:读偏好 → 解析语言 → 加载手动语言包与检测语言码
    snapshot = { ...snapshot, langPref: readLangPref() };
    rebuildSnapshot();
    void loadLocaleCodes();
    void reloadLocales();
  }, []);

  // 目录链只随快照变化重算一次,t() 查表 O(1)
  const merged = useMemo<Catalog>(() => {
    const chain: Catalog[] = [
      ...(snap.locales ? [snap.locales] : []),
      ...snap.packs.map((p) => p.catalog),
      ...snap.dicts.map((d) => d.catalog),
      ...(snap.lang === "en" ? [en as Catalog] : []),
      zhCN as unknown as Catalog,
    ];
    return mergeCatalogs(chain);
  }, [snap]);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      const value = merged[key];
      if (value === undefined) {
        if (import.meta.env.DEV) console.warn(`[pv-i18n] 缺少文案键:${key}`);
        return key;
      }
      return interpolate(value, params);
    },
    [merged],
  );

  const setLang = useCallback((pref: string) => {
    try {
      localStorage.setItem(LANG_STORAGE_KEY, pref);
    } catch {
      /* ignore */
    }
    snapshot = { ...snapshot, langPref: pref };
    rebuildSnapshot();
    void reloadLocales();
  }, []);

  const api = useMemo<I18nApi>(
    () => ({
      t,
      lang: snap.lang,
      langPref: snap.langPref,
      setLang,
      providedLangs: snap.provided,
    }),
    [t, snap.lang, snap.langPref, snap.provided, setLang],
  );

  return <I18nContext.Provider value={api}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nApi {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n 必须在 I18nProvider 内使用");
  return ctx;
}

/** 重读 localStorage 语言偏好(快速拾取常驻隐藏窗口在 quickpick-shown 时调用) */
export function refreshLang(): void {
  snapshot = { ...snapshot, langPref: readLangPref() };
  rebuildSnapshot();
  void reloadLocales();
}

/** zh 键类型复导出(组件内 t() 参数提示用) */
export type { ZhKey };
