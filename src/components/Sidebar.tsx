import type { PromptItem, SortMode } from "../types";
import { formatDate } from "../util";
import { useI18n } from "../i18n";
import TagChips from "./TagChips";
import { IconButterfly, IconCopy } from "./icons";

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
  /** 私人彩蛋「密语暗屉」:命中密语时在 list-head 与列表之间浮现(阶段 1 走夹具) */
  eggOpen: boolean;
  /** 彩蛋正文由 App 传入:显示与复制同源,避免文案双处维护 */
  eggBody: string;
  onEggCopy: () => void;
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
  eggOpen,
  eggBody,
  onEggCopy,
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
      {eggOpen && (
        /* 私人彩蛋「密语暗屉」:listbox 语义之外的隐藏卡片;文案硬编码中文,
           不进 i18n(标题「蜕」为纯展示,正文来自 App 以便复制同源) */
        <div className="egg-card">
          <IconButterfly size={16} className="egg-icon" />
          <div className="egg-main">
            <div className="egg-title">蜕</div>
            <div className="egg-body">{eggBody}</div>
          </div>
          <button
            type="button"
            className="icon-btn"
            title="复制"
            aria-label="复制暗屉正文"
            onClick={onEggCopy}
          >
            <IconCopy size={16} />
          </button>
        </div>
      )}
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
      {/* A9:常驻快捷键提示,纯提示不可点击(不新增热区),独立于列表滚动区外 */}
      <div className="sidebar-hints">
        <span>
          <kbd className="kbd">Ctrl+K</kbd> {t("sidebar.hintPalette")}
        </span>
        <span>·</span>
        <span>
          <kbd className="kbd">?</kbd> {t("sidebar.hintCheatsheet")}
        </span>
        <span>·</span>
        <span>
          <kbd className="kbd">Ctrl+F</kbd> {t("sidebar.hintSearch")}
        </span>
      </div>
    </aside>
  );
}
