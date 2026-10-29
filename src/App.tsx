import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import "./App.css";
import type { Draft, ImportMode, Mode, NewPrefill, PromptItem, SortMode, Theme } from "./types";
import {
  bumpCopyStats,
  chooseDataFileSave,
  chooseExportFile,
  chooseImportFile,
  copyToClipboard,
  firstRunDefaultPath,
  getDataPath,
  getHotkeys,
  pathMeta,
  readClipboard,
  readDataFile,
  restoreBackup,
  setDataPath,
  writeDataFile,
  type Hotkeys,
} from "./api";
import {
  coerceItems,
  extractPlaceholders,
  fillPlaceholders,
  formatHotkey,
  isComposingEvent,
  isNewer,
  matchPrompt,
  newId,
  newerIso,
  nowIso,
  serializeDataFile,
} from "./util";
import { applyTheme, currentTheme } from "./theme";
import Sidebar from "./components/Sidebar";
import DetailPane from "./components/DetailPane";
import BatchPanel from "./components/BatchPanel";
import DropOverlay from "./components/DropOverlay";
import TitleBar from "./components/TitleBar";
import PlaceholderModal from "./components/PlaceholderModal";
import ConfirmModal from "./components/ConfirmModal";
import ImportChoiceModal from "./components/ImportChoiceModal";
import SettingsModal from "./components/SettingsModal";
import CommandPalette, { type PaletteCommand } from "./components/CommandPalette";
import CheatsheetModal from "./components/CheatsheetModal";
import {
  IconClipboard,
  IconExport,
  IconImport,
  IconMoon,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSparkles,
  IconSun,
  IconTrash,
  IconUndo,
  IconX,
} from "./components/icons";

type Toast = { text: string; kind: "ok" | "err" };
type RestoreState = "idle" | "doing" | "none";

function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 置顶组之外的排序键:最近更新 / 最近复制 / 最常复制 */
function compareForSort(mode: SortMode, a: PromptItem, b: PromptItem): number {
  if (mode === "recent") {
    const ta = a.lastCopiedAt ? Date.parse(a.lastCopiedAt) : Number.NaN;
    const tb = b.lastCopiedAt ? Date.parse(b.lastCopiedAt) : Number.NaN;
    const hasA = !Number.isNaN(ta);
    const hasB = !Number.isNaN(tb);
    if (hasA !== hasB) return hasA ? -1 : 1;
    if (hasA && hasB && tb !== ta) return tb - ta;
    return b.updatedAt.localeCompare(a.updatedAt);
  }
  if (mode === "most") {
    const ca = a.copyCount ?? 0;
    const cb = b.copyCount ?? 0;
    if (cb !== ca) return cb - ca;
    return b.updatedAt.localeCompare(a.updatedAt);
  }
  return b.updatedAt.localeCompare(a.updatedAt);
}

function ThemeToggle({
  theme,
  onToggle,
}: {
  theme: Theme;
  onToggle: () => void;
}) {
  return (
    <button
      className="icon-btn"
      onClick={onToggle}
      title={theme === "dark" ? "切换到亮色模式" : "切换到暗色模式"}
    >
      {theme === "dark" ? <IconSun size={16} /> : <IconMoon size={16} />}
    </button>
  );
}

function SetupScreen({ onPick }: { onPick: () => void }) {
  return (
    <div className="screen">
      <h1>欢迎使用 Prompt Vault</h1>
      <p>首次使用需要先选择收藏数据(prompts.json)的保存位置。</p>
      <p className="muted">之后可在文件管理器里直接备份这个文件。</p>
      <button className="btn primary" onClick={onPick}>
        选择数据文件位置
      </button>
    </div>
  );
}

