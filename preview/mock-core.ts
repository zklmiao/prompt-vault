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

// 预览夹具支持 ?empty=1:以空收藏启动,用于验证首次引导
const emptyMode =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("empty") === "1";

const initial: DataFile = emptyMode ? { version: 1, prompts: [] } : seed;

let current = JSON.stringify(initial, null, 2);

/* ===== 插件系统 mock(开工卡 G:假源 + 可装可卸的假插件)===== */

// 插件状态用 localStorage 持久化:停用/卸载会触发页面 reload,
// 内存态会丢,持久化才能让预览走查完整走通生命周期
interface MockInstalled {
  version: string;
  channel: "release" | "beta";
  enabled: boolean;
  sha256: string;
  installedAt: string;
  error: string | null;
  permissions: string[];
}

interface MockPluginsState {
  version: number;
  sources: Array<{
    id: string;
    name: string;
    provider: string;
    url: string;
    branch: string | null;
  }>;
  activeSourceId: string | null;
  installed: Record<string, MockInstalled>;
  mcp: { enabled: boolean };
}

function loadMockPlugins(): MockPluginsState {
  const fallback: MockPluginsState = {
    version: 1,
    sources: [
      {
        id: "official",
        name: "官方插件源(预览)",
        provider: "github",
        url: "https://github.com/prompt-vault/plugins",
        branch: null,
      },
    ],
    activeSourceId: "official",
    installed: {},
    mcp: { enabled: false },
  };
  try {
    const raw = localStorage.getItem("pv-mock-plugins");
    return raw ? (JSON.parse(raw) as MockPluginsState) : fallback;
  } catch {
    return fallback;
  }
}

let mockPlugins = loadMockPlugins();

function saveMockPlugins(): void {
  try {
    localStorage.setItem("pv-mock-plugins", JSON.stringify(mockPlugins));
  } catch {
    /* ignore */
  }
}

/** 假插件的包内 manifest(安装后由 plugin_installed_manifest 返回) */
const MOCK_MANIFESTS: Record<string, Record<string, unknown>> = {
  "demo-hello": {
    id: "demo-hello",
    name: "演示插件(预览)",
    version: "1.0.0",
    minAppVersion: "0.1.0",
    type: "standard",
    ui: "none",
    permissions: ["net:example.com", "window:float"],
  },
  "demo-clock": {
    id: "demo-clock",
    name: "时钟面板(预览)",
    version: "1.0.0",
    minAppVersion: "0.1.0",
    type: "standard",
    ui: "panel",
    permissions: [],
  },
  "demo-i18n": {
    id: "demo-i18n",
    name: "双语语言包(预览)",
    version: "1.0.0",
    minAppVersion: "0.1.0",
    type: "i18n",
    ui: "none",
    permissions: [],
    // 含一个非法码("bad code!"):宿主应跳过并 console.warn,不影响合法码
    languages: ["en", "zh-CN", "bad code!"],
  },
};

/**
 * 假插件的包内文件(pv-1:plugin_read_entry 返回源码,宿主包进 IIFE 内联执行,
 * 假插件在预览里可真实注入)。两个插件用于对抗性验证:
 *   - demo-hello(探针 A):顶层捕获桥 → 延迟 400ms(晚于 demo-clock 注入)后
 *     写 KV,断言记录落在 A 自己的 pluginId 下;
 *   - demo-clock(B):注入时立即注册面板。
 * 源码均为 pv-1 形态:只写 IIFE 函数体,直接使用闭包参数 pv,不引用 window.pv。
 */
