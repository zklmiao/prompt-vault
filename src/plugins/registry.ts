// 插件注册表:pv.* 各通道注册内容的内存登记处(经典 script 注入模型,
// 每次注入前重设 window.pv 绑定;重启/重载后由宿主按 plugins.json 重新注入)。

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

export function markRegistered(pluginId: string): void {
  registered.add(pluginId);
}

export function hasRegistered(pluginId: string): boolean {
  return registered.has(pluginId);
}

/** 注入轮开始前清空(插件卸载/停用后 reload 重建,内存注册表随之重置) */
export function resetRegistry(): void {
  panels.clear();
  windowSetups.clear();
  commands.length = 0;
  i18nDicts.clear();
  registered.clear();
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
