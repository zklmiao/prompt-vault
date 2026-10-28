import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { copyToClipboard, bumpCopyStats, getDataPath, hideQuickpick, readDataFile } from "./api";
import { coerceItems, extractPlaceholders, fillPlaceholders } from "./util";
import type { PromptItem } from "./types";
import PlaceholderModal from "./components/PlaceholderModal";
import { IconSearch } from "./components/icons";

const MAX_RESULTS = 8;

/** 全局快捷键唤出的快速拾取面板:搜索 → Enter 复制 → 自动隐藏 */
export default function QuickPick() {
  const [items, setItems] = useState<PromptItem[]>([]);
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const [fillTarget, setFillTarget] = useState<PromptItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dataPath, setDataPath] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const p = await getDataPath();
        setDataPath(p);
        if (!p) {
          setError("尚未选择数据文件,请先在主窗口完成首次设置");
          return;
        }
        const raw = await readDataFile(p);
        if (raw) {
          setItems(coerceItems(JSON.parse(raw)).filter((i) => !i.deletedAt));
        }
      } catch {
        setError("数据读取失败");
      }
    })();
  }, []);

  useEffect(() => {
    const unlistens: Array<() => void> = [];
    let disposed = false;
    (async () => {
      try {
        const u = await listen("quickpick-shown", () => {
          setQuery("");
          setIdx(0);
          setFillTarget(null);
          setError(null);
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
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? items.filter((it) =>
          [it.title, it.body, it.note, it.tags.join(" ")]
            .join("\n")
            .toLowerCase()
            .includes(q),
        )
      : items;
    return [...list]
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) ||
          b.updatedAt.localeCompare(a.updatedAt),
      )
      .slice(0, MAX_RESULTS);
  }, [items, query]);

  useEffect(() => {
    if (idx >= filtered.length) setIdx(0);
  }, [filtered.length, idx]);

  const finish = useCallback(() => {
    setFillTarget(null);
    setQuery("");
    setIdx(0);
    void hideQuickpick();
  }, []);

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
      finish();
    },
    [finish, bump],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (fillTarget) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => (filtered.length ? (i + 1) % filtered.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) =>
        filtered.length ? (i - 1 + filtered.length) % filtered.length : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = filtered[idx];
      if (it) void pick(it);
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
            className="qp-input"
            placeholder="搜索 prompt,↑↓ 选择,Enter 复制,Esc 关闭"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIdx(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {error && <div className="qp-error">{error}</div>}
        <div className="qp-list">
          {filtered.map((it, i) => (
            <div
              key={it.id}
              className={"qp-row" + (i === idx ? " active" : "")}
              onMouseEnter={() => setIdx(i)}
              onClick={() => void pick(it)}
            >
              <span className="qp-title">
                {it.pinned && <span className="star">★ </span>}
                {it.title || "未命名"}
              </span>
              <span className="qp-tags">
                {it.tags
                  .slice(0, 3)
                  .map((t) => `#${t}`)
                  .join("  ")}
              </span>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="qp-empty">没有匹配的 prompt</div>
          )}
        </div>
        {fillTarget && (
          <PlaceholderModal
            names={extractPlaceholders(fillTarget.body)}
            initialValues={fillTarget.lastValues}
            onConfirm={async (values) => {
              const filled = fillPlaceholders(fillTarget.body, values);
              try {
                await copyToClipboard(filled);
              } catch {
                setError("复制失败");
                setFillTarget(null);
                return;
              }
              await bump(fillTarget.id);
              finish();
            }}
            onCancel={() => setFillTarget(null)}
          />
        )}
      </div>
    </div>
  );
}
