// Prompt Vault 回归 L1 单元测试:覆盖 src/util.ts 全部导出纯函数。
// 运行:node regression/util.test.ts(Node ≥23.6 原生 type stripping,零依赖)
import assert from "node:assert/strict";
import {
  bodySegments,
  coerceItems,
  extractPlaceholders,
  fillPlaceholders,
  formatDate,
  formatHotkey,
  fuzzyMatch,
  isComposingEvent,
  isNewer,
  matchPrompt,
  newId,
  newerIso,
  serializeDataFile,
} from "../src/util.ts";
import type { PromptItem } from "../src/types.ts";

type Case = { name: string; fn: () => void };
const cases: Case[] = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

const item = (over: Partial<PromptItem>): PromptItem => ({
  id: "t1",
  title: "标题",
  body: "正文",
  tags: [],
  source: "",
  note: "",
  pinned: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
  ...over,
});

/* ---- U1/U2 coerceItems ---- */
test("U1 包装对象与裸数组都能解析", () => {
  const wrapped = coerceItems({ version: 1, prompts: [{ id: "a", title: "x", body: "y" }] });
  const bare = coerceItems([{ id: "a", title: "x", body: "y" }]);
  assert.equal(wrapped.length, 1);
  assert.equal(bare.length, 1);
  assert.equal(wrapped[0].id, "a");
});
test("U1 null/标量/非对象项安全跳过", () => {
  assert.deepEqual(coerceItems(null), []);
  assert.deepEqual(coerceItems("str"), []);
  assert.deepEqual(coerceItems(42), []);
  assert.deepEqual(coerceItems({ prompts: "nope" }), []);
  assert.deepEqual(coerceItems([null, 3, "x", {}, { id: "ok", body: "" }]).length, 2);
});
test("U1 字段逐个纠偏(类型不符回默认值)", () => {
  const [it] = coerceItems([{
    id: "a", title: 123, body: null, tags: ["ok", 5, "", null],
    source: 0, note: false, pinned: "yes",
    createdAt: 1, updatedAt: {}, lastValues: ["bad"], copyCount: "7",
    deletedAt: 9,
  }]);
  assert.equal(it.title, "");
  assert.equal(it.body, "");
  assert.deepEqual(it.tags, ["ok"]);
  assert.equal(it.source, "");
  assert.equal(it.note, "");
  assert.equal(it.pinned, false);
  assert.equal(it.lastValues, undefined);
  assert.equal(it.copyCount, undefined);
  assert.equal(it.deletedAt, undefined);
});
test("U1 lastValues 只保留字符串值", () => {
  const [it] = coerceItems([{ id: "a", body: "", lastValues: { k1: "v", k2: 3, k3: null } }]);
  assert.deepEqual(it.lastValues, { k1: "v" });
});
test("U1 copyCount 非法回退 undefined;正浮点向下取整纠偏", () => {
  for (const bad of [-1, 0, "5", NaN, Infinity]) {
    const [it] = coerceItems([{ id: "a", body: "", copyCount: bad }]);
    assert.equal(it.copyCount, undefined, `copyCount=${String(bad)}`);
  }
  const [frac] = coerceItems([{ id: "a", body: "", copyCount: 3.7 }]);
  assert.equal(frac.copyCount, 3, "正浮点应 Math.floor 纠偏");
  const [ok] = coerceItems([{ id: "a", body: "", copyCount: 4.0 }]);
  assert.equal(ok.copyCount, 4);
});
test("U2 缺 id 生成 uuid、缺时间填当前", () => {
  const [it] = coerceItems([{ body: "x" }]);
  assert.match(it.id, /^[0-9a-f-]{36}$/);
  const drift = Date.now() - Date.parse(it.createdAt);
  assert.ok(Math.abs(drift) < 120_000, "createdAt 应接近当前时间");
  assert.equal(typeof it.updatedAt, "string");
  assert.equal(it.id, it.id); // 同条内稳定
});
test("U2 旧版本最小字段(v0.1.0 六字段)无损通过", () => {
  const legacy = {
    id: "old-1", title: "旧数据", body: "旧正文", tags: ["标签"],
    source: "旧来源", note: "", pinned: true,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
  };
  const [it] = coerceItems([legacy]);
  assert.deepEqual(
    [it.id, it.title, it.body, it.tags, it.source, it.pinned, it.updatedAt],
    ["old-1", "旧数据", "旧正文", ["标签"], "旧来源", true, "2026-01-02T00:00:00.000Z"],
  );
  assert.equal(it.deletedAt, undefined);
  assert.equal(it.copyCount, undefined);
});
test("U2 空字符串 id 回退生成新 id", () => {
  const [it] = coerceItems([{ id: "", body: "" }]);
  assert.match(it.id, /^[0-9a-f-]{36}$/);
});