const MOCK_PLUGIN_SOURCES: Record<string, Record<string, string>> = {
  "demo-hello": {
    "main.js": `// pv-1 探针 A:顶层捕获桥 → 延迟到后续插件注入完成后写 KV,验证归属
var mine = pv;
pv.commands.register({
  id: 'hello',
  label: '演示:问候(预览)',
  keywords: ['demo'],
  run: function () {
    console.log('[demo-hello] hello at', new Date().toISOString());
  }
});
window.setTimeout(function () {
  void mine.storage.set('probe', {
    from: mine.pluginId,
    bridgeVersion: mine.version,
    at: new Date().toISOString()
  });
}, 400);
`,
  },
  "demo-clock": {
    "main.js": `// pv-1 插件 B:注入时立即注册面板
pv.panel.register({
  id: 'clock',
  title: '时钟(预览)',
  render: function (el) {
    var tick = function () { el.textContent = new Date().toLocaleTimeString(); };
    tick();
    window.setInterval(tick, 1000);
  }
});
`,
  },
  "demo-i18n": {
    // 语言包为纯数据:无 main.js,只有 <语言码>.json(宿主启动消费,不注入脚本)
    "en.json": JSON.stringify({
      "toast.copied": "Copied to clipboard (pack)",
      "ph.tabMarket": "Market (pack)",
    }),
    "zh-CN.json": JSON.stringify({
      "toast.copied": "已复制到剪贴板(语言包)",
    }),
  },
};

interface MockChannel {
  version: string;
  url: string;
  sha256: string;
}

// 形状与 Rust parse_source_manifest 的输出一致:release/beta 为扁平顶层字段
const MOCK_MARKET: {
  name: string;
  plugins: Array<{
    id: string;
    name: string;
    desc: string;
    release: MockChannel | null;
    beta: MockChannel | null;
    minAppVersion: string;
    permissions: string[];
  }>;
} = {
  name: "官方插件源(预览)",
  plugins: [
    {
      id: "demo-hello",
      name: "演示插件",
      desc: "可安装/停用/卸载的假插件,用于预览走查(pv-1 探针)",
      release: {
        version: "1.0.0",
        url: "https://mock.local/demo-hello-1.0.0.zip",
        sha256: "aa".repeat(32),
      },
      beta: {
        version: "1.1.0-beta.1",
        url: "https://mock.local/demo-hello-1.1.0-beta.1.zip",
        sha256: "bb".repeat(32),
      },
      minAppVersion: "0.1.0",
      permissions: ["net:example.com", "window:float"],
    },
    {
      id: "demo-clock",
      name: "时钟面板",
      desc: "ui:panel 假插件,注入后注册插件区页签",
      release: {
        version: "1.0.0",
        url: "https://mock.local/demo-clock-1.0.0.zip",
        sha256: "cc".repeat(32),
      },
      beta: null,
      minAppVersion: "0.1.0",
      permissions: [],
    },
    {
      id: "demo-i18n",
      name: "双语语言包",
      desc: "type:i18n 假语言包,提供 en/zh-CN 两码(含非法码演示跳过)",
      release: {
        version: "1.0.0",
        url: "https://mock.local/demo-i18n-1.0.0.zip",
        sha256: "dd".repeat(32),
      },
      beta: null,
      minAppVersion: "0.1.0",
      permissions: [],
    },
  ],
};

