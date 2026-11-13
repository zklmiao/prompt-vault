// pv 桥(pv-1):插件唯一可调用的宿主 API 面(设计 §2.3)。
// 注入模型:宿主把插件 main.js 源码包进 (function(pv){ … })(window.__pvSlot)
// 内联执行,桥随 IIFE 参数闭包封闭,插件在顶层捕获 pv 后异步使用也是自己的桥。
// 不存在持久的 window.pv 全局;window.__pvSlot 只在注入的同步执行瞬间有效。

import { kvGet, kvSet, pluginNetFetch } from "./api";
import {
  emitEvent,
  markRegistered,
  onEvent,
  registerCommand,
  registerI18n,
  registerPanel,
  registerWindowSetup,
} from "./registry";
import type { PvNetOpts, PvNetResponse } from "./types";

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
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  events: {
    on(name: string, cb: (payload: unknown) => void): () => void;
    emit(name: string, payload?: unknown): void;
  };
}

/** 构造绑定到指定插件 id 的桥对象(注入前挂到 window.__pvSlot,同步执行后清除) */
export function createBridge(pluginId: string): PvBridge {
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