/* ---- U3/U4 占位符 ---- */
test("U3 提取:基本、中文、去重、trim", () => {
  assert.deepEqual(extractPlaceholders("你好 {{name}}!"), ["name"]);
  assert.deepEqual(extractPlaceholders("{{变量A}}和{{变量B}}"), ["变量A", "变量B"]);
  assert.deepEqual(extractPlaceholders("{{a}} {{a}}"), ["a"]);
  assert.deepEqual(extractPlaceholders("{{ 空格名 }}"), ["空格名"]);
});
test("U3 边界:空名/三括号/尾括号/单括号", () => {
  assert.deepEqual(extractPlaceholders("{{}}"), []);
  assert.deepEqual(extractPlaceholders("{{{a}}}"), []);
  assert.deepEqual(extractPlaceholders("{{a}}}"), []);
  assert.deepEqual(extractPlaceholders("{{a}"), []);
  assert.deepEqual(extractPlaceholders("{a} 不是占位符"), []);
  assert.deepEqual(extractPlaceholders("没有占位符"), []);
});

test("U4 填充:替换、留空原样、同名全替换", () => {
  assert.equal(fillPlaceholders("你好 {{name}}!", { name: "世界" }), "你好 世界!");
  assert.equal(fillPlaceholders("你好 {{name}}!", { name: "" }), "你好 {{name}}!");
  assert.equal(fillPlaceholders("你好 {{name}}!", {}), "你好 {{name}}!");
  assert.equal(fillPlaceholders("{{z}}-{{z}}", { z: "9" }), "9-9");
  assert.equal(fillPlaceholders("A{{v}}B", { v: "$&$'`" }), "A$&$'`B");
  assert.equal(fillPlaceholders("{{a}} {{b}}", { a: "1", b: "2" }), "1 2");
});
test("U4 填充不匹配三括号", () => {
  assert.equal(fillPlaceholders("{{{a}}}", { a: "x" }), "{{{a}}}");
});

test("U8 bodySegments 交替片段", () => {
  assert.deepEqual(bodySegments("A {{x}} B"), [
    { text: "A " },
    { text: "x", ph: "x" },
    { text: " B" },
  ]);
  assert.deepEqual(bodySegments("{{a}}"), [{ text: "a", ph: "a" }]);
  assert.deepEqual(bodySegments(""), []);
  assert.deepEqual(bodySegments("纯文本"), [{ text: "纯文本" }]);
});

/* ---- U5 序列化 ---- */
test("U5 serializeDataFile 输出结构", () => {
  const out = serializeDataFile([item({})]);
  const parsed = JSON.parse(out);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.prompts.length, 1);
  assert.ok(out.includes('\n  "prompts"'), "应为 2 空格缩进");
});

/* ---- U6 时间 ---- */
test("U6 isNewer 双方可解析按时间、否则字典序", () => {
  assert.equal(isNewer("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z"), true);
  assert.equal(isNewer("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"), false);
  assert.equal(isNewer("b", "a"), true);
  assert.equal(isNewer("abc", "abd"), false);
});
test("U6 newerIso 缺失补位", () => {
  assert.equal(newerIso(undefined, "x"), "x");
  assert.equal(newerIso("x", undefined), "x");
  assert.equal(newerIso(undefined, undefined), undefined);
  assert.equal(
    newerIso("2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z"),
    "2026-01-02T00:00:00Z",
  );
});
test("U6 formatDate 非法输入回退", () => {
  assert.equal(formatDate(undefined), "");
  assert.equal(formatDate("not-a-date"), "not-a-date");
  assert.ok(formatDate("2026-10-29T12:00:00Z").includes("2026"));
});

