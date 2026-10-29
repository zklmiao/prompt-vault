import { useState } from "react";
import type { Draft, Mode, NewPrefill, PromptItem } from "../types";
import { extractPlaceholders, formatDate, isComposingEvent } from "../util";
import TagInput from "./TagInput";
import TagChips from "./TagChips";
import BodyText from "./BodyText";
import Onboarding, { type OnboardingProps } from "./Onboarding";
import {
  IconCopy,
  IconEdit,
  IconPin,
  IconTrash,
  IconUndo,
} from "./icons";

interface Props {
  item: PromptItem | null;
  mode: Mode;
  allTags: string[];
  trashOpen: boolean;
  /** 当前视图(主列表 / 回收站)是否存在条目;用于区分"无数据"与"有数据但未选中" */
  hasItems: boolean;
  onSave: (draft: Draft) => void | Promise<void>;
  onCancel: () => void;
  onEdit: () => void;
  onCopy: (item: PromptItem) => void | Promise<void>;
  onTogglePin: (item: PromptItem) => void | Promise<void>;
  onDelete: (item: PromptItem) => void;
  onTagClick: (tag: string) => void;
  onRestore: (item: PromptItem) => void | Promise<void>;
  onPurge: (item: PromptItem) => void;
  prefill: NewPrefill | null;
  prefillSeq: number;
  /** 首次启动引导;仅空态且未跳过时传入 */
  onboarding: OnboardingProps | null;
}

function draftFrom(item: PromptItem | null, prefill: NewPrefill | null): Draft {
  return {
    title: item?.title ?? prefill?.title ?? "",
    body: item?.body ?? prefill?.body ?? "",
    tags: item?.tags ?? prefill?.tags ?? [],
    source: item?.source ?? prefill?.source ?? "",
    note: item?.note ?? prefill?.note ?? "",
    pinned: item?.pinned ?? false,
  };
}

