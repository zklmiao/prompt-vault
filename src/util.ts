import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { PromptItem } from "./types";

/**
 * 输入法组字期间的按键判定:组字中的 Enter/Esc/方向键等必须让给输入法,
 * 不能触发业务动作。同时检查 isComposing 与 keyCode 229 ——
 * Windows/WebView2 上部分输入法只通过 keyCode 229 给出组字信号。
 */
export function isComposingEvent(
  e: ReactKeyboardEvent | KeyboardEvent,
): boolean {
  const native = "nativeEvent" in e ? e.nativeEvent : e;
  return native.isComposing || native.keyCode === 229;
}

export const newId = (): string => crypto.randomUUID();

export const nowIso = (): string => new Date().toISOString();

export function formatDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

/**
 * 占位符:{{名称}},前后不允许再有花括号,
 * 避免 {{{a}}} 被部分匹配后在复制结果里残留括号
 */
export const PLACEHOLDER_RE = /(?<!\{)\{\{([^{}]+)\}\}(?!\})/g;

export function extractPlaceholders(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER_RE)) {
    const name = m[1].trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** 用填写值替换占位符;留空的保持 {{name}} 原样 */
export function fillPlaceholders(
  body: string,
  values: Record<string, string>,
): string {
  return body.replace(PLACEHOLDER_RE, (raw, name: string) => {
    const v = values[name.trim()];
    return v && v.length > 0 ? v : raw;
  });
}

/** 把正文切成普通文本与占位符交替的片段,供高亮渲染 */
export function bodySegments(text: string): { text: string; ph?: string }[] {
  const out: { text: string; ph?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: m[1].trim(), ph: m[1].trim() });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/**
 * 时间比较:两边都能解析成日期时按时间戳比较,
 * 否则退回字符串比较,保证"冲突取较新者"不会被坏数据误导
 */
export function isNewer(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta > tb;
  return a > b;
}

/** 两个 ISO 时间取较新者;缺失时返回存在的一方 */
export function newerIso(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return isNewer(a, b) ? a : b;
}

export function serializeDataFile(items: PromptItem[]): string {
  return JSON.stringify({ version: 1, prompts: items }, null, 2);
}

/** 宽松解析导入/数据文件:接受 {prompts:[…]} 或裸数组,字段逐个纠偏 */
export function coerceItems(parsed: unknown): PromptItem[] {
  let arr: unknown[] = [];
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { prompts?: unknown }).prompts)
  ) {
    arr = (parsed as { prompts: unknown[] }).prompts;
  }

  const out: PromptItem[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    let lastValues: Record<string, string> | undefined;
    if (
      r.lastValues &&
      typeof r.lastValues === "object" &&
      !Array.isArray(r.lastValues)
    ) {
      lastValues = {};
      for (const [k, v] of Object.entries(r.lastValues as Record<string, unknown>)) {
        if (typeof v === "string") lastValues[k] = v;
      }
    }
    out.push({
      id: typeof r.id === "string" && r.id ? r.id : newId(),
      title: typeof r.title === "string" ? r.title : "",
      body: typeof r.body === "string" ? r.body : "",
      tags: Array.isArray(r.tags)
        ? r.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "")
        : [],
      source: typeof r.source === "string" ? r.source : "",
      note: typeof r.note === "string" ? r.note : "",
      pinned: r.pinned === true,
      createdAt: typeof r.createdAt === "string" ? r.createdAt : nowIso(),
      updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : nowIso(),
      lastValues,
      deletedAt: typeof r.deletedAt === "string" ? r.deletedAt : undefined,
      copyCount:
        typeof r.copyCount === "number" &&
        Number.isFinite(r.copyCount) &&
        r.copyCount > 0
          ? Math.floor(r.copyCount)
          : undefined,
      lastCopiedAt:
        typeof r.lastCopiedAt === "string" ? r.lastCopiedAt : undefined,
    });
  }
  return out;
}
