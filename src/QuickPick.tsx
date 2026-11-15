import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  bumpCopyStats,
  copyToClipboard,
  getDataPath,
  hideQuickpick,
  openEditor,
  openNewPrompt,
  readDataFile,
} from "./api";
import {
  coerceItems,
  extractPlaceholders,
  fillPlaceholders,
  formatDate,
  isComposingEvent,
  isTdov,
  matchPrompt,
} from "./util";
import type { PromptMatch } from "./util";
import type { PromptItem } from "./types";
import { refreshLang, useI18n } from "./i18n";
import PlaceholderModal from "./components/PlaceholderModal";
import TagChips from "./components/TagChips";
import BodyText from "./components/BodyText";
import Highlight from "./components/Highlight";
import { IconCheck, IconFlagCheck, IconSearch } from "./components/icons";

const MAX_RESULTS = 7;
const RECENT_LIMIT = 5;
const MOST_LIMIT = 5;
const CONFIRM_MS = 420;

// 私人彩蛋「3 月 31 日五色对勾」夹具:?tdov=1 强制按 TDOV 日显示五色对勾
//(仅供评审/回归,可与 ?quickpick=1 并用;打包环境无人传此参数,天然惰性)。
// 正常触发走 util.isTdov() 本地日期门(渲染时求值),见确认态三元
const EGG_TDOV_FIXTURE =
  new URLSearchParams(window.location.search).get("tdov") === "1";

interface Row {
  item: PromptItem;
  match: PromptMatch | null;
}

interface Section {
  title: string;
  rows: Row[];
}

