// 插件注册表:pv.* 各通道注册内容的内存登记处(pv-1 注入模型,桥经 IIFE
// 参数闭包封闭;重启/重载后由宿主按 plugins.json 重新注入)。

export interface PvPanelDef {
  id: string;
  title: string;
  render(el: HTMLElement): void;
}

export interface PvWindowSetup {
  size?: { width: number; height: number };
  onMount(el: HTMLElement): void;
}

export interface PvCommandDef {
  id: string;
  label: string;
  keywords?: string[];
  run(): void;
}

export interface PluginCommandEntry {
  pluginId: string;
  def: PvCommandDef;
}

const panels = new Map<string, PvPanelDef>(); // pluginId → 面板定义(ui:"panel")
const windowSetups = new Map<string, PvWindowSetup>(); // pluginId → 窗口 setup(ui:"window")
const commands: PluginCommandEntry[] = [];
const i18nDicts = new Map<string, unknown>(); // pluginId → 语言字典(批次1仅入注册表)
const eventBus = new Map<string, Set<(payload: unknown) => void>>();

/** 已发出任何 pv.* 注册的插件 id(3s 超时判定依据) */
const registered = new Set<string>();

/** 等待注册的 resolver(waitForRegistered;markRegistered 时信号唤醒,替代轮询) */
const pendingWaits = new Map<string, Array<(ok: boolean) => void>>();

export function markRegistered(pluginId: string): void {
  registered.add(pluginId);
  // 唤醒并清理所有等待者;删除后再 resolve,避免回调内再入时重复触发
  const waiters = pendingWaits.get(pluginId);
  if (waiters) {
    pendingWaits.delete(pluginId);
    for (const fn of waiters) fn(true);
  }
}

export function hasRegistered(pluginId: string): boolean {
  return registered.has(pluginId);
}

/**
 * 等待插件发出首个 pv.* 注册:markRegistered 信号即时唤醒 resolve(true);
 * 超时兜底 resolve(false)。调用前已注册则短路 resolve(true)。
 * 完成时(信号或超时)从映射中清理本等待者,防泄漏。
 */
export function waitForRegistered(pluginId: string, timeoutMs: number): Promise<boolean> {
  if (registered.has(pluginId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      const arr = pendingWaits.get(pluginId);
      if (arr) {
        const idx = arr.indexOf(finish);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) pendingWaits.delete(pluginId);
      }
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const arr = pendingWaits.get(pluginId) ?? [];
    arr.push(finish);
    pendingWaits.set(pluginId, arr);
  });
}

/** 注入轮开始前清空(插件卸载/停用后 reload 重建,内存注册表随之重置);
 *  在途等待者 resolve(false) 解除阻塞 */
export function resetRegistry(): void {
  panels.clear();
  windowSetups.clear();
  commands.length = 0;
  i18nDicts.clear();
  registered.clear();
  const waiters = [...pendingWaits.values()];
  pendingWaits.clear();
  for (const arr of waiters) {
    for (const fn of arr) fn(false);
  }
}

export function registerPanel(pluginId: string, def: PvPanelDef): void {
  panels.set(pluginId, def);
}

export function getPanel(pluginId: string): PvPanelDef | undefined {
  return panels.get(pluginId);
}

export function registeredPanels(): Array<{ pluginId: string; def: PvPanelDef }> {
  return [...panels.entries()].map(([pluginId, def]) => ({ pluginId, def }));
}

export function registerWindowSetup(pluginId: string, setup: PvWindowSetup): void {
  windowSetups.set(pluginId, setup);
}

export function getWindowSetup(pluginId: string): PvWindowSetup | undefined {
  return windowSetups.get(pluginId);
}

export function registerCommand(pluginId: string, def: PvCommandDef): void {
  // 同 id 覆盖:插件热重载/重复注册时以后到为准
  const idx = commands.findIndex(
    (c) => c.pluginId === pluginId && c.def.id === def.id,
  );
  if (idx >= 0) commands[idx] = { pluginId, def };
  else commands.push({ pluginId, def });
}

export function pluginCommands(): PluginCommandEntry[] {
  return [...commands];
}

export function registerI18n(pluginId: string, dict: unknown): void {
  i18nDicts.set(pluginId, dict);
}

/** 注入完成后读取插件注册的语言字典(键 = 语言码;宿主并入 i18n 目录链) */
export function getI18nDict(pluginId: string): unknown | undefined {
  return i18nDicts.get(pluginId);
}

/** 宿主事件总线:插件间解耦通信(仅主窗口 webview 内有效) */
export function onEvent(name: string, cb: (payload: unknown) => void): () => void {
  let set = eventBus.get(name);
  if (!set) {
    set = new Set();
    eventBus.set(name, set);
  }
  set.add(cb);
  return () => {
    set?.delete(cb);
  };
}

export function emitEvent(name: string, payload?: unknown): void {
  const set = eventBus.get(name);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(payload);
    } catch (e) {
      console.error(`[pv] 事件处理器异常(${name}):`, e);
    }
  }
}
