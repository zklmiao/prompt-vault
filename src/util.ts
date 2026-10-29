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

/* ---------- 模糊搜索(快速拾取与主窗口共用) ---------- */

export interface MatchRange {
  /** 起始下标(含) */
  start: number;
  /** 结束下标(不含) */
  end: number;
}

export interface FuzzyMatch {
  score: number;
  ranges: MatchRange[];
}

export interface PromptMatch {
  score: number;
  title: FuzzyMatch | null;
  tags: (FuzzyMatch | null)[];
  /** 仅当标题/标签未命中而正文命中时生成 */
  bodySnippet: { text: string; ranges: MatchRange[] } | null;
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  if (ranges.length <= 1) return ranges.map((r) => ({ ...r }));
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: MatchRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur.start <= last.end) last.end = Math.max(last.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

const WORD_BOUNDARY_RE = /[\s\-_/.,;:!?()[\]{}"'`#@、,。;:!?()【】《》]/;

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  return WORD_BOUNDARY_RE.test(text[index - 1]);
}

/**
 * 子序列模糊匹配:query 的每个字符按顺序出现在 text 中即命中。
 * 打分:单字符 10 分;连续命中额外 +6×连续长度;词首额外 +8;
 * 完整子串直接给高分(100 + 4×长度 + 起始位置奖励)。
 * 中文按字符匹配,不做拼音。
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const t = text.toLowerCase();
  if (!t) return null;

  const sub = t.indexOf(q);
  if (sub >= 0) {
    const score = 100 + q.length * 4 + Math.max(0, 20 - sub);
    return { score, ranges: [{ start: sub, end: sub + q.length }] };
  }

  const ranges: MatchRange[] = [];
  let score = 0;
  let qi = 0;
  let lastIndex = -2;
  let run = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] !== q[qi]) continue;
    const consecutive = i === lastIndex + 1;
    run = consecutive ? run + 1 : 0;
    score += 10 + (consecutive ? 6 * run : 0) + (isWordStart(text, i) ? 8 : 0);
    ranges.push({ start: i, end: i + 1 });
    lastIndex = i;
    qi += 1;
  }
  if (qi < q.length) return null;

  const span = (ranges[ranges.length - 1]?.end ?? 0) - (ranges[0]?.start ?? 0);
  score += Math.max(0, 30 - Math.floor(span / 2));
  return { score, ranges: mergeRanges(ranges) };
}

const SNIPPET_LEAD = 24;
const SNIPPET_TAIL = 40;

function makeSnippet(
  text: string,
  ranges: MatchRange[],
): { text: string; ranges: MatchRange[] } {
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  const start = Math.max(0, first.start - SNIPPET_LEAD);
  const end = Math.min(text.length, last.end + SNIPPET_TAIL);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  // 换行逐字符替换为空格,保持下标一一对应
  const slice = text.slice(start, end).replace(/[\r\n]/g, " ");
  const mapped: MatchRange[] = [];
  for (const r of ranges) {
    const s = Math.max(r.start, start) - start;
    const e = Math.min(r.end, end) - start;
    if (e > s) {
      mapped.push({ start: s + prefix.length, end: e + prefix.length });
    }
  }
  return { text: prefix + slice + suffix, ranges: mergeRanges(mapped) };
}

const FIELD_WEIGHT = { title: 3, tag: 2, source: 1.5, note: 1, body: 1 } as const;

/** 对单条 prompt 做全字段匹配并加权评分;正文命中且标题/标签未命中时附一行片段 */
export function matchPrompt(query: string, item: PromptItem): PromptMatch | null {
  const q = query.trim();
  if (!q) return null;

  const title = fuzzyMatch(q, item.title);
  const tags = item.tags.map((t) => fuzzyMatch(q, t));
  const bestTag = tags.reduce<FuzzyMatch | null>(
    (best, cur) => (cur && (!best || cur.score > best.score) ? cur : best),
    null,
  );
  const source = fuzzyMatch(q, item.source);
  const note = fuzzyMatch(q, item.note);
  const body = fuzzyMatch(q, item.body);

  if (!title && !bestTag && !source && !note && !body) return null;

  let score = 0;
  if (title) score += title.score * FIELD_WEIGHT.title;
  if (bestTag) score += bestTag.score * FIELD_WEIGHT.tag;
  if (source) score += source.score * FIELD_WEIGHT.source;
  if (note) score += note.score * FIELD_WEIGHT.note;
  if (body) score += body.score * FIELD_WEIGHT.body;

  const bodySnippet =
    body && !title && !bestTag ? makeSnippet(item.body, body.ranges) : null;

  return { score, title, tags, bodySnippet };
}
