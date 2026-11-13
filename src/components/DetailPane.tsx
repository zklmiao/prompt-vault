import { useState } from "react";
import type { Draft, Mode, NewPrefill, PromptItem } from "../types";
import { extractPlaceholders, formatDate, isComposingEvent } from "../util";
import { useI18n } from "../i18n";
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

/** 元信息行:各段独立成键,空段剔除后用「 · 」连接(与原拼接输出逐字一致) */
function joinMeta(parts: string[]): string {
  return parts.filter((p) => p !== "").join(" · ");
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
  const { t } = useI18n();

  if (mode.kind === "new") {
    const heading = !prefill
      ? t("editor.headingNew")
      : prefill.kind === "drop"
        ? t("editor.headingNewFromDrop")
        : prefill.kind === "sample"
          ? t("editor.headingNewFromSample")
          : t("editor.headingNewFromClipboard");
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
        heading={t("editor.headingEdit")}
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
        ? t("detail.emptyTitleHasItems")
        : t("detail.emptyTitleTrashEmpty")
      : hasItems
        ? t("detail.emptyTitleHasItems")
        : t("detail.emptyTitleNoItems");
    const hint = trashOpen
      ? hasItems
        ? t("detail.emptyHintTrashHasItems")
        : t("detail.emptyHintTrashEmpty")
      : hasItems
        ? t("detail.emptyHintHasItems")
        : t("detail.emptyHintNoItems");
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
            {item.title || t("common.untitled")}
          </h2>
          {!trashOpen && (
            <button
              className={"btn small" + (item.pinned ? " pin-on" : "")}
              onClick={() => void onTogglePin(item)}
            >
              <IconPin size={13} />
              {item.pinned ? t("detail.unpin") : t("detail.pin")}
            </button>
          )}
        </div>

        {item.tags.length > 0 && (
          <div className="detail-tags">
            <TagChips tags={item.tags} onTagClick={onTagClick} />
          </div>
        )}
        {phCount > 0 && (
          <span className="ph-badge">{t("detail.varCount", { n: phCount })}</span>
        )}

        {item.source && (
          <div className="detail-line">
            <span className="label">{t("common.source")}</span>
            <span className="value"> {item.source}</span>
          </div>
        )}
        {item.note && (
          <div className="detail-line">
            <span className="label">{t("common.note")}</span>
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
                <IconUndo size={15} /> {t("detail.restore")}
              </button>
              <button className="btn danger" onClick={() => onPurge(item)}>
                <IconTrash size={15} /> {t("detail.purge")}
              </button>
              <button className="btn" onClick={() => void onCopy(item)}>
                <IconCopy size={15} /> {t("common.copy")}
              </button>
            </>
          ) : (
            <>
              <button className="btn primary" onClick={() => void onCopy(item)}>
                <IconCopy size={15} /> {t("common.copy")}
              </button>
              <button className="btn" onClick={onEdit}>
                <IconEdit size={15} /> {t("detail.edit")}
              </button>
              <button className="btn" onClick={() => onDelete(item)}>
                <IconTrash size={15} /> {t("detail.delete")}
              </button>
            </>
          )}
        </div>

        <div className="meta">
          {joinMeta([
            (item.copyCount ?? 0) > 0
              ? t("detail.metaCopied", { n: item.copyCount ?? 0 })
              : "",
            (item.copyCount ?? 0) > 0
              ? t("detail.metaLastCopy", { date: formatDate(item.lastCopiedAt) })
              : "",
            isTrash
              ? t("detail.metaDeletedAt", { date: formatDate(item.deletedAt) })
              : t("detail.metaCreatedAt", { date: formatDate(item.createdAt) }),
            t("detail.metaUpdatedAt", { date: formatDate(item.updatedAt) }),
          ])}
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
  const { t } = useI18n();
  const [draft, setDraft] = useState<Draft>(initial);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = () => {
    const finalDraft: Draft = {
      ...draft,
      title: draft.title.trim() || t("common.untitled"),
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
          <span className="label">{t("editor.titleLabel")}</span>
          <input
            autoFocus
            value={draft.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder={t("editor.titlePlaceholder")}
            onKeyDown={ctrlEnter}
          />
        </label>

        <div className="field">
          <span className="label">{t("editor.tagsLabel")}</span>
          <TagInput
            value={draft.tags}
            onChange={(tags) => set("tags", tags)}
            suggestions={allTags}
          />
        </div>

        <label className="field">
          <span className="label">{t("editor.sourceLabel")}</span>
          <input
            value={draft.source}
            onChange={(e) => set("source", e.target.value)}
            placeholder={t("editor.sourcePlaceholder")}
          />
        </label>

        <label className="field">
          <span className="label">{t("editor.noteLabel")}</span>
          <textarea
            rows={2}
            value={draft.note}
            onChange={(e) => set("note", e.target.value)}
            placeholder={t("editor.notePlaceholder")}
          />
        </label>

        <div className="field grow">
          <span className="label">
            {t("editor.bodyLabel")}
            {phCount > 0 && (
              <span className="ph-badge inline">{t("detail.varCount", { n: phCount })}</span>
            )}
            <span className="label-hint">{t("editor.bodyHint")}</span>
          </span>
          <textarea
            className="mono"
            value={draft.body}
            onChange={(e) => set("body", e.target.value)}
            placeholder={t("editor.bodyPlaceholder")}
            onKeyDown={ctrlEnter}
          />
        </div>

        <div className="detail-actions">
          <button className="btn primary" onClick={save}>
            {t("editor.save")}
          </button>
          <button className="btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </section>
  );
}
