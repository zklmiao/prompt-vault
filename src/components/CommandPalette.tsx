import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyMatch, isComposingEvent } from "../util";
import type { MatchRange } from "../util";
import Highlight from "./Highlight";
import { IconSearch } from "./icons";

export interface PaletteCommand {
  id: string;
  group: string;
  label: string;
  /** 拼音/英文/别名词,提高可搜性(命中时不改变标签高亮) */
  keywords?: string[];
  shortcut?: string;
  /** 无快捷键命令的补充说明(如当前热键) */
  hint?: string;
  checked?: boolean;
  icon?: React.ReactNode;
  run: () => void;
}

interface Props {
  commands: PaletteCommand[];
  onClose: () => void;
}

interface Row {
  cmd: PaletteCommand;
  ranges: MatchRange[];
  score: number;
}

const GROUP_ORDER = ["收藏", "视图", "应用"];

function scoreCommand(
  query: string,
  cmd: PaletteCommand,
): { score: number; ranges: MatchRange[] } | null {
  if (!query) return { score: 0, ranges: [] };
  const label = fuzzyMatch(query, cmd.label);
  let best = label ? label.score * 3 : 0;
  let ranges: MatchRange[] = label ? label.ranges : [];
  for (const kw of cmd.keywords ?? []) {
    const hit = fuzzyMatch(query, kw);
    if (hit && hit.score * 2 > best) {
      best = hit.score * 2;
      // 关键词命中不给标签加高亮,避免误导
      ranges = [];
    }
  }
  if (!label && best === 0) return null;
  return { score: best, ranges };
}

/** 应用内命令面板:模糊搜索 + 分组 + ↑↓/Enter/Esc 键盘操作 */
export default function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    setQuery("");
    setIdx(0);
    inputRef.current?.focus();
  }, []);

  // Esc 关闭:窗口级监听,保证焦点不在输入框时也能关
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isComposingEvent(e)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = useMemo<Row[]>(() => {
    const q = query.trim();
    const scored: Row[] = [];
    for (const cmd of commands) {
      const m = scoreCommand(q, cmd);
      if (m) scored.push({ cmd, ranges: m.ranges, score: m.score });
    }
    if (!q) return scored;
    return scored.sort((a, b) => {
      const ga = GROUP_ORDER.indexOf(a.cmd.group);
      const gb = GROUP_ORDER.indexOf(b.cmd.group);
      if (ga !== gb) return ga - gb;
      return b.score - a.score;
    });
  }, [commands, query]);

  useEffect(() => {
    if (idx >= rows.length) setIdx(0);
  }, [rows.length, idx]);

  useEffect(() => {
    rowRefs.current[idx]?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const groups = useMemo(() => {
    const out: Array<{ name: string; rows: Row[] }> = [];
    for (const row of rows) {
      const last = out[out.length - 1];
      if (last && last.name === row.cmd.group) last.rows.push(row);
      else out.push({ name: row.cmd.group, rows: [row] });
    }
    return out;
  }, [rows]);

  const indexById = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((r, i) => map.set(r.cmd.id, i));
    return map;
  }, [rows]);

  const runCmd = (cmd: PaletteCommand) => {
    onClose();
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isComposingEvent(e)) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => (rows.length ? (i + 1) % rows.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[idx];
      if (row) runCmd(row.cmd);
    } else if (e.key === "Tab") {
      e.preventDefault();
    }
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="qp-input-row">
          <IconSearch size={17} className="qp-search-icon" />
          <input
            ref={inputRef}
            className="qp-input"
            placeholder="搜索命令,↑↓ 选择,Enter 执行,Esc 关闭"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIdx(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="palette-list">
          {groups.map((group) => (
            <div key={group.name} className="palette-group">
              <div className="palette-group-title">{group.name}</div>
              {group.rows.map((row) => {
                const flatIndex = indexById.get(row.cmd.id) ?? 0;
                const active = flatIndex === idx;
                return (
                  <button
                    key={row.cmd.id}
                    ref={(el) => {
                      rowRefs.current[flatIndex] = el;
                    }}
                    className={"palette-row" + (active ? " active" : "")}
                    onMouseEnter={() => setIdx(flatIndex)}
                    onClick={() => runCmd(row.cmd)}
                    title={row.cmd.hint}
                  >
                    <span className="palette-icon">{row.cmd.icon}</span>
                    <span className="palette-label">
                      <Highlight text={row.cmd.label} ranges={row.ranges} />
                    </span>
                    {row.cmd.checked && <span className="palette-check">✓</span>}
                    {row.cmd.shortcut ? (
                      <kbd className="kbd">{row.cmd.shortcut}</kbd>
                    ) : row.cmd.hint ? (
                      <span className="palette-hint">{row.cmd.hint}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
          {rows.length === 0 && (
            <div className="palette-empty">没有匹配的命令</div>
          )}
        </div>
      </div>
    </div>
  );
}
