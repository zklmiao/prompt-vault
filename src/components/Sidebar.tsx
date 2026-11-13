import type { PromptItem, SortMode } from "../types";
import { formatDate } from "../util";
import { useI18n } from "../i18n";
import TagChips from "./TagChips";
import { IconCopy } from "./icons";

interface Props {
  items: PromptItem[];
  total: number;
  trashOpen: boolean;
  sortMode: SortMode;
  onSortChange: (mode: SortMode) => void;
  selectedId: string | null;
  selectedIds: Set<string>;
  onRowClick: (id: string, e: React.MouseEvent) => void;
  onRowFocus: (id: string) => void;
  onCheckbox: (id: string) => void;
  onTagClick: (tag: string) => void;
  onQuickCopy: (item: PromptItem) => void;
}

export default function Sidebar({
  items,
  total,
  trashOpen,
  sortMode,
  onSortChange,
  selectedId,
  selectedIds,
  onRowClick,
  onRowFocus,
  onCheckbox,
  onTagClick,
  onQuickCopy,
}: Props) {
  const { t } = useI18n();

  const head = trashOpen
    ? t("sidebar.trashCount", { n: items.length })
    : items.length === total
      ? t("sidebar.countAll", { n: total })
      : t("sidebar.countMatch", { n: items.length, total });

  const selecting = selectedIds.size > 0;

  return (
    <aside className="sidebar">
      <div className="list-head">
        <span>{head}</span>
        {!trashOpen && (
          <select
            className="sort-select"
            value={sortMode}
            onChange={(e) => onSortChange(e.target.value as SortMode)}
            title={t("sidebar.sortTitle")}
            aria-label={t("sidebar.sortAria")}
          >
            <option value="updated">{t("sidebar.sortUpdated")}</option>
            <option value="recent">{t("sidebar.sortRecent")}</option>
            <option value="most">{t("sidebar.sortMost")}</option>
          </select>
        )}
      </div>
      <div
        className={"list" + (selecting ? " selecting" : "")}
        role="listbox"
        aria-multiselectable="true"
        aria-label={trashOpen ? t("sidebar.trashListAria") : t("sidebar.listAria")}
        id="pv-list"
      >
        {items.map((it, index) => {
          const checked = selectedIds.has(it.id);
          // roving tabindex:整组一个 Tab 停靠点;无选中项时第一行可聚焦
          const isTabStop = selectedId ? it.id === selectedId : index === 0;
          return (
            <div
              key={it.id}
              id={`pv-row-${it.id}`}
              role="option"
              aria-selected={checked}
              tabIndex={isTabStop ? 0 : -1}
              className={
                "row" +
                (it.id === selectedId ? " active" : "") +
                (checked ? " checked" : "")
              }
              onClick={(e) => onRowClick(it.id, e)}
              onFocus={(e) => {
                // 行内按钮/复选框获得焦点时不改变活动项
                const target = e.target as HTMLElement;
                if (target.closest("button") || target.tagName === "INPUT") return;
                onRowFocus(it.id);
              }}
            >
              <input
                type="checkbox"
                className="row-check"
                checked={checked}
                onChange={() => onCheckbox(it.id)}
                onClick={(e) => e.stopPropagation()}
                tabIndex={-1}
                aria-label={t("sidebar.ariaSelect", {
                  name: it.title || t("common.untitled"),
                })}
              />
              <div className="row-title">
                {!trashOpen && it.pinned && <span className="star">★ </span>}
                {it.title || t("common.untitled")}
              </div>
              {trashOpen ? (
                <div className="row-sub">
                  {t("detail.metaDeletedAt", { date: formatDate(it.deletedAt) })}
                </div>
              ) : (
                <>
                  {it.tags.length > 0 && (
                    <div className="row-tags">
                      <TagChips tags={it.tags} onTagClick={onTagClick} />
                    </div>
                  )}
                  {(it.copyCount ?? 0) > 0 && (
                    <div className="row-stats">
                      {t("common.statsCopied", {
                        n: it.copyCount ?? 0,
                        date: formatDate(it.lastCopiedAt),
                      })}
                    </div>
                  )}
                </>
              )}
              {!trashOpen && !selecting && (
                <button
                  type="button"
                  className="row-copy"
                  title={t("common.copy")}
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
              ? t("sidebar.emptyTrash")
              : total === 0
                ? t("sidebar.emptyAll")
                : t("sidebar.emptyNoMatch")}
          </div>
        )}
      </div>
    </aside>
  );
}
