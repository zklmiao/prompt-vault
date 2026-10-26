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

export interface Draft {
  title: string;
  body: string;
  tags: string[];
  source: string;
  note: string;
  pinned: boolean;
}