function mockNowIso(): string {
  return new Date().toISOString();
}

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
    case "win_minimize":
    case "win_toggle_maximize":
    case "win_close":
      return null;
    case "win_is_maximized":
      return false;
    case "hide_quickpick":
      console.log("[mock] hide_quickpick");
      return null;
    case "open_editor":
      console.log("[mock] open_editor", args?.id);
      return null;
    /* ---- 插件系统命令 ---- */
    case "plugin_read_state":
      return JSON.stringify(mockPlugins, null, 2);
    case "plugin_write_state": {
      const parsed = JSON.parse(String(args?.json ?? "{}")) as MockPluginsState;
      if (!parsed.installed || typeof parsed.installed !== "object") {
        throw new Error("[mock] plugins.json 缺少 installed 对象");
      }
      mockPlugins = parsed;
      saveMockPlugins();
      console.log("[mock] plugin_write_state");
      return null;
    }
    case "plugin_fetch_source":
      console.log("[mock] plugin_fetch_source", args?.provider, args?.owner, args?.repo);
      return JSON.parse(JSON.stringify(MOCK_MARKET));
    case "plugin_install": {
      const id = String(args?.expectId ?? "");
      const entry = MOCK_MARKET.plugins.find((p) => p.id === id);
      if (!entry) throw new Error(`[mock] 安装失败:清单中无 ${id}`);
      const channel = args?.channel === "beta" ? "beta" : "release";
      const ref = entry[channel];
      if (!ref) throw new Error("[mock] 安装失败:该通道无可用包");
      if (!args?.sha256 || String(args.sha256).length !== 64) {
        throw new Error("[mock] 安装失败:sha256 不合法(演示校验失败路径)");
      }
      const prev = mockPlugins.installed[id];
      mockPlugins.installed[id] = {
        version: String(args?.expectVersion ?? ref.version),
        channel,
        enabled: prev ? prev.enabled : true,
        sha256: String(args?.sha256 ?? ""),
        installedAt: mockNowIso(),
        error: null,
        permissions: [...entry.permissions],
      };
      saveMockPlugins();
      console.log("[mock] plugin_install", id, channel);
      return { ok: true };
    }
    case "plugin_uninstall": {
      const id = String(args?.id ?? "");
      delete mockPlugins.installed[id];
      saveMockPlugins();
      console.log("[mock] plugin_uninstall", id);
      return null;
    }
    case "plugin_installed_manifest": {
      const id = String(args?.pluginId ?? "");
      return (MOCK_MANIFESTS[id] as Record<string, unknown> | undefined) ?? null;
    }
    case "plugin_read_entry": {
      const id = String(args?.pluginId ?? "");
      const rel = String(args?.relPath ?? "");
      const source = MOCK_PLUGIN_SOURCES[id]?.[rel];
      return source ?? null;
    }
    case "plugin_kv_get": {
      try {
        const raw = localStorage.getItem(`pv-mock-kv:${String(args?.pluginId ?? "")}`);
        const obj = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        return obj[String(args?.key ?? "")] ?? null;
      } catch {
        return null;
      }
    }
    case "plugin_kv_set": {
      const key = `pv-mock-kv:${String(args?.pluginId ?? "")}`;
      let obj: Record<string, unknown> = {};
      try {
        const raw = localStorage.getItem(key);
        if (raw) obj = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
      obj[String(args?.key ?? "")] = args?.value ?? null;
      localStorage.setItem(key, JSON.stringify(obj));
      return null;
    }
    case "plugin_open_window":
      console.log("[mock] plugin_open_window", args?.pluginId, args?.width, args?.height);
      return null;
    case "plugin_close_window":
      console.log("[mock] plugin_close_window", args?.pluginId);
      return null;
    case "plugin_net_fetch":
      console.log("[mock] plugin_net_fetch", args?.pluginId, args?.url);
      return { status: 200, body: "{}" };
    /* ---- i18n 手动语言包目录 mock:localStorage "pv-mock-locales" =
       Record<语言码, 目录> 即模拟 locales\<码>.json 文件 ---- */
    case "i18n_locales": {
      const dir = loadMockLocales();
      return Object.keys(dir)
        .sort()
        .map((code) => ({ code, fileName: `${code}.json`, error: null }));
    }
    case "i18n_locale_file": {
      const dir = loadMockLocales();
      const catalog = dir[String(args?.code ?? "")];
      return catalog ? JSON.stringify(catalog) : null;
    }
    default:
      throw new Error(`[mock] unknown command: ${cmd}`);
  }
}

function loadMockLocales(): Record<string, Record<string, string>> {
  try {
    const raw = localStorage.getItem("pv-mock-locales");
    return raw ? (JSON.parse(raw) as Record<string, Record<string, string>>) : {};
  } catch {
    return {};
  }
}
