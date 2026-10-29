export interface PromptItem {
  id: string;
  title: string;
  body: string;
  tags: string[];
  source: string;
  note: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  /** 复制时占位符弹窗最近一次的填写值,用于下次预填 */
  lastValues?: Record<string, string>;
  /** 软删除时间;存在即表示处于回收站 */
  deletedAt?: string;
  /** 成功复制到剪贴板的次数;首次复制后才写入文件 */
  copyCount?: number;
  /** 最近一次成功复制的时间 */
  lastCopiedAt?: string;
}

export interface DataFile {
  version: 1;
  prompts: PromptItem[];
}

export type Mode =
  | { kind: "view" }
  | { kind: "edit"; id: string }
  | { kind: "new" };

export type ImportMode = "merge" | "overwrite";

export type Theme = "light" | "dark";

/** 列表排序:最近更新 / 最近复制 / 最常复制(置顶始终在最前) */
export type SortMode = "updated" | "recent" | "most";

/** 带内容进入新建编辑态时的预填(剪贴板 / 拖入文件 / 首次引导示例) */
export interface NewPrefill {
  title?: string;
  body?: string;
  source?: string;
  tags?: string[];
  note?: string;
}

export interface Draft {
  title: string;
  body: string;
  tags: string[];
  source: string;
  note: string;
  pinned: boolean;
}
