// pv 桥(pv-1):插件唯一可调用的宿主 API 面(设计 §2.3)。
// 注入模型:宿主把插件 main.js 源码包进 (function(pv){ … })(window.__pvSlot)
// 内联执行,桥随 IIFE 参数闭包封闭,插件在顶层捕获 pv 后异步使用也是自己的桥。
// 不存在持久的 window.pv 全局;window.__pvSlot 只在注入的同步执行瞬间有效。

import {
  kvGet,
  kvSet,
  pluginCredentialConfigured,
  pluginCredentialDelete,
  pluginCredentialSet,
  pluginCloseWindow,
  pluginNetFetch,
  pluginNotify,
  pluginResizeWindow,
  pluginShowMainPanel,
} from "./api";
import {
  emitEvent,
  markRegistered,
  onEvent,
  registerCommand,
  registerI18n,
  registerPanel,
  registerWindowSetup,
} from "./registry";
import type { PluginManifest, PvNetOpts, PvNetResponse } from "./types";

export const PV_API_VERSION = "pv-1";

declare global {
  interface Window {
    /**
     * 一次性注入槽位:宿主每次注入前重赋值为当前插件的桥,注入脚本同步
     * 执行完毕后立即清除。恶意插件改写此属性无影响——宿主不读取槽位的
     * 残留值,每次注入都重新赋值;读取只发生在 appendChild 的同步执行瞬间。
     */
    __pvSlot?: PvBridge;
  }
}

export interface PvCommandInput {
  id: string;
  label: string;
  keywords?: string[];
  run(): void;
}

export interface PvBridge {
  readonly version: "pv-1";
  readonly pluginId: string;
  panel: {
    register(def: { id: string; title: string; render(el: HTMLElement): void }): void;
  };
  window: {
    setup(setup: {
      size?: { width: number; height: number };
      onMount(el: HTMLElement): void;
    }): void;
    /** 隐藏本插件窗口(即关闭;唤出经主窗口插件区) */
    hide(): Promise<void>;
    /** 唤出主窗口并激活本插件的详情面板页签 */
    openPanel(): Promise<void>;
    /** 调整本插件窗口尺寸(逻辑像素;球窗右键菜单临时扩窗,收起后恢复) */
    resize(width: number, height: number): Promise<void>;
  };
  credentials: {
    /** 写入 scope 凭据;仅当 manifest 声明 credential:<provider>(scope 的
     *  provider 段 == 声明的 provider,label 账号按 provider 前缀覆盖,fail-closed) */
    set(scope: string, secret: string): Promise<void>;
    /** 删除 scope 凭据;仅当 manifest 声明 credential:<provider>(同上) */
    delete(scope: string): Promise<void>;
    /**
     * 无参:manifest 声明的 credential: scope 中已配置(env/keyring)的列表,不含秘密;
     * 带参(多账号 `<provider>:<label>`):探查该账号是否已配置 —— 声明的
     * credential:<provider> 按 provider 前缀覆盖其全部 label 账号(fail-closed,
     * 未声明 provider 时抛错);返回布尔而非数组,便于逐账号徽标探测
     */
    configured(scope?: string): Promise<string[] | boolean>;
  };
  commands: {
    register(def: PvCommandInput): void;
  };
  i18n: {
    register(dict: Record<string, Record<string, string>>): void;
  };
  net: {
    fetch(url: string, opts?: PvNetOpts): Promise<PvNetResponse>;
  };
  /** 发送系统通知(Windows 通知中心);仅当 manifest 声明 "notify"(fail-closed,
   *  与 credential/net 同模式;Rust 侧另有调用者插件窗口 + 权限快照的双闸) */
  notify(title: string, body: string): Promise<void>;
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  events: {
    on(name: string, cb: (payload: unknown) => void): () => void;
    emit(name: string, payload?: unknown): void;
  };
}

