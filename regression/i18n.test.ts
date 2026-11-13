// i18n 回归测试:覆盖 src/i18n/core.ts 全部导出纯函数与目录覆盖完整性。
// 运行:node regression/i18n.test.ts(Node ≥23.6 原生 type stripping,零依赖)
import assert from "node:assert/strict";
import {
  coerceCatalog,
  currentLocale,
  interpolate,
  isValidLangCode,
  mergeCatalogs,
  resolveAutoLang,
  setCurrentLang,
} from "../src/i18n/core.ts";
import { zhCN } from "../src/i18n/zh-CN.ts";
import { en } from "../src/i18n/en.ts";

type Case = { name: string; fn: () => void };
const cases: Case[] = [];
const test = (name: string, fn: () => void) => cases.push({ name, fn });

/* ---- resolveAutoLang ---- */
test("resolveAutoLang:zh 开头归 zh-CN,其余归 en", () => {
  for (const zh of ["zh", "zh-CN", "zh-Hans", "zh-TW", "ZH"]) {
    assert.equal(resolveAutoLang(zh), "zh-CN", `navigatorLanguage=${zh}`);
  }
  for (const other of ["en", "en-US", "fr", "de-DE", "ja", ""]) {
    assert.equal(resolveAutoLang(other), "en", `navigatorLanguage=${other}`);
  }
});

/* ---- mergeCatalogs 优先级链 ---- */
test("mergeCatalogs:高层命中即用,低层只补缺键", () => {
  const merged = mergeCatalogs([
    { "app.a": "高层A", "app.b": "高层B" },
    { "app.b": "低层B", "app.c": "低层C" },
  ]);
  assert.equal(merged["app.a"], "高层A");
  assert.equal(merged["app.b"], "高层B", "低层不得覆盖高层");
  assert.equal(merged["app.c"], "低层C", "缺键由低层补齐");
});

test("mergeCatalogs:链序 = locales > 语言包(installed 键序)> 插件字典(注入序)> en > zh", () => {
  const chain = [
    { "k": "locales" },
    { "k": "pack1", "only-pack": "p1" }, // 语言包层:installed 键序
    { "k": "pack2" },
    { "k": "dict1", "only-dict": "d1" }, // 插件字典层:注入完成序
    { "k": "dict2" },
    { "k": "en" }, // 内置 en(仅当前语言为 en 时入链)
    { "k": "zh" }, // 内置 zh-CN 兜底
  ];
  const merged = mergeCatalogs(chain);
  assert.equal(merged["k"], "locales");
  assert.equal(merged["only-pack"], "p1");
  assert.equal(merged["only-dict"], "d1");
  // 语言包层内部:先装的键序更高
  const packs = mergeCatalogs([
    { "k": "pack1" },
    { "k": "pack2", "p2": "v" },
  ]);
  assert.equal(packs["k"], "pack1");
});

test("mergeCatalogs:en Partial 回退 zh-CN", () => {
  // en 缺的键落回 zh-CN 值;en 有的键覆盖 zh-CN
  const merged = mergeCatalogs([en as Record<string, string>, zhCN]);
  for (const [key, value] of Object.entries(zhCN)) {
    assert.ok(merged[key] !== undefined, `键 ${key} 合并后必须存在`);
    if (en[key as keyof typeof en] !== undefined) {
      assert.equal(merged[key], en[key as keyof typeof en], `键 ${key} 应取 en 值`);
    } else {
      assert.equal(merged[key], value, `键 ${key} 应回退 zh-CN`);
    }
  }
});

test("en 覆盖全部 zh 键(第一批完整翻译,防新增漏翻)", () => {
  const zhKeys = Object.keys(zhCN);
  const enKeys = new Set(Object.keys(en));
  const missing = zhKeys.filter((k) => !enKeys.has(k));
  assert.deepEqual(missing, [], "en 缺失的键");
  assert.equal(Object.keys(en).length, zhKeys.length, "en 不应出现 zh 没有的键");
});

/* ---- interpolate ---- */
test("interpolate:{name} 插值", () => {
  assert.equal(interpolate("{n} 模板", { n: 3 }), "3 模板");
  assert.equal(
    interpolate("导入完成:新增 {added} 条,更新 {updated} 条", { added: 1, updated: 2 }),
    "导入完成:新增 1 条,更新 2 条",
  );
});

test("interpolate:缺参数保持原样(保护 {{变量}} 形态文案)", () => {
  assert.equal(interpolate("{n} 次"), "{n} 次", "无参数时原样");
  assert.equal(interpolate("{n} 次", { other: 1 }), "{n} 次", "参数名不匹配时原样");
  assert.equal(
    interpolate("支持 {{变量名}} 占位符", {}),
    "支持 {{变量名}} 占位符",
    "{{中文}} 不被误替换",
  );
  // {{diff}} 中 diff 是 \w 词:未传参也必须原样
  assert.equal(
    interpolate("例如:请审查以下代码变更:{{diff}}", {}),
    "例如:请审查以下代码变更:{{diff}}",
  );
});

/* ---- coerceCatalog ---- */
test("coerceCatalog:扁平字符串对象通过,其余拒绝", () => {
  assert.deepEqual(coerceCatalog({ a: "x" }), { a: "x" });
  assert.deepEqual(coerceCatalog({}), {});
  assert.equal(coerceCatalog(null), null);
  assert.equal(coerceCatalog("str"), null);
  assert.equal(coerceCatalog(42), null);
  assert.equal(coerceCatalog([]), null);
  assert.equal(coerceCatalog({ a: 1 }), null);
  assert.equal(coerceCatalog({ a: null }), null);
  assert.equal(coerceCatalog({ a: { b: "c" } }), null);
});

/* ---- isValidLangCode(与 Rust 端 ^[a-zA-Z-]{2,12}$ 一致)---- */
test("isValidLangCode 边界", () => {
  assert.ok(isValidLangCode("en"));
  assert.ok(isValidLangCode("zh-CN"));
  assert.ok(!isValidLangCode(""));
  assert.ok(!isValidLangCode("a"));
  assert.ok(!isValidLangCode("x".repeat(13)));
  assert.ok(!isValidLangCode("zh_CN"));
  assert.ok(!isValidLangCode("zh01"));
  assert.ok(!isValidLangCode("a/b"));
  assert.ok(!isValidLangCode("en.json"));
});

/* ---- currentLocale ---- */
test("currentLocale:en→en-GB,zh-CN→zh-CN,其余原样", () => {
  setCurrentLang("en");
  assert.equal(currentLocale(), "en-GB");
  setCurrentLang("zh-CN");
  assert.equal(currentLocale(), "zh-CN");
  setCurrentLang("fr");
  assert.equal(currentLocale(), "fr");
  setCurrentLang("zh-CN");
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
