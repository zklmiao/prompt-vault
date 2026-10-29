import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  bumpCopyStats,
  copyToClipboard,
  getDataPath,
  hideQuickpick,
  openEditor,
  readDataFile,
} from "./api";
import {
  coerceItems,
  extractPlaceholders,
  fillPlaceholders,
  formatDate,
  isComposingEvent,
  matchPrompt,
} from "./util";
import type { PromptMatch } from "./util";
import type { PromptItem } from "./types";
import PlaceholderModal from "./components/PlaceholderModal";
import TagChips from "./components/TagChips";
import BodyText from "./components/BodyText";
import Highlight from "./components/Highlight";
import { IconCheck, IconSearch } from "./components/icons";

const MAX_RESULTS = 7;
const RECENT_LIMIT = 5;
const MOST_LIMIT = 5;
const CONFIRM_MS = 420;

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
        setError("尚未选择数据文件,请先在主窗口完成首次设置");
        return;
      }
      const raw = await readDataFile(p);
      if (raw === null) {
        setItems([]);
        setError("数据文件不存在或无法读取");
        return;
      }
      setItems(coerceItems(JSON.parse(raw)).filter((i) => !i.deletedAt));
      setError(null);
    } catch {
      setItems([]);
      setError("数据读取失败");
    }
  }, []);

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
          // 窗口常驻隐藏,每次显示都重新读盘,避免展示旧数据
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
        title: "最近复制",
        rows: recent.map((item) => ({ item, match: null })),
      });
    }
    if (most.length > 0) {
      out.push({
        title: "最常复制",
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
  }, [items, query]);

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
        setError("复制失败");
        return;
      }
      await bump(item.id);
      startConfirm(0);
    },
    [bump, startConfirm],
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
            placeholder="搜索 prompt,↑↓ 选择,Enter 复制,Tab 编辑,Esc 关闭"
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
                            text={row.item.title || "未命名"}
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
                {query.trim() ? "没有匹配的 prompt" : "还没有可显示的 prompt"}
              </div>
            )}
          </div>
          <div className="qp-preview">
            {selected ? (
              <>
                <div className="qp-prev-title">
                  {selected.item.title || "未命名"}
                </div>
                {selected.item.tags.length > 0 && (
                  <div className="qp-prev-tags">
                    <TagChips tags={selected.item.tags} />
                  </div>
                )}
                {selected.item.source && (
                  <div className="qp-prev-line">
                    <span className="label">来源</span>
                    <span> {selected.item.source}</span>
                  </div>
                )}
                {selected.item.note && (
                  <div className="qp-prev-line">
                    <span className="label">备注</span>
                    <span> {selected.item.note}</span>
                  </div>
                )}
                <pre className="qp-prev-body">
                  <BodyText text={selected.item.body} />
                </pre>
                <div className="qp-prev-meta">
                  {(selected.item.copyCount ?? 0) > 0
                    ? `已复制 ${selected.item.copyCount} 次${
                        selected.item.lastCopiedAt
                          ? ` · 最近 ${formatDate(selected.item.lastCopiedAt)}`
                          : ""
                      }`
                    : "尚未复制过"}
                </div>
              </>
            ) : (
              <div className="qp-prev-empty">选中一条 prompt 查看预览</div>
            )}
          </div>
        </div>
        <div className="qp-footer">
          <span>↩ 复制</span>
          <span>Tab 编辑</span>
          <span>Esc 关闭</span>
        </div>
        {copied && (
          <div className="qp-confirm">
            <IconCheck size={26} />
            <div className="qp-confirm-text">已复制</div>
            {copied.variables > 0 && (
              <div className="qp-confirm-sub">
                {copied.variables} 个变量已填充
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
                setError("复制失败");
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