/** 构造绑定到指定插件 id 的桥对象(注入前挂到 window.__pvSlot,同步执行后清除)。
 *  manifest 为安装时快照(manifest.json);为 null 时权限集为空,fail-closed */
export function createBridge(pluginId: string, manifest: PluginManifest | null): PvBridge {
  // 权限快照同步判权:闭包持有,凭据/窗口等敏感通道在 invoke 前判定
  const permissions: string[] = Array.isArray(manifest?.permissions)
    ? manifest.permissions.filter((p): p is string => typeof p === "string")
    : [];
  const hasPermission = (p: string): boolean => permissions.includes(p);
  /** 多账号 scope(`provider[:label]`)的 provider 段 */
  const scopeProvider = (scope: string): string => scope.split(":")[0] ?? "";
  /** 凭据权限按 provider 前缀门控:声明 credential:<provider> 覆盖该 provider
   *  全部 label 账号,跨 provider 借道拒绝(与 Rust credential_allowed 同规则) */
  const requireCredentialPermission = (scope: string): void => {
    const provider = scopeProvider(scope);
    if (provider === "" || !hasPermission(`credential:${provider}`)) {
      throw new Error("插件未声明该凭据权限");
    }
  };
  return {
    version: PV_API_VERSION,
    pluginId,
    panel: {
      register(def) {
        markRegistered(pluginId);
        registerPanel(pluginId, def);
      },
    },
    window: {
      setup(setup) {
        markRegistered(pluginId);
        registerWindowSetup(pluginId, setup);
      },
      async hide(): Promise<void> {
        await pluginCloseWindow(pluginId);
      },
      async openPanel(): Promise<void> {
        await pluginShowMainPanel(pluginId);
      },
      async resize(width: number, height: number): Promise<void> {
        await pluginResizeWindow(pluginId, width, height);
      },
    },
    credentials: {
      async set(scope, secret): Promise<void> {
        if (typeof scope !== "string" || scope === "") {
          throw new Error("凭据 scope 不合法");
        }
        if (typeof secret !== "string" || secret === "") {
          throw new Error("凭据内容不能为空");
        }
        requireCredentialPermission(scope);
        await pluginCredentialSet(scope, secret);
      },
      async delete(scope): Promise<void> {
        if (typeof scope !== "string" || scope === "") {
          throw new Error("凭据 scope 不合法");
        }
        requireCredentialPermission(scope);
        await pluginCredentialDelete(scope);
      },
      async configured(scope?: string): Promise<string[] | boolean> {
        if (scope !== undefined) {
          if (typeof scope !== "string" || scope === "") {
            throw new Error("凭据 scope 不合法");
          }
          requireCredentialPermission(scope);
          return pluginCredentialConfigured(scope).catch(() => false);
        }
        const out: string[] = [];
        for (const p of permissions) {
          if (!p.startsWith("credential:")) continue;
          const s = p.slice("credential:".length);
          const ok = await pluginCredentialConfigured(s).catch(() => false);
          if (ok) out.push(s);
        }
        return out;
      },
    },
    commands: {
      register(def) {
        markRegistered(pluginId);
        registerCommand(pluginId, def);
      },
    },
    i18n: {
      register(dict) {
        markRegistered(pluginId);
        registerI18n(pluginId, dict);
      },
    },
    net: {
      async fetch(url, opts): Promise<PvNetResponse> {
        return pluginNetFetch(pluginId, url, opts);
      },
    },
    async notify(title, body): Promise<void> {
      if (!hasPermission("notify")) {
        throw new Error("插件未声明通知权限");
      }
      await pluginNotify(title, body);
    },
    storage: {
      async get(key): Promise<unknown> {
        return kvGet(pluginId, key);
      },
      async set(key, value): Promise<void> {
        await kvSet(pluginId, key, value);
      },
    },
    events: {
      on(name, cb): () => void {
        return onEvent(name, cb);
      },
      emit(name, payload?): void {
        emitEvent(name, payload);
      },
    },
  };
}
