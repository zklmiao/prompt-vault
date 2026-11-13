// 插件系统类型定义(契约 B:plugins.json 字段逐一对应,与 Rust 写端一致)

export type ProviderKind = "github" | "gitee" | "gitlab" | "gitea";

export interface SourceConfig {
  id: string;
  name: string;
  provider: ProviderKind;
  url: string;
  branch: string | null;
}

export interface InstalledEntry {
  version: string;
  channel: "release" | "beta";
  enabled: boolean;
  sha256: string;
  installedAt: string;
  error: string | null;
  permissions: string[] | null;
}

export interface PluginsState {
  version: number;
  sources: SourceConfig[];
  activeSourceId: string | null;
  installed: Record<string, InstalledEntry>;
  mcp: { enabled: boolean };
}

/** 仓库清单 pv-plugins.json(§3.2) */
export interface ChannelRef {
  version: string;
  url: string;
  sha256: string;
}

export interface MarketEntry {
  id: string;
  name: string;
  desc: string;
  release: ChannelRef | null;
  beta: ChannelRef | null;
  minAppVersion?: string;
  permissions: string[];
}

export interface SourceManifest {
  name: string;
  plugins: MarketEntry[];
}

/** 已安装插件包内 manifest.json(§2.2) */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion?: string;
  type: "standard" | "i18n";
  ui: "panel" | "window" | "none";
  permissions?: string[];
  /** i18n 型语言包声明提供的语言码(批次2消费;非法码由宿主跳过) */
  languages?: string[];
}

/** pv.net.fetch 选项(pv-0;与 net.rs NetFetchOpts 对应) */
export interface PvNetOpts {
  authFrom?: string;
  mode?: "raw" | "bearer" | "volcengine";
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface PvNetResponse {
  status: number;
  body: string;
}

export const DEFAULT_PLUGINS_STATE: PluginsState = {
  version: 1,
  sources: [],
  activeSourceId: null,
  installed: {},
  mcp: { enabled: false },
};
