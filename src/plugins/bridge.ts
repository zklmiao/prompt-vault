// pv 桥(pv-0):插件唯一可调用的宿主 API 面(设计 §2.3)。
// 经典 script 注入模型下 window.pv 在每次注入前被宿主重绑到对应插件 id
// (见 host.ts);插件应在脚本顶层同步使用 pv.* 完成注册与引用捕获。

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

export const PV_API_VERSION = "pv-0";

declare global {
  interface Window {
    /** 插件桥(每次注入前由宿主重绑到对应插件) */
    pv?: PvBridge;
  }
}

export interface PvCommandInput {
  id: string;
  label: string;
  keywords?: string[];
  run(): void;
}

export interface PvBridge {
  readonly version: "pv-0";
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

/** 构造绑定到指定插件 id 的桥对象(注入前挂到 window.pv) */
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
