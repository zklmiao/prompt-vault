// i18n 核心纯函数(Node 可直接测):语言解析、目录合并、插值、目录校验。
// 不依赖 Tauri / React / DOM;语言状态由 index.tsx 的运行时持有并回写 currentLang。

export type Catalog = Record<string, string>;

/** localStorage 语言偏好键:auto | zh-CN | en | <插件/locales 提供的码> */
export const LANG_STORAGE_KEY = "pv-lang";

/** 语言码合法性(与 Rust i18n.rs 的 locales 文件名规则逐字一致) */
const LANG_CODE_RE = /^[a-zA-Z-]{2,12}$/;

export function isValidLangCode(code: string): boolean {
  return LANG_CODE_RE.test(code);
}

/** 跟随系统:zh 开头 → "zh-CN",否则 "en" */
export function resolveAutoLang(navigatorLanguage: string): "zh-CN" | "en" {
  return navigatorLanguage.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

/**
 * 目录链合并:layers 按优先级从高到低排列,高层命中即用,低层只补缺键不覆盖。
 * 链形(高→低):locales\<码>.json > 语言包插件(installed 键序)>
 * 标准插件 pv.i18n.register 字典(注入完成序)> 内置 en(仅当前语言为 en)>
 * 内置 zh-CN(兜底)。
 */
export function mergeCatalogs(layers: Catalog[]): Catalog {
  const out: Catalog = {};
  // 从低层到高层依次赋值,让高层覆盖低层(等价于高层命中即用)
  for (let i = layers.length - 1; i >= 0; i--) {
    Object.assign(out, layers[i]);
  }
  return out;
}

/**
 * 插值:{name} 占位符替换;参数缺失时保持原样(使 {{变量}} 形态的文案
 * 在误传参时也不被破坏,{word} 占位符仅按显式传入的参数替换)。
 */
export function interpolate(
  template: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (raw, name: string) => {
    const v = params[name];
    return v === undefined || v === null ? raw : String(v);
  });
}

/**
 * 校验「字符串→字符串扁平对象」(语言包插件 JSON 与 pv.i18n.register 字典共用)。
 * 非对象/数组/任何值不是字符串 → null(坏文件跳过,不拖垮宿主)。
 */
export function coerceCatalog(raw: unknown): Catalog | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const out: Catalog = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") return null;
    out[k] = v;
  }
  return out;
}

/* ---------- 当前语言与 locale 映射(index.tsx 持有,util.formatDate 只读) ---------- */

let currentLang = "zh-CN";

/** 运行时回写当前语言(仅 index.tsx 调用) */
export function setCurrentLang(lang: string): void {
  currentLang = lang;
}

/** 当前语言的 Intl locale:zh-CN→"zh-CN"、en→"en-GB",其余原样 */
export function currentLocale(): string {
  if (currentLang === "en") return "en-GB";
  if (currentLang === "zh-CN") return "zh-CN";
  return currentLang;
}