function LoadErrorScreen({
  path,
  restoreState,
  onRestore,
}: {
  path: string;
  restoreState: RestoreState;
  onRestore: () => void;
}) {
  return (
    <div className="screen">
      <h1>数据文件解析失败</h1>
      <p>以下文件不是有效的 Prompt Vault JSON,为防覆盖已暂停读写:</p>
      <code className="error-path">{path}</code>
      <p className="muted">
        可以尝试用最近一次写入前的自动备份(prompts.json.bak)覆盖恢复,
        也可以手工修复该文件后重启应用。
      </p>
      {restoreState === "none" ? (
        <p className="muted">旁边没有找到 .bak 备份文件。</p>
      ) : (
        <button
          className="btn primary"
          disabled={restoreState === "doing"}
          onClick={onRestore}
        >
          {restoreState === "doing" ? "恢复中…" : "用 .bak 备份恢复"}
        </button>
      )}
    </div>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [setupFailed, setSetupFailed] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoreState, setRestoreState] = useState<RestoreState>("idle");
  const [items, setItems] = useState<PromptItem[]>([]);
  const [search, setSearch] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [copyTarget, setCopyTarget] = useState<PromptItem | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<PromptItem | null>(null);
  const [importCandidate, setImportCandidate] = useState<PromptItem[] | null>(null);
  const [prefill, setPrefill] = useState<NewPrefill | null>(null);
  const [prefillSeq, setPrefillSeq] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [batchPurgeOpen, setBatchPurgeOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sortMode, setSortModeState] = useState<SortMode>(() => {
    try {
      const saved = localStorage.getItem("pv-sort");
      if (saved === "updated" || saved === "recent" || saved === "most") {
        return saved;
      }
    } catch {
      /* ignore */
    }
    return "updated";
  });
  const [toast, setToast] = useState<Toast | null>(null);
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [hotkeys, setHotkeys] = useState<Hotkeys>({
    quickpick: "alt+q",
    clipboard_new: "alt+shift+n",
  });

  const dataPathRef = useRef<string | null>(null);
  const bootstrapped = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const shiftAnchor = useRef<string | null>(null);

  const showToast = useCallback((text: string, kind: "ok" | "err" = "ok") => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 2200);
  }, []);

  const setSortMode = useCallback((mode: SortMode) => {
    setSortModeState(mode);
    try {
      localStorage.setItem("pv-sort", mode);
    } catch {
      /* ignore */
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((cur) => {
      const next: Theme = cur === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }, []);

  /** 读取全局热键配置;浏览器预览等无 Tauri 环境时保持默认值 */
  const loadHotkeys = useCallback(async () => {
    try {
      setHotkeys(await getHotkeys());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void loadHotkeys();
  }, [loadHotkeys]);

  const persist = useCallback(
    async (next: PromptItem[]) => {
      setItems(next);
      const p = dataPathRef.current;
      if (!p) return;
      try {
        await writeDataFile(p, serializeDataFile(next));
      } catch (e) {
        showToast(`保存失败:${String(e)}`, "err");
      }
    },
    [showToast],
  );

  const loadFrom = useCallback(
    async (p: string) => {
      const raw = await readDataFile(p);
      if (raw === null) {
        // 全新数据文件:立即落盘创建
        await persist([]);
      } else {
        try {
          setItems(coerceItems(JSON.parse(raw)));
        } catch {
          setLoadError(p);
          return;
        }
      }
      setReady(true);
    },
    [persist],
  );

  const chooseDataLocation = useCallback(async () => {
    const suggested = await firstRunDefaultPath();
    const chosen = await chooseDataFileSave(suggested);
    if (!chosen) return false;
    await setDataPath(chosen);
    dataPathRef.current = chosen;
    setSetupFailed(false);
    await loadFrom(chosen);
    return true;
  }, [loadFrom]);

  /** 静默重读磁盘:快速拾取窗口写入统计后,同步到主窗口内存 */
  const refreshFromDisk = useCallback(async () => {
    const p = dataPathRef.current;
    if (!p) return;
    const raw = await readDataFile(p);
    if (raw === null) return;
    try {
      setItems(coerceItems(JSON.parse(raw)));
    } catch {
      /* 读到损坏内容时保持现状,交由用户下一步操作决定 */
    }
  }, []);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    (async () => {
      let p = await getDataPath();
      if (!p) {
        const ok = await chooseDataLocation();
        if (!ok) {
          setSetupFailed(true);
          return;
        }
        return;
      }
      dataPathRef.current = p;
      await loadFrom(p);
    })().catch((e) => showToast(`初始化失败:${String(e)}`, "err"));
  }, [chooseDataLocation, loadFrom, showToast]);

  // 托盘隐藏提示 + 全局"剪贴板新建"事件
  useEffect(() => {
    const unlistens: Array<() => void> = [];
    let disposed = false;
    (async () => {
      try {
        const u1 = await listen("hidden-to-tray", () => {
          showToast("已收进托盘:左键图标唤出,右键菜单退出");
        });
        if (disposed) {
          u1();
          return;
        }
        unlistens.push(u1);
      } catch {
        /* 浏览器预览无事件系统 */
      }
      try {
        const u2 = await listen<string | null>("clipboard-new", (e) => {
          setPrefill({ body: e.payload ?? "" });
          setPrefillSeq((s) => s + 1);
          setMode({ kind: "new" });
        });
        if (disposed) {
          u2();
          return;
        }
        unlistens.push(u2);
      } catch {
        /* ignore */
      }
      try {
        const u3 = await listen("stats-changed", () => {
          void refreshFromDisk();
        });
        if (disposed) {
          u3();
          return;
        }
        unlistens.push(u3);
      } catch {
        /* ignore */
      }
      try {
        // 快速拾取窗口按 Tab:打开主窗口并进入该条目的编辑态
        const u4 = await listen<string>("open-editor", (e) => {
          void (async () => {
            const p = dataPathRef.current;
            if (!p) return;
            const raw = await readDataFile(p);
            if (raw === null) {
              showToast("该条目已不存在", "err");
              return;
            }
            let parsed: PromptItem[] = [];
            try {
              parsed = coerceItems(JSON.parse(raw));
            } catch {
              showToast("数据读取失败", "err");
              return;
            }
            const target = parsed.find(
              (it) => it.id === e.payload && !it.deletedAt,
            );
            if (!target) {
              showToast("该条目已不存在", "err");
              return;
            }
            setItems(parsed);
            setTrashOpen(false);
            setSearch("");
            setActiveTag(null);
            setCopyTarget(null);
            setPurgeTarget(null);
            setImportCandidate(null);
            setBatchPurgeOpen(false);
            setSettingsOpen(false);
            setSelectedId(target.id);
            setMode({ kind: "edit", id: target.id });
          })();
        });
        if (disposed) {
          u4();
          return;
        }
        unlistens.push(u4);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      disposed = true;
      unlistens.forEach((u) => u());
    };
  }, [refreshFromDisk, showToast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isComposingEvent(e)) return;
      // 命令面板 / 速查表打开时不响应窗口快捷键
      if (paletteOpen || cheatsheetOpen) return;
      if (e.ctrlKey && !e.shiftKey && !e.altKey) {
        if (e.key === "n" || e.key === "N") {
          e.preventDefault();
          startNew();
        } else if (e.key === "f" || e.key === "F") {
          e.preventDefault();
          searchRef.current?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteOpen, cheatsheetOpen]);

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) {
      if (it.deletedAt) continue;
      for (const t of it.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
      .map(([t]) => t);
  }, [items]);

  const liveItems = useMemo(() => items.filter((it) => !it.deletedAt), [items]);

  const trashItems = useMemo(
    () =>
      items
        .filter((it) => !!it.deletedAt)
        .sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? "")),
    [items],
  );

  const filtered = useMemo(() => {
    if (trashOpen) return trashItems;
    const q = search.trim();
    let list = activeTag
      ? liveItems.filter((it) => it.tags.includes(activeTag))
      : liveItems;
    if (q) {
      const scored: Array<{ item: PromptItem; score: number }> = [];
      for (const it of list) {
        const m = matchPrompt(q, it);
        if (m) scored.push({ item: it, score: m.score });
      }
      scored.sort(
        (a, b) =>
          b.score - a.score ||
          Number(b.item.pinned) - Number(a.item.pinned) ||
          b.item.updatedAt.localeCompare(a.item.updatedAt),
      );
      return scored.map((s) => s.item);
    }
    return [...list].sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || compareForSort(sortMode, a, b),
    );
  }, [trashOpen, trashItems, liveItems, search, activeTag, sortMode]);

  const selectedItem = selectedId
    ? (items.find((i) => i.id === selectedId) ?? null)
    : null;

  const selectedItems = useMemo(
    () => items.filter((it) => selectedIds.has(it.id)),
    [items, selectedIds],
  );

  const startNew = useCallback(() => {
    setPrefill(null);
    setPrefillSeq((s) => s + 1);
    setMode({ kind: "new" });
  }, []);

  const newFromClipboard = useCallback(async () => {
    let text: string | null = null;
    try {
      text = await readClipboard();
    } catch {
      /* 剪贴板不可用则新建空白 */
    }
    setPrefill({ body: text ?? "" });
    setPrefillSeq((s) => s + 1);
    setMode({ kind: "new" });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    shiftAnchor.current = null;
  }, []);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    shiftAnchor.current = id;
  }, []);

  /** 行点击:Ctrl 多选切换 / Shift 连选区间 / 普通点击清空多选并单选 */
  const handleRowClick = useCallback(
    (id: string, e: React.MouseEvent) => {
      if (e.shiftKey) {
        const ids = filtered.map((it) => it.id);
        const anchor = shiftAnchor.current ?? selectedId ?? id;
        const a = ids.indexOf(anchor);
        const b = ids.indexOf(id);
        if (a === -1 || b === -1) {
          toggleSelected(id);
          return;
        }
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const x of ids.slice(lo, hi + 1)) next.add(x);
          return next;
        });
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        toggleSelected(id);
        return;
      }
      setSelectedIds(new Set());
      shiftAnchor.current = id;
      setSelectedId(id);
      setMode({ kind: "view" });
    },
    [filtered, selectedId, toggleSelected],
  );

  /** 全选只覆盖当前列表(受搜索/标签筛选影响),不是全库 */
  const selectAllFiltered = useCallback(() => {
    setSelectedIds(new Set(filtered.map((it) => it.id)));
    shiftAnchor.current = filtered.length
      ? filtered[filtered.length - 1].id
      : null;
  }, [filtered]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((it) => selectedIds.has(it.id));

  const handleBatchAddTags = useCallback(
    async (tags: string[]) => {
      if (tags.length === 0 || selectedIds.size === 0) return;
      const now = nowIso();
      const next = items.map((it) =>
        selectedIds.has(it.id)
          ? {
              ...it,
              tags: [...it.tags, ...tags.filter((t) => !it.tags.includes(t))],
              updatedAt: now,
            }
          : it,
      );
      await persist(next);
      showToast(`已为 ${selectedIds.size} 条添加标签`);
    },
    [items, selectedIds, persist, showToast],
  );

  const handleBatchDelete = useCallback(async () => {
    const count = selectedIds.size;
    if (count === 0) return;
    const now = nowIso();
    const next = items.map((it) =>
      selectedIds.has(it.id) ? { ...it, deletedAt: now } : it,
    );
    const affected = selectedId !== null && selectedIds.has(selectedId);
    await persist(next);
    if (affected) {
      setSelectedId(null);
      setMode({ kind: "view" });
    }
    clearSelection();
    showToast(`已将 ${count} 条移入回收站`);
  }, [items, selectedIds, selectedId, persist, clearSelection, showToast]);

  const handleBatchExport = useCallback(async () => {
    if (selectedItems.length === 0) return;
    const path = await chooseExportFile("prompt-vault-selection.json");
    if (!path) return;
    try {
      await writeDataFile(path, serializeDataFile(selectedItems));
      showToast(`已导出 ${selectedItems.length} 条`);
    } catch (e) {
      showToast(`导出失败:${String(e)}`, "err");
    }
  }, [selectedItems, showToast]);

  const handleBatchRestore = useCallback(async () => {
    const count = selectedIds.size;
    if (count === 0) return;
    const next = items.map((it) =>
      selectedIds.has(it.id) ? { ...it, deletedAt: undefined } : it,
    );
    await persist(next);
    setSelectedId(null);
    setMode({ kind: "view" });
    clearSelection();
    showToast(`已恢复 ${count} 条`);
  }, [items, selectedIds, persist, clearSelection, showToast]);

  const handleBatchPurge = useCallback(async () => {
    setBatchPurgeOpen(false);
    const count = selectedIds.size;
    if (count === 0) return;
    const next = items.filter((it) => !selectedIds.has(it.id));
    const affected = selectedId !== null && selectedIds.has(selectedId);
    await persist(next);
    if (affected) {
      setSelectedId(null);
      setMode({ kind: "view" });
    }
    clearSelection();
    showToast(`已彻底删除 ${count} 条`);
  }, [items, selectedIds, selectedId, persist, clearSelection, showToast]);

  // 多选快捷键:Ctrl+A 全选当前列表,Esc 清空(弹窗与输入框优先)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isComposingEvent(e)) return;
      if (typeof e.key !== "string") return;
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      const modalOpen = !!(
        copyTarget ||
        purgeTarget ||
        importCandidate ||
        batchPurgeOpen ||
        settingsOpen ||
        paletteOpen ||
        cheatsheetOpen
      );
      if (e.key === "Escape" && !typing && !modalOpen && selectedIds.size > 0) {
        e.preventDefault();
        clearSelection();
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "a" || e.key === "A") &&
        !typing &&
        !modalOpen &&
        filtered.length > 0
      ) {
        e.preventDefault();
        selectAllFiltered();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    copyTarget,
    purgeTarget,
    importCandidate,
    batchPurgeOpen,
    settingsOpen,
    paletteOpen,
    cheatsheetOpen,
    selectedIds.size,
    filtered.length,
    clearSelection,
    selectAllFiltered,
  ]);

  // 命令面板(Ctrl+K)与快捷键速查表(?)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isComposingEvent(e)) return;
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      const otherModalOpen = !!(
        copyTarget ||
        purgeTarget ||
        importCandidate ||
        batchPurgeOpen ||
        settingsOpen
      );
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "k" || e.key === "K")
      ) {
        e.preventDefault();
        if (paletteOpen) {
          setPaletteOpen(false);
          return;
        }
        if (otherModalOpen || cheatsheetOpen) return;
        setPaletteOpen(true);
        return;
      }
      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing) {
        e.preventDefault();
        if (cheatsheetOpen) {
          setCheatsheetOpen(false);
          return;
        }
        if (otherModalOpen || paletteOpen) return;
        setCheatsheetOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    paletteOpen,
    cheatsheetOpen,
    copyTarget,
    purgeTarget,
    importCandidate,
    batchPurgeOpen,
    settingsOpen,
  ]);

  const handleSave = useCallback(
    async (draft: Draft) => {
      const now = nowIso();
      if (mode.kind === "new") {
        const item: PromptItem = {
          id: newId(),
          createdAt: now,
          updatedAt: now,
          ...draft,
        };
        await persist([item, ...items]);
        setSelectedId(item.id);
        setMode({ kind: "view" });
        showToast("已保存");
      } else if (mode.kind === "edit") {
        const next = items.map((it) =>
          it.id === mode.id ? { ...it, ...draft, updatedAt: now } : it,
        );
        await persist(next);
        setMode({ kind: "view" });
        showToast("已保存");
      }
    },
    [mode, items, persist, showToast],
  );

  // 软删除:进回收站,可恢复
  const handleDelete = useCallback(
    async (item: PromptItem) => {
      const next = items.map((it) =>
        it.id === item.id ? { ...it, deletedAt: nowIso() } : it,
      );
      await persist(next);
      if (selectedId === item.id) {
        setSelectedId(null);
        setMode({ kind: "view" });
      }
      showToast("已移入回收站,可在回收站恢复");
    },
    [items, selectedId, persist, showToast],
  );

  const handleRestore = useCallback(
    async (item: PromptItem) => {
      const next = items.map((it) =>
        it.id === item.id ? { ...it, deletedAt: undefined } : it,
      );
      await persist(next);
      setSelectedId(null);
      showToast("已恢复");
    },
    [items, persist, showToast],
  );

  const handlePurge = useCallback(
    async (item: PromptItem) => {
      setPurgeTarget(null);
      await persist(items.filter((it) => it.id !== item.id));
      if (selectedId === item.id) {
        setSelectedId(null);
        setMode({ kind: "view" });
      }
      showToast("已彻底删除");
    },
    [items, selectedId, persist, showToast],
  );

  // 置顶只是标记,不改 updatedAt,避免扰动"其余按更新时间倒序"
  const handleTogglePin = useCallback(
    async (item: PromptItem) => {
      const next = items.map((it) =>
        it.id === item.id ? { ...it, pinned: !it.pinned } : it,
      );
      await persist(next);
      showToast(item.pinned ? "已取消置顶" : "已置顶");
    },
    [items, persist, showToast],
  );

  const copyWithToast = useCallback(
    async (text: string, okMsg: string): Promise<boolean> => {
      try {
        await copyToClipboard(text);
        showToast(okMsg);
        return true;
      } catch (e) {
        showToast(`复制失败:${String(e)}`, "err");
        return false;
      }
    },
    [showToast],
  );

  /** 复制成功后更新内存计数,再让 Rust 串行写盘(失败静默,复制优先) */
  const bumpCopyStat = useCallback(async (id: string) => {
    const now = nowIso();
    setItems((cur) =>
      cur.map((it) =>
        it.id === id
          ? { ...it, copyCount: (it.copyCount ?? 0) + 1, lastCopiedAt: now }
          : it,
      ),
    );
    const p = dataPathRef.current;
    if (!p) return;
    try {
      await bumpCopyStats(p, id);
    } catch {
      /* 统计失败不影响复制;之后任意一次正常写盘会带上内存里的计数 */
    }
  }, []);

  const handleCopy = useCallback(
    async (item: PromptItem) => {
      if (extractPlaceholders(item.body).length > 0) {
        setCopyTarget(item);
        return;
      }
      const ok = await copyWithToast(item.body, "已复制到剪贴板");
      if (ok) await bumpCopyStat(item.id);
    },
    [copyWithToast, bumpCopyStat],
  );

  const handleCopyFilled = useCallback(
    async (values: Record<string, string>) => {
      if (!copyTarget) return;
      const filled = fillPlaceholders(copyTarget.body, values);
      const ok = await copyWithToast(filled, "已复制到剪贴板(变量已填充)");
      setCopyTarget(null);
      if (!ok) return;
      // 统计先由 Rust 串行写盘,再把"上次填写值 + 本次计数"一次性落盘
      const p = dataPathRef.current;
      if (p) {
        try {
          await bumpCopyStats(p, copyTarget.id);
        } catch {
          /* 统计失败不影响复制 */
        }
      }
      const now = nowIso();
      await persist(
        items.map((it) =>
          it.id === copyTarget.id
            ? {
                ...it,
                lastValues: values,
                copyCount: (it.copyCount ?? 0) + 1,
                lastCopiedAt: now,
              }
            : it,
        ),
      );
    },
    [copyTarget, items, copyWithToast, persist],
  );

  const handleTagClick = useCallback((tag: string) => {
    setActiveTag((cur) => (cur === tag ? null : tag));
  }, []);

  const toggleTrash = useCallback(() => {
    setTrashOpen((v) => !v);
    setSelectedId(null);
    setSelectedIds(new Set());
    shiftAnchor.current = null;
    setMode({ kind: "view" });
    setActiveTag(null);
  }, []);

  const importFromPath = useCallback(
    async (path: string) => {
      try {
        const raw = await readDataFile(path);
        if (raw === null) {
          showToast("无法读取该文件", "err");
          return;
        }
        const incoming = coerceItems(JSON.parse(raw));
        if (incoming.length === 0) {
          showToast("文件中没有可导入的记录", "err");
          return;
        }
        setImportCandidate(incoming);
      } catch {
        showToast("文件解析失败,请确认是 Prompt Vault 导出的 JSON", "err");
      }
    },
    [showToast],
  );

  const handleImportPick = useCallback(async () => {
    const path = await chooseImportFile();
    if (!path) return;
    await importFromPath(path);
  }, [importFromPath]);

  /** 原生拖放:第一个路径决定走导入(.json)还是新建文本 */
  const handleDroppedPaths = useCallback(
    async (paths: string[]) => {
      const list = paths.filter((p) => typeof p === "string" && p.length > 0);
      if (list.length === 0) return;
      if (list.length > 1) showToast("一次仅处理一个文件");
      const path = list[0];
      const multi = list.length > 1;
      const name = fileNameOf(path);
      const meta = await pathMeta(path).catch(() => null);
      if (meta?.isDir) {
        showToast("不支持文件夹", "err");
        return;
      }
      if (name.toLowerCase().endsWith(".json")) {
        if (meta && meta.size > 10 * 1024 * 1024) {
          showToast("JSON 文件超过 10MB,已拒绝", "err");
          return;
        }
        await importFromPath(path);
        return;
      }
      // 其余一律按文本处理
      if (meta && meta.size > 1024 * 1024) {
        showToast("文本文件超过 1MB,已拒绝", "err");
        return;
      }
      let raw: string | null = null;
      try {
        raw = await readDataFile(path);
      } catch {
        raw = null;
      }
      if (raw === null) {
        showToast("读取失败,请确认是 UTF-8 文本", "err");
        return;
      }
      const title = name.replace(/\.[^.]+$/, "") || "未命名";
      setPrefill({ title, body: raw, source: `拖入:${name}` });
      setPrefillSeq((s) => s + 1);
      setTrashOpen(false);
      setSelectedId(null);
      setMode({ kind: "new" });
      showToast(multi ? `一次仅处理一个文件,已载入:${name}` : "已载入拖入内容");
    },
    [importFromPath, showToast],
  );

  // 主窗口拖放:用 Tauri 原生事件(HTML5 drop 会被原生拖放拦截)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    (async () => {
      try {
        const win = getCurrentWebviewWindow();
        if (win.label !== "main") return;
        const stop = await win.onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            setDropActive(true);
          } else if (payload.type === "leave") {
            setDropActive(false);
          } else if (payload.type === "drop") {
            setDropActive(false);
            void handleDroppedPaths(payload.paths);
          }
        });
        if (disposed) {
          stop();
        } else {
          unlisten = stop;
        }
      } catch {
        // 浏览器预览无原生拖放;打包环境若初始化失败在控制台留痕
        if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
          console.error("drag-drop listener init failed");
        }
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [handleDroppedPaths]);

  const handleImportApply = useCallback(
    async (how: ImportMode) => {
      const incoming = importCandidate;
      setImportCandidate(null);
      if (!incoming) return;
      if (how === "overwrite") {
        await persist(incoming);
        clearSelection();
        showToast(`导入完成:已覆盖为 ${incoming.length} 条`);
        return;
      }
      const byId = new Map(items.map((it) => [it.id, it]));
      let added = 0;
      let updated = 0;
      for (const inc of incoming) {
        const cur = byId.get(inc.id);
        if (!cur) {
          byId.set(inc.id, inc);
          added++;
          continue;
        }
        const record = isNewer(inc.updatedAt, cur.updatedAt) ? inc : cur;
        if (record === inc) updated++;
        // 统计字段单独合并:次数取大、最近复制时间取新
        const copyCount = Math.max(cur.copyCount ?? 0, inc.copyCount ?? 0);
        const lastCopiedAt = newerIso(cur.lastCopiedAt, inc.lastCopiedAt);
        const merged: PromptItem = { ...record };
        if (copyCount > 0) merged.copyCount = copyCount;
        if (lastCopiedAt) merged.lastCopiedAt = lastCopiedAt;
        byId.set(inc.id, merged);
      }
      await persist([...byId.values()]);
      clearSelection();
      showToast(`导入完成:新增 ${added} 条,更新 ${updated} 条`);
    },
    [importCandidate, items, persist, clearSelection, showToast],
  );

  const handleExport = useCallback(async () => {
    const path = await chooseExportFile("prompt-vault-export.json");
    if (!path) return;
    try {
      await writeDataFile(path, serializeDataFile(items));
      showToast("导出成功");
    } catch (e) {
      showToast(`导出失败:${String(e)}`, "err");
    }
  }, [items, showToast]);

  const handleRestoreBackup = useCallback(async () => {
    const p = loadError;
    if (!p) return;
    setRestoreState("doing");
    try {
      const ok = await restoreBackup(p);
      if (!ok) {
        setRestoreState("none");
        return;
      }
      setLoadError(null);
      setRestoreState("idle");
      await loadFrom(p);
      showToast("已从 .bak 备份恢复");
    } catch (e) {
      setRestoreState("idle");
      showToast(`恢复失败:${String(e)}`, "err");
    }
  }, [loadError, loadFrom, showToast]);

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const closeThen = (fn: () => void) => () => {
      setPaletteOpen(false);
      fn();
    };
    return [
      {
        id: "new",
        group: "收藏",
        label: "新建 prompt",
        keywords: ["new", "create", "xinjian", "新建"],
        shortcut: "Ctrl+N",
        icon: <IconPlus size={15} />,
        run: closeThen(startNew),
      },
      {
        id: "clipboard-new",
        group: "收藏",
        label: "从剪贴板新建",
        keywords: ["clipboard", "paste", "剪贴板", "粘贴"],
        shortcut: formatHotkey(hotkeys.clipboard_new),
        icon: <IconClipboard size={15} />,
        run: closeThen(() => void newFromClipboard()),
      },
      {
        id: "import",
        group: "收藏",
        label: "导入 JSON",
        keywords: ["import", "json", "导入"],
        icon: <IconImport size={15} />,
        run: closeThen(() => void handleImportPick()),
      },
      {
        id: "export",
        group: "收藏",
        label: "导出 JSON",
        keywords: ["export", "json", "导出"],
        icon: <IconExport size={15} />,
        run: closeThen(() => void handleExport()),
      },
      {
        id: "trash",
        group: "收藏",
        label: trashOpen ? "返回收藏列表" : "打开回收站",
        keywords: ["trash", "recycle", "回收站", "返回"],
        icon: trashOpen ? <IconUndo size={15} /> : <IconTrash size={15} />,
        run: closeThen(toggleTrash),
      },
      {
        id: "theme",
        group: "视图",
        label: theme === "dark" ? "切换到亮色模式" : "切换到暗色模式",
        keywords: ["theme", "dark", "light", "主题", "暗色", "亮色"],
        icon: theme === "dark" ? <IconSun size={15} /> : <IconMoon size={15} />,
        run: closeThen(toggleTheme),
      },
      {
        id: "sort-updated",
        group: "视图",
        label: "排序:最近更新",
        keywords: ["sort", "updated", "排序", "更新"],
        checked: sortMode === "updated",
        run: closeThen(() => setSortMode("updated")),
      },
      {
        id: "sort-recent",
        group: "视图",
        label: "排序:最近复制",
        keywords: ["sort", "recent", "排序", "复制"],
        checked: sortMode === "recent",
        run: closeThen(() => setSortMode("recent")),
      },
      {
        id: "sort-most",
        group: "视图",
        label: "排序:最常复制",
        keywords: ["sort", "most", "排序", "常用"],
        checked: sortMode === "most",
        run: closeThen(() => setSortMode("most")),
      },
      {
        id: "cheatsheet",
        group: "视图",
        label: "快捷键速查表",
        keywords: ["shortcut", "keys", "快捷键", "帮助", "?"],
        shortcut: "?",
        icon: <IconSparkles size={15} />,
        run: closeThen(() => setCheatsheetOpen(true)),
      },
      {
        id: "settings",
        group: "应用",
        label: "打开设置",
        keywords: ["settings", "hotkey", "设置", "热键"],
        hint: `快速拾取 ${formatHotkey(hotkeys.quickpick)}`,
        icon: <IconSettings size={15} />,
        run: closeThen(() => setSettingsOpen(true)),
      },
    ];
  }, [
    trashOpen,
    theme,
    sortMode,
    hotkeys,
    startNew,
    newFromClipboard,
    handleImportPick,
    handleExport,
    toggleTrash,
    toggleTheme,
    setSortMode,
  ]);

  if (setupFailed) {
    return (
      <div className="app">
        <TitleBar />
        <SetupScreen onPick={() => void chooseDataLocation()} />
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="app">
        <TitleBar />
        <LoadErrorScreen
          path={loadError}
          restoreState={restoreState}
          onRestore={() => void handleRestoreBackup()}
        />
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="app">
        <TitleBar />
        <div className="screen">
          <div className="spinner" aria-label="加载中" />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <TitleBar />
      <header className="header">
        <div className="search-wrap">
          <IconSearch size={15} className="search-icon" />
          <input
            ref={searchRef}
            className="search"
            placeholder="搜索 标题 / 正文 / 标签 / 备注…(Ctrl+F)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {activeTag && !trashOpen && (
            <button
              className="tag-filter"
              title="清除标签筛选"
              onClick={() => setActiveTag(null)}
            >
              #{activeTag}
              <IconX size={12} />
            </button>
          )}
        </div>
        <div className="header-actions">
          <button className="btn primary" onClick={startNew}>
            <IconPlus size={15} /> 新建 (Ctrl+N)
          </button>
          <button
            className="btn"
            title="把剪贴板内容存为新收藏(全局快捷键 Alt+Shift+N)"
            onClick={() => void newFromClipboard()}
          >
            <IconClipboard size={15} /> 剪贴板
          </button>
          <button
            className={"btn" + (trashOpen ? " pressed" : "")}
            onClick={toggleTrash}
            title="回收站"
          >
            <IconTrash size={15} /> 回收站
          </button>
          <button className="btn" onClick={() => void handleImportPick()}>
            <IconImport size={15} /> 导入
          </button>
          <button className="btn" onClick={() => void handleExport()}>
            <IconExport size={15} /> 导出
          </button>
          <button
            className="icon-btn"
            title="设置(全局热键)"
            onClick={() => setSettingsOpen(true)}
          >
            <IconSettings size={16} />
          </button>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <div className="main">
        <Sidebar
          items={filtered}
          total={trashOpen ? trashItems.length : liveItems.length}
          trashOpen={trashOpen}
          sortMode={sortMode}
          onSortChange={setSortMode}
          selectedId={selectedId}
          selectedIds={selectedIds}
          onRowClick={handleRowClick}
          onCheckbox={toggleSelected}
          onTagClick={handleTagClick}
          onQuickCopy={(it) => void handleCopy(it)}
        />
        {selectedIds.size > 0 ? (
          <BatchPanel
            count={selectedIds.size}
            trashOpen={trashOpen}
            allTags={allTags}
            allSelected={allFilteredSelected}
            onSelectAll={selectAllFiltered}
            onClear={clearSelection}
            onAddTags={handleBatchAddTags}
            onBatchDelete={handleBatchDelete}
            onBatchExport={handleBatchExport}
            onBatchRestore={handleBatchRestore}
            onBatchPurge={() => setBatchPurgeOpen(true)}
          />
        ) : (
          <DetailPane
            item={selectedItem}
            mode={mode}
            allTags={allTags}
            trashOpen={trashOpen}
            onSave={handleSave}
            onCancel={() => setMode({ kind: "view" })}
            onEdit={() => {
              if (selectedItem) setMode({ kind: "edit", id: selectedItem.id });
            }}
            onCopy={(it) => void handleCopy(it)}
            onTogglePin={(it) => void handleTogglePin(it)}
            onDelete={(it) => void handleDelete(it)}
            onTagClick={handleTagClick}
            onRestore={(it) => void handleRestore(it)}
            onPurge={(it) => setPurgeTarget(it)}
            prefill={prefill}
            prefillSeq={prefillSeq}
          />
        )}
      </div>

      <DropOverlay visible={dropActive} />

      {copyTarget && (
        <PlaceholderModal
          names={extractPlaceholders(copyTarget.body)}
          initialValues={copyTarget.lastValues}
          onConfirm={(values) => void handleCopyFilled(values)}
          onCancel={() => setCopyTarget(null)}
        />
      )}
      {purgeTarget && (
        <ConfirmModal
          title="彻底删除"
          message={`确定彻底删除「${purgeTarget.title || "未命名"}」?此操作不可恢复。`}
          confirmText="彻底删除"
          danger
          onConfirm={() => void handlePurge(purgeTarget)}
          onCancel={() => setPurgeTarget(null)}
        />
      )}
      {batchPurgeOpen && (
        <ConfirmModal
          title="彻底删除"
          message={`确定彻底删除选中的 ${selectedIds.size} 条?此操作不可恢复。`}
          confirmText="彻底删除"
          danger
          onConfirm={() => void handleBatchPurge()}
          onCancel={() => setBatchPurgeOpen(false)}
        />
      )}
      {importCandidate && (
        <ImportChoiceModal
          count={importCandidate.length}
          onApply={(how) => void handleImportApply(how)}
          onCancel={() => setImportCandidate(null)}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          onClose={() => {
            setSettingsOpen(false);
            void loadHotkeys();
          }}
          showToast={showToast}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          commands={paletteCommands}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {cheatsheetOpen && (
        <CheatsheetModal
          hotkeys={hotkeys}
          onClose={() => setCheatsheetOpen(false)}
        />
      )}
      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}