/** 全局快捷键唤出的快速拾取面板:搜索 → Enter 复制 → 确认态 → 自动隐藏 */
export default function QuickPick() {
  const { t } = useI18n();
  const [items, setItems] = useState<PromptItem[]>([]);
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const [fillTarget, setFillTarget] = useState<PromptItem | null>(null);
  const [copied, setCopied] = useState<{ variables: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dataPath, setDataPath] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hideTimer = useRef<number | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const loadData = useCallback(async () => {
    try {
      const p = await getDataPath();
      setDataPath(p);
      if (!p) {
        setItems([]);
        setError(t("qp.noDataFile"));
        return;
      }
      const raw = await readDataFile(p);
      if (raw === null) {
        setItems([]);
        setError(t("qp.dataFileMissing"));
        return;
      }
      setItems(coerceItems(JSON.parse(raw)).filter((i) => !i.deletedAt));
      setError(null);
    } catch {
      setItems([]);
      setError(t("qp.readFailed"));
    }
  }, [t]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const unlistens: Array<() => void> = [];
    let disposed = false;
    (async () => {
      try {
        const u = await listen("quickpick-shown", () => {
          clearHideTimer();
          setCopied(null);
          setFillTarget(null);
          setQuery("");
          setIdx(0);
          setError(null);
          // 窗口常驻隐藏:重读语言偏好(否则感知不到主窗口里的切换)并重新读盘
          refreshLang();
          void loadData();
          inputRef.current?.focus();
        });
        if (disposed) u();
        else unlistens.push(u);
      } catch {
        /* 浏览器预览无事件系统 */
      }
    })();
    return () => {
      disposed = true;
      unlistens.forEach((u) => u());
    };
  }, [clearHideTimer, loadData]);

  useEffect(() => () => clearHideTimer(), [clearHideTimer]);

  const sections = useMemo<Section[]>(() => {
    const q = query.trim();
    if (q) {
      const rows: Row[] = [];
      for (const it of items) {
        const m = matchPrompt(q, it);
        if (m) rows.push({ item: it, match: m });
      }
      rows.sort(
        (a, b) =>
          (b.match?.score ?? 0) - (a.match?.score ?? 0) ||
          Number(b.item.pinned) - Number(a.item.pinned) ||
          b.item.updatedAt.localeCompare(a.item.updatedAt),
      );
      return [{ title: "", rows: rows.slice(0, MAX_RESULTS) }];
    }

    const recent = items
      .filter((i) => !!i.lastCopiedAt)
      .sort((a, b) =>
        (b.lastCopiedAt ?? "").localeCompare(a.lastCopiedAt ?? ""),
      )
      .slice(0, RECENT_LIMIT);
    const recentIds = new Set(recent.map((i) => i.id));
    const most = items
      .filter((i) => (i.copyCount ?? 0) > 0 && !recentIds.has(i.id))
      .sort(
        (a, b) =>
          (b.copyCount ?? 0) - (a.copyCount ?? 0) ||
          (b.lastCopiedAt ?? "").localeCompare(a.lastCopiedAt ?? ""),
      )
      .slice(0, MOST_LIMIT);

    const out: Section[] = [];
    if (recent.length > 0) {
      out.push({
        title: t("qp.recentSection"),
        rows: recent.map((item) => ({ item, match: null })),
      });
    }
    if (most.length > 0) {
      out.push({
        title: t("qp.mostSection"),
        rows: most.map((item) => ({ item, match: null })),
      });
    }
    if (out.length === 0) {
      const fallback = [...items]
        .sort(
          (a, b) =>
            Number(b.pinned) - Number(a.pinned) ||
            b.updatedAt.localeCompare(a.updatedAt),
        )
        .slice(0, MAX_RESULTS);
      out.push({
        title: "",
        rows: fallback.map((item) => ({ item, match: null })),
      });
    }
    return out;
  }, [items, query, t]);

  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const selected = flat[idx];

  useEffect(() => {
    if (idx >= flat.length) setIdx(0);
  }, [flat.length, idx]);

  const finish = useCallback(() => {
    clearHideTimer();
    setCopied(null);
    setFillTarget(null);
    setQuery("");
    setIdx(0);
    void hideQuickpick();
  }, [clearHideTimer]);

  const startConfirm = useCallback(
    (variables: number) => {
      setCopied({ variables });
      clearHideTimer();
      hideTimer.current = window.setTimeout(() => {
        finish();
      }, CONFIRM_MS);
    },
    [clearHideTimer, finish],
  );

  /** 统计写盘失败不影响复制与关闭 */
  const bump = useCallback(
    async (id: string) => {
      if (!dataPath) return;
      try {
        await bumpCopyStats(dataPath, id);
      } catch {
        /* ignore */
      }
    },
    [dataPath],
  );

  const pick = useCallback(
    async (item: PromptItem) => {
      if (extractPlaceholders(item.body).length > 0) {
        setFillTarget(item);
        return;
      }
      try {
        await copyToClipboard(item.body);
      } catch {
        setError(t("qp.copyFailed"));
        return;
      }
      await bump(item.id);
      startConfirm(0);
    },
    [bump, startConfirm, t],
  );

  // 确认态期间:任何位置的 Esc 都立即隐藏
  useEffect(() => {
    if (!copied) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isComposingEvent(e)) return;
      e.preventDefault();
      finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [copied, finish]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // 输入法组字期间(Enter/Esc/方向键)全部让给输入法
    if (isComposingEvent(e)) return;
    if (copied) {
      if (e.key === "Escape") {
        e.preventDefault();
        finish();
      }
      return;
    }
    if (fillTarget) return;
    if (
      e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey &&
      (e.key === "n" || e.key === "N")
    ) {
      // Ctrl+N:唤出主窗口进入空白新建态(位于 copied/fillTarget 两道拦截之后,
      // 确认态与变量弹窗期间不响应;剪贴板速存仍归全局 Alt+Shift+N)
      e.preventDefault();
      void openNewPrompt();
      finish();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => (flat.length ? (i + 1) % flat.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (selected) void pick(selected.item);
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (selected) {
        void openEditor(selected.item.id);
        finish();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      void hideQuickpick();
    }
  };

  return (
    <div className="qp-root">
      <div className="qp-panel">
        <div className="qp-input-row">
          <IconSearch size={17} className="qp-search-icon" />
          <input
            ref={inputRef}
            autoFocus
            readOnly={!!copied}
            className="qp-input"
            placeholder={t("qp.inputPlaceholder")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIdx(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {error && <div className="qp-error">{error}</div>}
        <div className="qp-body">
          <div className="qp-list">
            {sections.map((section, si) => (
              <div key={`${section.title}-${si}`}>
                {section.title && (
                  <div className="qp-section">{section.title}</div>
                )}
                {section.rows.map((row) => {
                  const i = flat.indexOf(row);
                  const active = i === idx;
                  return (
                    <div
                      key={row.item.id}
                      className={"qp-row" + (active ? " active" : "")}
                      onMouseEnter={() => setIdx(i)}
                      onClick={() => {
                        if (!copied) void pick(row.item);
                      }}
                    >
                      <div className="qp-line1">
                        <span className="qp-title">
                          {row.item.pinned && <span className="star">★ </span>}
                          <Highlight
                            text={row.item.title || t("common.untitled")}
                            ranges={row.match?.title?.ranges}
                          />
                        </span>
                        {row.item.tags.length > 0 && (
                          <span className="qp-tags">
                            {row.item.tags.slice(0, 3).map((tag, ti) => (
                              <span key={tag}>
                                #{""}
                                <Highlight
                                  text={tag}
                                  ranges={row.match?.tags[ti]?.ranges}
                                />
                                {"  "}
                              </span>
                            ))}
                          </span>
                        )}
                      </div>
                      {row.match?.bodySnippet && (
                        <div className="qp-snippet">
                          <Highlight
                            text={row.match.bodySnippet.text}
                            ranges={row.match.bodySnippet.ranges}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            {flat.length === 0 && (
              <div className="qp-empty">
                {query.trim() ? t("qp.noMatch") : t("qp.nothingToShow")}
              </div>
            )}
          </div>
          <div className="qp-preview">
            {selected ? (
              <>
                <div className="qp-prev-title">
                  {selected.item.title || t("common.untitled")}
                </div>
                {selected.item.tags.length > 0 && (
                  <div className="qp-prev-tags">
                    <TagChips tags={selected.item.tags} />
                  </div>
                )}
                {selected.item.source && (
                  <div className="qp-prev-line">
                    <span className="label">{t("common.source")}</span>
                    <span> {selected.item.source}</span>
                  </div>
                )}
                {selected.item.note && (
                  <div className="qp-prev-line">
                    <span className="label">{t("common.note")}</span>
                    <span> {selected.item.note}</span>
                  </div>
                )}
                <pre className="qp-prev-body">
                  <BodyText text={selected.item.body} />
                </pre>
                <div className="qp-prev-meta">
                  {(selected.item.copyCount ?? 0) > 0
                    ? selected.item.lastCopiedAt
                      ? t("common.statsCopied", {
                          n: selected.item.copyCount ?? 0,
                          date: formatDate(selected.item.lastCopiedAt),
                        })
                      : t("qp.copiedCount", { n: selected.item.copyCount ?? 0 })
                    : t("qp.neverCopied")}
                </div>
              </>
            ) : (
              <div className="qp-prev-empty">{t("qp.prevEmpty")}</div>
            )}
          </div>
        </div>
        <div className="qp-footer">
          <span>{t("qp.footerCopy")}</span>
          <span>{t("qp.footerEdit")}</span>
          <span>{t("qp.footerNew")}</span>
          <span>{t("qp.footerClose")}</span>
        </div>
        {copied && (
          <div className="qp-confirm">
            {/* 私人彩蛋「3 月 31 日五色对勾」:isTdov() 本地日期门,?tdov=1 夹具强制;
                size 40 + 收紧 viewBox 为评审调整(见 icons.tsx 注释);非彩蛋日原样 26 */}
            {isTdov() || EGG_TDOV_FIXTURE ? (
              <IconFlagCheck size={40} />
            ) : (
              <IconCheck size={26} />
            )}
            <div className="qp-confirm-text">{t("qp.copied")}</div>
            {copied.variables > 0 && (
              <div className="qp-confirm-sub">
                {t("qp.variablesFilled", { n: copied.variables })}
              </div>
            )}
          </div>
        )}
        {fillTarget && (
          <PlaceholderModal
            names={extractPlaceholders(fillTarget.body)}
            initialValues={fillTarget.lastValues}
            onConfirm={async (values) => {
              const filled = fillPlaceholders(fillTarget.body, values);
              const names = extractPlaceholders(fillTarget.body);
              try {
                await copyToClipboard(filled);
              } catch {
                setError(t("qp.copyFailed"));
                setFillTarget(null);
                return;
              }
              await bump(fillTarget.id);
              setFillTarget(null);
              startConfirm(names.length);
            }}
            onCancel={() => setFillTarget(null)}
          />
        )}
      </div>
    </div>
  );
}
