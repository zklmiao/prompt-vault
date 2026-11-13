// 插件注册表回归测试:覆盖 waitForRegistered 信号化等待(P0 批次2 遗留修复)。
// 运行:node regression/plugins.test.ts(Node ≥23.6 原生 type stripping,零依赖)
// registry.ts 为纯模块(无外部导入,setTimeout 走全局),可在 node 下直测。
import assert from "node:assert/strict";
import {
  hasRegistered,
  markRegistered,
  resetRegistry,
  waitForRegistered,
} from "../src/plugins/registry.ts";

type Case = { name: string; fn: () => void | Promise<void> };
const cases: Case[] = [];
const test = (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ---- 短路:插入前已注册则立即 resolve(true) ---- */
test("已注册时短路即时返回 true", async () => {
  resetRegistry();
  markRegistered("a");
  const start = Date.now();
  const ok = await waitForRegistered("a", 3000);
  const elapsed = Date.now() - start;
  assert.equal(ok, true);
  assert.ok(elapsed < 50, `短路应即时返回,实测 ${elapsed}ms`);
});

/* ---- 信号唤醒:注册时刻即时 resolve,计时远小于超时 ---- */
test("异步注册被信号即时唤醒(≈ 注册时刻,远小于 3s)", async () => {
  resetRegistry();
  const start = Date.now();
  const waiting = waitForRegistered("b", 3000);
  await sleep(80);
  markRegistered("b"); // 信号时刻
  const ok = await waiting;
  const elapsed = Date.now() - start;
  assert.equal(ok, true);
  assert.ok(elapsed < 300, `应在注册后立即唤醒(实测 ${elapsed}ms,若轮询则 ≥ 注册时刻+100ms 且上限 3s)`);
  assert.ok(elapsed >= 80, "不应早于注册时刻");
});

/* ---- 超时兜底:false ---- */
test("超时兜底返回 false(计时 ≥ timeout)", async () => {
  resetRegistry();
  const start = Date.now();
  const ok = await waitForRegistered("c", 100);
  const elapsed = Date.now() - start;
  assert.equal(ok, false);
  assert.ok(elapsed >= 100, `超时应不小于 timeout,实测 ${elapsed}ms`);
  assert.ok(elapsed < 3000, "不应拖到外层 3s");
});

/* ---- 多等待者:注册时全部唤醒 ---- */
test("多等待者同时被信号唤醒", async () => {
  resetRegistry();
  const w1 = waitForRegistered("d", 3000);
  const w2 = waitForRegistered("d", 3000);
  await sleep(30);
  markRegistered("d");
  assert.deepEqual(await Promise.all([w1, w2]), [true, true]);
});

/* ---- 清理:超时后再注册不留悬挂等待者;新等待者仍可用 ---- */
test("超时清理后新等待者正常工作", async () => {
  resetRegistry();
  assert.equal(await waitForRegistered("e", 60), false);
  markRegistered("e"); // 无等待者:不抛错、直接登记
  assert.equal(hasRegistered("e"), true);
  assert.equal(await waitForRegistered("e", 3000), true); // 短路路径
});

/* ---- resetRegistry:在途等待者 resolve(false) 解除阻塞 ---- */
test("resetRegistry 解除在途等待", async () => {
  resetRegistry();
  const waiting = waitForRegistered("f", 3000);
  await sleep(20);
  resetRegistry();
  const ok = await waiting;
  assert.equal(ok, false);
});

/* ---- 运行器 ---- */
let pass = 0;
const failed: Array<{ name: string; error: string }> = [];
for (const c of cases) {
  try {
    await c.fn();
    pass++;
    console.log(`PASS  ${c.name}`);
  } catch (e) {
    failed.push({ name: c.name, error: String(e) });
    console.log(`FAIL  ${c.name}\n      ${String(e).split("\n")[0]}`);
  }
}
console.log(`\n=== ${pass}/${cases.length} passed, ${failed.length} failed ===`);
if (failed.length > 0) process.exit(1);
