import type { PromptItem } from "../types";
import { formatDate } from "../util";
import TagChips from "./TagChips";
import { IconCopy } from "./icons";

interface Props {
  items: PromptItem[];
  total: number;
  trashOpen: boolean;
  selectedId: string | null;
  selectedIds: Set<string>;
  onRowClick: (id: string, e: React.MouseEvent) => void;
  onCheckbox: (id: string) => void;
  onTagClick: (tag: string) => void;
  onQuickCopy: (item: PromptItem) => void;
}

export default function Sidebar({
  items,
  total,
  trashOpen,
  selectedId,
  selectedIds,
  onRowClick,
  onCheckbox,
  onTagClick,
  onQuickCopy,
}: Props) {
  const head = trashOpen
    ? `回收站 ${items.length} 条`
    : items.length === total
      ? `共 ${total} 条`
      : `匹配 ${items.length} / ${total} 条`;

  const selecting = selectedIds.size > 0;

  return (
    <aside className="sidebar">
      <div className="list-head">{head}</div>
      <div className={"list" + (selecting ? " selecting" : "")}>
        {items.map((it) => {
          const checked = selectedIds.has(it.id);
          return (
            <div
              key={it.id}
              className={
                "row" +
                (it.id === selectedId ? " active" : "") +
                (checked ? " checked" : "")
              }
              onClick={(e) => onRowClick(it.id, e)}
            >
              <input
                type="checkbox"
                className="row-check"
                checked={checked}
                onChange={() => onCheckbox(it.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`选择「${it.title || "未命名"}」`}
              />
              <div className="row-title">
                {!trashOpen && it.pinned && <span className="star">★ </span>}
                {it.title || "未命名"}
              </div>
              {trashOpen ? (
                <div className="row-sub">
                  删除于 {formatDate(it.deletedAt)}
                </div>
              ) : (
                it.tags.length > 0 && (
                  <div className="row-tags">
                    <TagChips tags={it.tags} onTagClick={onTagClick} />
                  </div>
                )
              )}
              {!trashOpen && !selecting && (
                <button
                  type="button"
                  className="row-copy"
                  title="复制"
                  onClick={(e) => {
                    e.stopPropagation();
                    onQuickCopy(it);
                  }}
                >
                  <IconCopy size={14} />
                </button>
              )}
            </div>
          );
        })}
        {items.length === 0 && (
          <div className="list-empty">
            {trashOpen
              ? "回收站是空的。"
              : total === 0
                ? "还没有收藏。点击右上角「新建」添加第一条 prompt。"
                : "没有匹配的收藏,换个关键词试试。"}
          </div>
        )}
      </div>
    </aside>
  );
}