/* ---- U7 模糊匹配 ---- */
test("U7 完整子串命中与区间", () => {
  const m = fuzzyMatch("代码", "复习代码审查");
  assert.ok(m && m.score >= 100);
  assert.deepEqual(m.ranges, [{ start: 2, end: 4 }]);
});
test("U7 大小写不敏感", () => {
  assert.ok(fuzzyMatch("ABC", "xabcx"));
  assert.ok(fuzzyMatch("sql", "SQL 优化"));
});
test("U7 子序列命中/反序不命中", () => {
  const m = fuzzyMatch("代审", "代码审查");
  assert.ok(m);
  assert.deepEqual(m.ranges, [{ start: 0, end: 1 }, { start: 2, end: 3 }]);
  assert.equal(fuzzyMatch("审代", "代码审查"), null);
});
test("U7 空查询/空文本/不完整子序列", () => {
  assert.equal(fuzzyMatch("  ", "文本"), null);
  assert.equal(fuzzyMatch("q", ""), null);
  assert.equal(fuzzyMatch("abcd", "abc"), null);
});
test("U7 词首命中加分(仅子序列路径,均避开完整子串)", () => {
  // "a b":两字符都在词首(下标 0 / 空格后);"xaqb":两字符都在词中。两文本都不含子串 "ab"
  const wordStart = fuzzyMatch("ab", "a b")!;
  const midWord = fuzzyMatch("ab", "xaqb")!;
  assert.ok(wordStart && midWord);
  assert.ok(wordStart.score > midWord.score, `${wordStart.score} 应 > ${midWord.score}`);
});
test("U7 matchPrompt 字段加权:标题命中强于正文命中", () => {
  const byTitle = matchPrompt("sql", item({ title: "SQL 优化", body: "无关正文" }));
  const byBody = matchPrompt("sql", item({ title: "别的", body: "这里讲 sql" }));
  assert.ok(byTitle && byBody);
  assert.ok(byTitle.score > byBody.score);
});
test("U7 正文命中且标题/标签未命中才给片段", () => {
  const snip = matchPrompt("执行计划", item({ title: "SQL 优化分析", tags: ["编码"], body: "给出:执行计划分析" }));
  assert.ok(snip?.bodySnippet);
  const noSnip = matchPrompt("sql", item({ title: "SQL 模板", body: "sql 正文" }));
  assert.equal(noSnip?.bodySnippet, null);
});
test("U7 片段边界:省略号与换行替换", () => {
  const long = "前".repeat(60) + "关键词" + "后".repeat(80);
  const m = matchPrompt("关键词", item({ title: "t", body: long }));
  const s = m?.bodySnippet;
  assert.ok(s);
  assert.ok(s.text.startsWith("…") && s.text.endsWith("…"));
  assert.ok(!s.text.includes("\n"));
  const withNl = matchPrompt("关键", item({ title: "t", body: "a\nb关键词c\nd" }));
  assert.ok(withNl?.bodySnippet && !withNl.bodySnippet.text.includes("\n"));
});
test("U7 不命中返回 null", () => {
  assert.equal(matchPrompt("不存在的词xyz", item({})), null);
  assert.equal(matchPrompt("", item({})), null);
});

/* ---- U9 formatHotkey ---- */
test("U9 热键格式化", () => {
  assert.equal(formatHotkey("alt+shift+n"), "Alt+Shift+N");
  assert.equal(formatHotkey("alt+q"), "Alt+Q");
  assert.equal(formatHotkey("control+q"), "Ctrl+Q");
  assert.equal(formatHotkey("commandorcontrol+j"), "Ctrl+J");
  assert.equal(formatHotkey("super+1"), "Win+1");
  assert.equal(formatHotkey("alt+arrowup"), "Alt+↑");
  assert.equal(formatHotkey("ctrl+f12"), "Ctrl+F12");
  assert.equal(formatHotkey("alt+space"), "Alt+Space");
  assert.equal(formatHotkey("shift+t"), "Shift+T");
  assert.equal(formatHotkey("ctrl+escape"), "Ctrl+Escape");
});

/* ---- U10 IME 守卫 ---- */
test("U10 isComposingEvent 判定", () => {
  assert.equal(isComposingEvent({ isComposing: true } as unknown as KeyboardEvent), true);
  assert.equal(isComposingEvent({ keyCode: 229 } as unknown as KeyboardEvent), true);
  assert.equal(
    isComposingEvent({ nativeEvent: { isComposing: true } } as unknown as KeyboardEvent),
    true,
  );
  assert.equal(
    isComposingEvent({ isComposing: false, keyCode: 13 } as unknown as KeyboardEvent),
    false,
  );
});

/* ---- 附加:newId 唯一性 ---- */
test("X newId 唯一", () => {
  assert.notEqual(newId(), newId());
});

/* ---- 运行器 ---- */
let pass = 0;
const failed: Array<{ name: string; error: string }> = [];
for (const c of cases) {
  try {
    c.fn();
    pass++;
    console.log(`PASS  ${c.name}`);
  } catch (e) {
    failed.push({ name: c.name, error: String(e) });
    console.log(`FAIL  ${c.name}\n      ${String(e).split("\n")[0]}`);
  }
}
console.log(`\n=== ${pass}/${cases.length} passed, ${failed.length} failed ===`);
if (failed.length > 0) process.exit(1);
