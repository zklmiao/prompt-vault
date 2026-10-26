import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import type { Draft, ImportMode, Mode, PromptItem, Theme } from "./types";
import {
  chooseDataFileSave,
  chooseExportFile,
  chooseImportFile,
  copyToClipboard,
  firstRunDefaultPath,
  getDataPath,
  readClipboard,
  readDataFile,
  restoreBackup,
  setDataPath,
  writeDataFile,
} from "./api";
import {
  coerceItems,
  extractPlaceholders,
  fillPlaceholders,
  isNewer,
  newId,
  nowIso,
  serializeDataFile,
} from "./util";
import { applyTheme, currentTheme } from "./theme";
import Sidebar from "./components/Sidebar";
import DetailPane from "./components/DetailPane";
import PlaceholderModal from "./components/PlaceholderModal";
import ConfirmModal from "./components/ConfirmModal";
import ImportChoiceModal from "./components/ImportChoiceModal";
import {
  IconClipboard,
  IconExport,
  IconImport,
  IconMoon,
  IconPlus,
  IconSearch,
  IconSun,
  IconTrash,
  IconX,
} from "./components/icons";

type Toast = { text: string; kind: "ok" | "err" };
type RestoreState = "idle" | "doing" | "none";

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme());
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };
  return (
    <button
      className="icon-btn"
      onClick={toggle}
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
  const [prefillBody, setPrefillBody] = useState<string | null>(null);
  const [prefillSeq, setPrefillSeq] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);

  const dataPathRef = useRef<string | null>(null);
  const bootstrapped = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((text: string, kind: "ok" | "err" = "ok") => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 2200);
  }, []);

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
          setPrefillBody(e.payload ?? "");
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
    })();
    return () => {
      disposed = true;
      unlistens.forEach((u) => u());
    };
  }, [showToast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  }, []);

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
    const q = search.trim().toLowerCase();
    let list = activeTag
      ? liveItems.filter((it) => it.tags.includes(activeTag))
      : liveItems;
    if (q) {
      list = list.filter((it) =>
        [it.title, it.body, it.source, it.note, it.tags.join(" ")]
          .join("\n")
          .toLowerCase()
          .includes(q),
      );
    }
    return [...list].sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
  }, [trashOpen, trashItems, liveItems, search, activeTag]);

  const selectedItem = selectedId
    ? (items.find((i) => i.id === selectedId) ?? null)
    : null;

  const startNew = useCallback(() => {
    setPrefillBody(null);
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
    setPrefillBody(text ?? "");
    setPrefillSeq((s) => s + 1);
    setMode({ kind: "new" });
  }, []);

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

  const handleCopy = useCallback(
    async (item: PromptItem) => {
      if (extractPlaceholders(item.body).length > 0) {
        setCopyTarget(item);
        return;
      }
      await copyWithToast(item.body, "已复制到剪贴板");
    },
    [copyWithToast],
  );

  const handleCopyFilled = useCallback(
    async (values: Record<string, string>) => {
      if (!copyTarget) return;
      const filled = fillPlaceholders(copyTarget.body, values);
      const ok = await copyWithToast(filled, "已复制到剪贴板(变量已填充)");
      setCopyTarget(null);
      if (ok) {
        // 记住本次填写值,下次弹窗预填
        await persist(
          items.map((it) =>
            it.id === copyTarget.id ? { ...it, lastValues: values } : it,
          ),
        );
      }
    },
    [copyTarget, items, copyWithToast, persist],
  );

  const handleTagClick = useCallback((tag: string) => {
    setActiveTag((cur) => (cur === tag ? null : tag));
  }, []);

  const toggleTrash = useCallback(() => {
    setTrashOpen((v) => !v);
    setSelectedId(null);
    setMode({ kind: "view" });
    setActiveTag(null);
  }, []);

  const handleImportPick = useCallback(async () => {
    const path = await chooseImportFile();
    if (!path) return;
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
  }, [showToast]);

  const handleImportApply = useCallback(
    async (how: ImportMode) => {
      const incoming = importCandidate;
      setImportCandidate(null);
      if (!incoming) return;
      if (how === "overwrite") {
        await persist(incoming);
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
        } else if (isNewer(inc.updatedAt, cur.updatedAt)) {
          byId.set(inc.id, inc);
          updated++;
        }
      }
      await persist([...byId.values()]);
      showToast(`导入完成:新增 ${added} 条,更新 ${updated} 条`);
    },
    [importCandidate, items, persist, showToast],
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

  if (setupFailed) {
    return (
      <div className="app">
        <SetupScreen onPick={() => void chooseDataLocation()} />
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="app">
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
        <div className="screen">
          <div className="spinner" aria-label="加载中" />
        </div>
      </div>
    );
  }

  return (
    <div className="app">
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
          <ThemeToggle />
        </div>
      </header>

      <div className="main">
        <Sidebar
          items={filtered}
          total={trashOpen ? trashItems.length : liveItems.length}
          trashOpen={trashOpen}
          selectedId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            setMode({ kind: "view" });
          }}
          onTagClick={handleTagClick}
          onQuickCopy={(it) => void handleCopy(it)}
        />
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
          prefillBody={prefillBody}
          prefillSeq={prefillSeq}
        />
      </div>

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
      {importCandidate && (
        <ImportChoiceModal
          count={importCandidate.length}
          onApply={(how) => void handleImportApply(how)}
          onCancel={() => setImportCandidate(null)}
        />
      )}
      {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
    </div>
  );
}
