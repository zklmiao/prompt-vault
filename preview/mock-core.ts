// 浏览器预览夹具:拦截 @tauri-apps/api/core 的 invoke,
// 用内存数据模拟 Rust 侧命令,让 UI 能在纯浏览器里跑起来(仅开发预览用,不参与构建)
import type { DataFile } from "../src/types";

const seed: DataFile = {
  version: 1,
  prompts: [
    {
      id: "1",
      title: "代码审查助手",
      body: "请审查以下代码变更:\n{{diff}}\n\n重点关注:{{关注点}}\n\n输出要求:\n1. 问题清单(按严重度排序)\n2. 改进建议\n3. 是否可以合并的结论",
      tags: ["编码", "审查"],
      source: "团队规范",
      note: "PR 自查和互查都适用",
      pinned: true,
      createdAt: "2026-10-20T09:00:00.000Z",
      updatedAt: "2026-10-24T02:10:00.000Z",
      copyCount: 12,
      lastCopiedAt: "2026-10-27T09:12:00.000Z",
    },
    {
      id: "2",
      title: "周报生成器",
      body: "根据以下工作记录生成本周周报:\n{{记录}}\n\n格式:\n## 本周完成\n## 下周计划\n## 风险与求助",
      tags: ["写作"],
      source: "",
      note: "周五下午用",
      pinned: true,
      createdAt: "2026-10-19T09:00:00.000Z",
      updatedAt: "2026-10-23T11:30:00.000Z",
    },
    {
      id: "3",
      title: "翻译润色",
      body: "将以下英文翻译成地道中文,保留代码与专有名词原文:\n{{text}}",
      tags: ["翻译"],
      source: "",
      note: "",
      pinned: false,
      createdAt: "2026-10-18T09:00:00.000Z",
      updatedAt: "2026-10-22T08:00:00.000Z",
      copyCount: 5,
      lastCopiedAt: "2026-10-26T03:40:00.000Z",
    },
    {
      id: "4",
      title: "正则表达式解释",
      body: "逐段解释这个正则表达式的含义,并指出潜在的回溯风险:\n{{pattern}}",
      tags: ["编码"],
      source: "",
      note: "",
      pinned: false,
      createdAt: "2026-10-17T09:00:00.000Z",
      updatedAt: "2026-10-21T08:00:00.000Z",
    },
    {
      id: "5",
      title: "SQL 优化分析",
      body: "这是慢查询与表结构:\n{{sql}}\n{{schema}}\n\n请给出:执行计划分析、索引建议、改写方案。",
      tags: ["编码", "数据库"],
      source: "",
      note: "",
      pinned: false,
      createdAt: "2026-10-16T09:00:00.000Z",
      updatedAt: "2026-10-20T08:00:00.000Z",
    },
    {
      id: "6",
      title: "礼貌拒绝请求",
      body: "帮我写一封婉拒邮件:对方请求是「{{请求}}」,理由是「{{理由}}」,语气友好但不留活口。",
      tags: ["写作", "邮件"],
      source: "",
      note: "",
      pinned: false,
      createdAt: "2026-10-15T09:00:00.000Z",
      updatedAt: "2026-10-19T08:00:00.000Z",
    },
    {
      id: "7",
      title: "Commit Message 生成",
      body: "根据以下 diff 生成符合 Conventional Commits 的提交信息:\n{{diff}}",
      tags: ["编码"],
      source: "",
      note: "",
      pinned: false,
      createdAt: "2026-10-14T09:00:00.000Z",
      updatedAt: "2026-10-18T08:00:00.000Z",
    },
    {
      id: "8",
      title: "面试复盘",
      body: "这是我的面试记录:\n{{记录}}\n\n请指出:回答得好的点、暴露的短板、下次可以怎么改进。",
      tags: ["成长"],
      source: "",
      note: "",
      pinned: false,
      createdAt: "2026-10-13T09:00:00.000Z",
      updatedAt: "2026-10-17T08:00:00.000Z",
    },
  ],
};

let current = JSON.stringify(seed, null, 2);

export async function invoke(cmd: string, args?: Record<string, unknown>) {
  switch (cmd) {
    case "get_data_path":
      return "C:\\mock\\prompts.json";
    case "first_run_default":
      return "C:\\mock\\prompts.json";
    case "set_data_path":
      return null;
    case "read_data":
      return current;
    case "path_meta":
      return {
        isDir: String(args?.path ?? "").endsWith("/"),
        size: String(args?.path ?? "").includes("big") ? 11 * 1024 * 1024 : 2048,
      };
    case "write_data":
      current = String(args?.contents ?? "");
      console.log("[mock] write_data", current.length, "chars");
      return null;
    case "bump_copy_stats": {
      const data = JSON.parse(current) as {
        prompts?: Array<Record<string, unknown>>;
      };
      const item = data.prompts?.find((p) => p.id === args?.id);
      if (!item) throw new Error("[mock] bump: item not found");
      item.copyCount =
        (typeof item.copyCount === "number" ? item.copyCount : 0) + 1;
      item.lastCopiedAt = new Date().toISOString();
      current = JSON.stringify(data, null, 2);
      console.log("[mock] bump_copy_stats", args?.id, "->", item.copyCount);
      return null;
    }
    default:
      throw new Error(`[mock] unknown command: ${cmd}`);
  }
}