export default function DetailPane({
  item,
  mode,
  allTags,
  trashOpen,
  hasItems,
  onSave,
  onCancel,
  onEdit,
  onCopy,
  onTogglePin,
  onDelete,
  onTagClick,
  onRestore,
  onPurge,
  prefill,
  prefillSeq,
  onboarding,
}: Props) {
  if (mode.kind === "new") {
    const heading = !prefill
      ? "新建 Prompt"
      : prefill.source?.startsWith("拖入:")
        ? "从拖入文件新建"
        : prefill.source === "引导示例"
          ? "创建示例 Prompt"
          : "从剪贴板新建";
    return (
      <Editor
        key={`new-${prefillSeq}`}
        heading={heading}
        initial={draftFrom(null, prefill)}
        allTags={allTags}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }
  if (mode.kind === "edit") {
    const target = mode.id === item?.id ? item : null;
    return (
      <Editor
        key={`edit-${mode.id}`}
        heading="编辑 Prompt"
        initial={draftFrom(target, null)}
        allTags={allTags}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  if (!item) {
    if (onboarding) {
      return (
        <section className="detail">
          <div className="detail-inner">
            <Onboarding {...onboarding} />
          </div>
        </section>
      );
    }
    const title = trashOpen
      ? hasItems
        ? "在左侧选择一条收藏查看详情"
        : "回收站是空的"
      : hasItems
        ? "在左侧选择一条收藏查看详情"
        : "还没有收藏";
    const hint = trashOpen
      ? hasItems
        ? "点击左侧条目可查看、恢复或彻底删除。"
        : "删除的收藏会先放进这里,可随时恢复。"
      : hasItems
        ? "Ctrl+F 搜索,或点击左侧列表选择。"
        : "把好用的 prompt 存进来,随时搜索、一键复制。";
    return (
      <section className="detail">
        <div className="detail-inner empty-state">
          <svg
            width="120"
            height="96"
            viewBox="0 0 120 96"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="14"
              y="18"
              width="64"
              height="48"
              rx="8"
              stroke="var(--border-strong)"
              strokeWidth="2"
            />
            <rect
              x="30"
              y="30"
              width="64"
              height="48"
              rx="8"
              fill="var(--panel)"
              stroke="var(--accent)"
              strokeWidth="2"
            />
            <path
              d="M40 46h32M40 56h20"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
              opacity="0.55"
            />
            <path
              d="M98 14l2.2 5.8L106 22l-5.8 2.2L98 30l-2.2-5.8L90 22l5.8-2.2z"
              fill="var(--star)"
            />
          </svg>
          <p className="empty-title">{title}</p>
          <p className="muted">{hint}</p>
        </div>
      </section>
    );
  }

  const isTrash = trashOpen && !!item.deletedAt;
  const phCount = extractPlaceholders(item.body).length;

  return (
    <section className="detail">
      <div className="detail-inner stagger" key={item.id}>
        <div className="detail-head">
          <h2 className="detail-title">
            {!trashOpen && item.pinned && <span className="star">★ </span>}
            {item.title || "未命名"}
          </h2>
          {!trashOpen && (
            <button
              className={"btn small" + (item.pinned ? " pin-on" : "")}
              onClick={() => void onTogglePin(item)}
            >
              <IconPin size={13} />
              {item.pinned ? "已置顶" : "置顶"}
            </button>
          )}
        </div>

        {item.tags.length > 0 && (
          <div className="detail-tags">
            <TagChips tags={item.tags} onTagClick={onTagClick} />
          </div>
        )}
        {phCount > 0 && (
          <span className="ph-badge">{phCount} 个变量</span>
        )}

        {item.source && (
          <div className="detail-line">
            <span className="label">来源</span>
            <span className="value"> {item.source}</span>
          </div>
        )}
        {item.note && (
          <div className="detail-line">
            <span className="label">备注</span>
            <span className="value"> {item.note}</span>
          </div>
        )}

        <pre className="body-view">
          <BodyText text={item.body} />
        </pre>

        <div className="detail-actions">
          {isTrash ? (
            <>
              <button className="btn primary" onClick={() => void onRestore(item)}>
                <IconUndo size={15} /> 恢复
              </button>
              <button className="btn danger" onClick={() => onPurge(item)}>
                <IconTrash size={15} /> 彻底删除
              </button>
              <button className="btn" onClick={() => void onCopy(item)}>
                <IconCopy size={15} /> 复制
              </button>
            </>
          ) : (
            <>
              <button className="btn primary" onClick={() => void onCopy(item)}>
                <IconCopy size={15} /> 复制
              </button>
              <button className="btn" onClick={onEdit}>
                <IconEdit size={15} /> 编辑
              </button>
              <button className="btn" onClick={() => onDelete(item)}>
                <IconTrash size={15} /> 删除
              </button>
            </>
          )}
        </div>

        <div className="meta">
          {(item.copyCount ?? 0) > 0
            ? `已复制 ${item.copyCount} 次 · 最近复制 ${formatDate(item.lastCopiedAt)} · `
            : ""}
          {isTrash
            ? `删除于 ${formatDate(item.deletedAt)} · 更新于 ${formatDate(item.updatedAt)}`
            : `创建于 ${formatDate(item.createdAt)} · 更新于 ${formatDate(item.updatedAt)}`}
        </div>
      </div>
    </section>
  );
}

function Editor({
  heading,
  initial,
  allTags,
  onSave,
  onCancel,
}: {
  heading: string;
  initial: Draft;
  allTags: string[];
  onSave: (draft: Draft) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(initial);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = () => {
    const finalDraft: Draft = {
      ...draft,
      title: draft.title.trim() || "未命名",
    };
    void onSave(finalDraft);
  };

  const ctrlEnter = (e: React.KeyboardEvent) => {
    // 组字期间不触发保存,让输入法完成选字
    if (isComposingEvent(e)) return;
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      save();
    }
  };

  const phCount = extractPlaceholders(draft.body).length;

  return (
    <section className="detail">
      <div className="detail-inner">
        <h2 className="detail-title">{heading}</h2>

        <label className="field">
          <span className="label">标题</span>
          <input
            autoFocus
            value={draft.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="给这条 prompt 起个名字"
            onKeyDown={ctrlEnter}
          />
        </label>

        <div className="field">
          <span className="label">标签(回车添加)</span>
          <TagInput
            value={draft.tags}
            onChange={(tags) => set("tags", tags)}
            suggestions={allTags}
          />
        </div>

        <label className="field">
          <span className="label">来源(可选)</span>
          <input
            value={draft.source}
            onChange={(e) => set("source", e.target.value)}
            placeholder="从哪里来的,比如某篇文章 / 某个工具"
          />
        </label>

        <label className="field">
          <span className="label">备注(可选)</span>
          <textarea
            rows={2}
            value={draft.note}
            onChange={(e) => set("note", e.target.value)}
            placeholder="适用场景、使用心得等"
          />
        </label>

        <div className="field grow">
          <span className="label">
            正文
            {phCount > 0 && (
              <span className="ph-badge inline">{phCount} 个变量</span>
            )}
            <span className="label-hint">支持 {"{{变量名}}"} 占位符,复制时可填空</span>
          </span>
          <textarea
            className="mono"
            value={draft.body}
            onChange={(e) => set("body", e.target.value)}
            placeholder="把 prompt 正文粘贴到这里…&#10;例如:请审查以下代码变更:{{diff}},重点关注 {{关注点}}。"
            onKeyDown={ctrlEnter}
          />
        </div>

        <div className="detail-actions">
          <button className="btn primary" onClick={save}>
            保存 (Ctrl+Enter)
          </button>
          <button className="btn" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </section>
  );
}
