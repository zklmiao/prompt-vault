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
  sha256Hex,
} from "./util";
import { applyTheme, currentTheme } from "./theme";
import { useI18n } from "./i18n";
import { windowLabel } from "./window";
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
import PluginHub from "./plugins/PluginHub";
import {
  bootstrapPlugins,
  buildPluginPaletteCommands,
} from "./plugins/host";
import type { HostHooks } from "./plugins/host";
import type { PluginPaletteCommand } from "./plugins/palette";
import {
  IconClipboard,
  IconExport,
  IconImport,
  IconMoon,
  IconPlugin,
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
  const { t } = useI18n();
  return (
    <button
      className="icon-btn"
      onClick={onToggle}
      title={theme === "dark" ? t("palette.cmdThemeLight") : t("palette.cmdThemeDark")}
    >
      {theme === "dark" ? <IconSun size={16} /> : <IconMoon size={16} />}
    </button>
  );
}

function SetupScreen({ onPick }: { onPick: () => void }) {
  const { t } = useI18n();
  return (
    <div className="screen">
      <h1>{t("setup.title")}</h1>
      <p>{t("setup.desc")}</p>
      <p className="muted">{t("setup.hint")}</p>
      <button className="btn primary" onClick={onPick}>
        {t("setup.pick")}
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
  const { t } = useI18n();
  return (
    <div className="screen">
      <h1>{t("loadError.title")}</h1>
      <p>{t("loadError.desc")}</p>
      <code className="error-path">{path}</code>
      <p className="muted">{t("loadError.hint")}</p>
      {restoreState === "none" ? (
        <p className="muted">{t("loadError.noBak")}</p>
      ) : (
        <button
          className="btn primary"
          disabled={restoreState === "doing"}
          onClick={onRestore}
        >
          {restoreState === "doing" ? t("loadError.restoring") : t("loadError.restore")}
        </button>
      )}
    </div>
  );
}

/* ============ 私人彩蛋「密语暗屉」 ============ */
// 私人彩蛋文案:硬编码中文,不进 i18n;正文(隐藏 prompt)显示与复制同源,
// 经 prop 传给 Sidebar;永不落盘——复制不走 handleCopy,不增 copyCount、不写统计
const EGG_BODY = "写一封信，寄给还没成为自己的那天。";
// 复制成功专属 toast 文案(不走通用「已复制」)
const EGG_COPIED_TOAST = "无论朝哪个方向飞，都是正确的。";
// 私人彩蛋密语摘要:比对 sha256Hex(search.trim())(区分大小写,除 trim 外不做
// 任何归一化);密语明文不进仓库、不进对话、不进任何落盘文件,仅由用户本人持有
const EGG_DIGEST =
  "78ba78d8117d18e29bdaa8b2dcffaf9dba98c846a91580d332a7bb788bb1aeef";
// 预览夹具:?egg=1 仅绕过摘要校验(命中恒真),仅供评审/回归,生命周期共用同一
// 段逻辑——夹具命中恒真,复制收回后改动一次搜索即可再现;真机则需重新输入密语;
// 打包环境无人传此参数,天然惰性
const EGG_FIXTURE =
  new URLSearchParams(window.location.search).get("egg") === "1";

export default function App() {
  const { t } = useI18n();
  const [ready, setReady] = useState(false);
  const [setupFailed, setSetupFailed] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [restoreState, setRestoreState] = useState<RestoreState>("idle");
  const [items, setItems] = useState<PromptItem[]>([]);
  const [search, setSearch] = useState("");
  /** 私人彩蛋「密语暗屉」:摘要命中时浮现;搜索一改或复制后收回(见下方 effect) */
  const [eggOpen, setEggOpen] = useState(false);
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
  const [onboarded, setOnboarded] = useState<boolean>(() => {
    try {
      return localStorage.getItem("pv-onboarded") === "1";
    } catch {
      return false;
    }
  });
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
  /** 主区分栏:收藏 / 插件 */
  const [pane, setPane] = useState<"collection" | "plugins">("collection");
  /** 插件区弹层(权限确认/卸载确认)打开时静默窗口级快捷键 */
  const [pluginModalOpen, setPluginModalOpen] = useState(false);
  /** 插件命令(命令面板合并展示;注入完成后刷新) */
  const [pluginCmds, setPluginCmds] = useState<PluginPaletteCommand[]>([]);

  // 任一弹层打开时,窗口级列表快捷键全部静默
  const overlayOpen = !!(
    copyTarget ||
    purgeTarget ||
    importCandidate ||
    batchPurgeOpen ||
    settingsOpen ||
    paletteOpen ||
    cheatsheetOpen ||
    pluginModalOpen
  );

  const dataPathRef = useRef<string | null>(null);
  const bootstrapped = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const shiftAnchor = useRef<string | null>(null);
  /** 事件回调里读取最新编辑态(data-changed 刷新守卫) */
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  const paneRef = useRef(pane);
  useEffect(() => {
    paneRef.current = pane;
  }, [pane]);

  // 私人彩蛋「密语暗屉」:在原有「摘要命中即显、搜索一改即收回」逻辑上,
  // 评审补充「复制后收回」——复制成功即隐藏,下次搜索命中时自然再现(真机需
  // 重新输入密语)。防抖 ~150ms 后比对 sha256Hex(search.trim()) 与 EGG_DIGEST
  //(区分大小写,除 trim 外不做任何归一化),命中浮现、失败静默。
  // sha256Hex fail-closed 返回 "" 恒不命中(无 crypto.subtle 的环境彩蛋自动失效);
  // epoch 守卫丢弃过期异步结果(连续输入仅最后一次生效)。
  // 夹具 ?egg=1 仅绕过摘要校验(命中恒真),逻辑共用同一段
  const eggEpoch = useRef(0);
  useEffect(() => {
    setEggOpen(false); // 搜索一改即收回(复制收回见 handleEggCopy)
    const epoch = ++eggEpoch.current;
    const timer = window.setTimeout(() => {
      void sha256Hex(search.trim()).then((digest) => {
        if (eggEpoch.current !== epoch) return;
        setEggOpen(EGG_FIXTURE || (digest !== "" && digest === EGG_DIGEST));
      });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [search]);

  const showToast = useCallback((text: string, kind: "ok" | "err" = "ok") => {
    setToast({ text, kind });
    window.setTimeout(() => setToast(null), 2200);
  }, []);

  const refreshPluginCommands = useCallback(() => {
    setPluginCmds(buildPluginPaletteCommands());
  }, []);

  const pluginHostHooks = useMemo<HostHooks>(
    () => ({
      showToast,
      onCommandsChanged: refreshPluginCommands,
      t,
    }),
    [showToast, refreshPluginCommands, t],
  );
  // bootstrap 只随 ready 触发一次:hooks 经 ref 取最新值,
  // 否则 t 身份变化会重跑注入(注入又会更新 i18n 快照,形成反馈环)
  const pluginHostHooksRef = useRef<HostHooks>(pluginHostHooks);
  pluginHostHooksRef.current = pluginHostHooks;

  // 插件宿主:主窗口就绪后按 plugins.json enabled 顺序注入(失败隔离)
  useEffect(() => {
    if (!ready) return;
    if (windowLabel() !== "main") return;
    void bootstrapPlugins(pluginHostHooksRef.current).catch((e) => {
      console.error("[pv] 插件宿主启动失败:", e);
    });
  }, [ready]);

  const markOnboarded = useCallback(() => {
    setOnboarded(true);
    try {
      localStorage.setItem("pv-onboarded", "1");
    } catch {
      /* localStorage 不可用:仅本次运行生效 */
    }
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
        showToast(t("toast.saveFailed", { msg: String(e) }), "err");
      }
    },
    [showToast, t],
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
    const chosen = await chooseDataFileSave(suggested, t("dialog.saveDataFile"));
    if (!chosen) return false;
    await setDataPath(chosen);
    dataPathRef.current = chosen;
    setSetupFailed(false);
    await loadFrom(chosen);
    return true;
  }, [loadFrom, t]);

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
    })().catch((e) => showToast(t("toast.initFailed", { msg: String(e) }), "err"));
  }, [chooseDataLocation, loadFrom, showToast, t]);

  // 托盘隐藏提示 + 全局"剪贴板新建"事件
  useEffect(() => {
    const unlistens: Array<() => void> = [];
    let disposed = false;
    (async () => {
      try {
        const u1 = await listen("hidden-to-tray", () => {
          showToast(t("toast.trayHidden"));
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
        // 数据文件被外部写入(MCP headless / 其他进程):静默刷新;
        // 编辑态跳过本次刷新防打断草稿,退出编辑后由既有持久化机制兜底
        const u5 = await listen("data-changed", () => {
          if (modeRef.current.kind !== "view") return;
          void refreshFromDisk();
        });
        if (disposed) {
          u5();
          return;
        }
        unlistens.push(u5);
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
              showToast(t("toast.itemGone"), "err");
              return;
            }
            let parsed: PromptItem[] = [];
            try {
              parsed = coerceItems(JSON.parse(raw));
            } catch {
              showToast(t("toast.readFailed"), "err");
              return;
            }
            const target = parsed.find(
              (it) => it.id === e.payload && !it.deletedAt,
            );
            if (!target) {
              showToast(t("toast.itemGone"), "err");
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
      try {
        // 快速拾取窗口按 Ctrl+N:唤出主窗口并进入空白新建态(清弹层集对齐 open-editor;
        // 剪贴板速存职责仍归全局 Alt+Shift+N,不碰 clipboard-new 语义)
        const u6 = await listen("open-new", () => {
          setTrashOpen(false);
          setSearch("");
          setActiveTag(null);
          setCopyTarget(null);
          setPurgeTarget(null);
          setImportCandidate(null);
          setBatchPurgeOpen(false);
          setSettingsOpen(false);
          setSelectedId(null);
          setPrefill(null);
          setPrefillSeq((s) => s + 1);
          setMode({ kind: "new" });
        });
        if (disposed) {
          u6();
          return;
        }
        unlistens.push(u6);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      disposed = true;
      unlistens.forEach((u) => u());
    };
  }, [refreshFromDisk, showToast, t]);

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

  // 键盘活动项:仅当 selectedId 仍出现在当前过滤结果中时有效
  const activeId = useMemo(
    () => (filtered.some((it) => it.id === selectedId) ? selectedId : null),
    [filtered, selectedId],
  );

  const selectedItem = selectedId
    ? (items.find((i) => i.id === selectedId) ?? null)
    : null;

  // 活动项滚动跟随(block: nearest 不产生滚动动画)
  useEffect(() => {
    if (!activeId) return;
    document
      .getElementById(`pv-row-${activeId}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  // 离开编辑态后把焦点交还搜索框
  const prevModeKindRef = useRef(mode.kind);
  useEffect(() => {
    if (prevModeKindRef.current === "edit" && mode.kind !== "edit") {
      searchRef.current?.focus();
    }
    prevModeKindRef.current = mode.kind;
  }, [mode]);

  const selectedItems = useMemo(
    () => items.filter((it) => selectedIds.has(it.id)),
    [items, selectedIds],
  );

  const startNew = useCallback(() => {
    setPrefill(null);
    setPrefillSeq((s) => s + 1);
    setMode({ kind: "new" });
  }, []);

  /** 引导第 2 步:带示例内容的预填(创建时取当前语言,创建后即用户数据,不随切换变) */
  const handleCreateSample = useCallback(() => {
    setPrefill({
      title: t("sample.title"),
      body: t("sample.body"),
      source: t("sample.source"),
      tags: [t("sample.tag")],
      kind: "sample",
    });
    setPrefillSeq((s) => s + 1);
    setMode({ kind: "new" });
  }, [t]);

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

  // 行获得键盘焦点时同步活动项(编辑态下不改,避免干扰正在编辑的内容)
  const handleRowFocus = useCallback(
    (id: string) => {
      if (mode.kind === "view") setSelectedId(id);
    },
    [mode],
  );

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
      showToast(t("toast.batchTagsAdded", { n: selectedIds.size }));
    },
    [items, selectedIds, persist, showToast, t],
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
    showToast(t("toast.batchTrashed", { n: count }));
  }, [items, selectedIds, selectedId, persist, clearSelection, showToast, t]);

  const handleBatchExport = useCallback(async () => {
    if (selectedItems.length === 0) return;
    const path = await chooseExportFile("prompt-vault-selection.json", t("dialog.exportFile"));
    if (!path) return;
    try {
      await writeDataFile(path, serializeDataFile(selectedItems));
      showToast(t("toast.batchExported", { n: selectedItems.length }));
    } catch (e) {
      showToast(t("toast.exportFailed", { msg: String(e) }), "err");
    }
  }, [selectedItems, showToast, t]);

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
    showToast(t("toast.batchRestored", { n: count }));
  }, [items, selectedIds, persist, clearSelection, showToast, t]);

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
    showToast(t("toast.batchPurged", { n: count }));
  }, [items, selectedIds, selectedId, persist, clearSelection, showToast, t]);

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
          target.tagName === "SELECT" ||
          target.isContentEditable);
      const modalOpen = overlayOpen;
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
    overlayOpen,
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
      const p = dataPathRef.current;
      // M2(审查报告 2026-11-21):data-changed 守卫让编辑期间的磁盘外部新增
      // (如 MCP save_prompt)不进内存 items,直接用内存数组 persist 全量覆写
      // 会把它们静默抹除(.bak 可人工恢复,但数据丢失)。保存前重读磁盘构建
      // merge 基线:外部新增天然保留;edit 目标条目以磁盘条目为底、draft 盖上
      // (保住 copyCount/lastCopiedAt/lastValues/deletedAt 等统计与软删字段);
      // 目标 id 磁盘不存在(编辑期间被外部删除/异常)→ 以内存条目为底追加。
      // 读盘失败(JSON 损坏)→ 回退内存 items 全量写:不因合并逻辑把用户挡在
      // 保存之外(现状语义)。已知残留:重读→写盘间存在毫秒级窗口,并发 MCP
      // 写仍可丢 —— 闭合需 Rust 锁内读改写命令,已留档不做。
      let base = items;
      if (p) {
        try {
          const raw = await readDataFile(p);
          if (raw !== null) {
            base = coerceItems(JSON.parse(raw));
          }
        } catch {
          /* 磁盘损坏/读失败:回退内存 items 全量写,维持现状语义 */
        }
      }
      if (mode.kind === "new") {
        const item: PromptItem = {
          id: newId(),
          createdAt: now,
          updatedAt: now,
          ...draft,
        };
        await persist([item, ...base]);
        setSelectedId(item.id);
        setMode({ kind: "view" });
        showToast(t("toast.saved"));
        // 任意新建成功即视为已完成引导,避免删光后反复出现
        markOnboarded();
      } else if (mode.kind === "edit") {
        const memTarget = items.find((it) => it.id === mode.id);
        const next = base.some((it) => it.id === mode.id)
          ? base.map((it) =>
              it.id === mode.id ? { ...it, ...draft, updatedAt: now } : it,
            )
          : [
              ...base,
              memTarget
                ? { ...memTarget, ...draft, updatedAt: now }
                : { id: mode.id, createdAt: now, updatedAt: now, ...draft },
            ];
        await persist(next);
        setMode({ kind: "view" });
        showToast(t("toast.saved"));
      }
    },
    [mode, items, persist, showToast, markOnboarded, t],
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
      showToast(t("toast.trashed"));
    },
    [items, selectedId, persist, showToast, t],
  );

  const handleRestore = useCallback(
    async (item: PromptItem) => {
      const next = items.map((it) =>
        it.id === item.id ? { ...it, deletedAt: undefined } : it,
      );
      await persist(next);
      setSelectedId(null);
      showToast(t("toast.restored"));
    },
    [items, persist, showToast, t],
  );

  const handlePurge = useCallback(
    async (item: PromptItem) => {
      setPurgeTarget(null);
      await persist(items.filter((it) => it.id !== item.id));
      if (selectedId === item.id) {
        setSelectedId(null);
        setMode({ kind: "view" });
      }
      showToast(t("toast.purged"));
    },
    [items, selectedId, persist, showToast, t],
  );

  // 置顶只是标记,不改 updatedAt,避免扰动"其余按更新时间倒序"
  const handleTogglePin = useCallback(
    async (item: PromptItem) => {
      const next = items.map((it) =>
        it.id === item.id ? { ...it, pinned: !it.pinned } : it,
      );
      await persist(next);
      showToast(item.pinned ? t("toast.unpinned") : t("toast.pinned"));
    },
    [items, persist, showToast, t],
  );

  const copyWithToast = useCallback(
    async (text: string, okMsg: string): Promise<boolean> => {
      try {
        await copyToClipboard(text);
        showToast(okMsg);
        return true;
      } catch (e) {
        showToast(t("toast.copyFailed", { msg: String(e) }), "err");
        return false;
      }
    },
    [showToast, t],
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

  // 私人彩蛋复制:不走 handleCopy/copyWithToast 的统计链路——不增 copyCount、
  // 不触发统计写盘;失败复用既有 err toast 文案(彩蛋文案不进 i18n,错误文案是
  // 存量 key)。复制成功即收回(评审补充),下次搜索命中时自然再现
  const handleEggCopy = useCallback(async () => {
    try {
      await copyToClipboard(EGG_BODY);
      setEggOpen(false);
      showToast(EGG_COPIED_TOAST);
    } catch (e) {
      showToast(t("toast.copyFailed", { msg: String(e) }), "err");
    }
  }, [showToast, t]);

  const handleCopy = useCallback(
    async (item: PromptItem) => {
      if (extractPlaceholders(item.body).length > 0) {
        setCopyTarget(item);
        return;
      }
      const ok = await copyWithToast(item.body, t("toast.copied"));
      if (ok) await bumpCopyStat(item.id);
    },
    [copyWithToast, bumpCopyStat, t],
  );

  const handleCopyFilled = useCallback(
    async (values: Record<string, string>) => {
      if (!copyTarget) return;
      const filled = fillPlaceholders(copyTarget.body, values);
      const ok = await copyWithToast(filled, t("toast.copiedFilled"));
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
          showToast(t("toast.importReadFailed"), "err");
          return;
        }
        const incoming = coerceItems(JSON.parse(raw));
        if (incoming.length === 0) {
          showToast(t("toast.importEmpty"), "err");
          return;
        }
        setImportCandidate(incoming);
      } catch {
        showToast(t("toast.importParseFailed"), "err");
      }
    },
    [showToast, t],
  );

  // 主列表键盘闭环:↑↓/Home/End 导航,Enter 复制,Ctrl+E 编辑,Space 勾选
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isComposingEvent(e)) return;
      if (overlayOpen) return;
      // 插件分栏下没有收藏列表,全部列表键静默
      if (paneRef.current === "plugins") return;
      const el = e.target as HTMLElement | null;
      if (!el) return;
      const tag = el.tagName;
      const inputType = tag === "INPUT" ? (el as HTMLInputElement).type : "";
      // 原生控件优先:下拉 / 按钮 / 复选框 / 单选
      if (
        tag === "SELECT" ||
        tag === "BUTTON" ||
        (tag === "INPUT" &&
          ["checkbox", "radio", "button", "submit", "reset"].includes(inputType))
      ) {
        return;
      }
      const isSearch = el === searchRef.current;
      const isTextEntry =
        tag === "TEXTAREA" ||
        el.isContentEditable ||
        (tag === "INPUT" &&
          !["checkbox", "radio", "button", "submit", "reset"].includes(inputType));
      // 编辑器等文本输入区:方向键/空格交给文本;Esc 退出编辑并回到搜索框
      if (isTextEntry && !isSearch) {
        if (e.key === "Escape" && mode.kind !== "view") {
          e.preventDefault();
          setMode({ kind: "view" });
          searchRef.current?.focus();
        }
        return;
      }
      if (mode.kind !== "view") return;
      // 仅在搜索框、列表行内或空白处响应
      const inList = el.closest("#pv-list") != null;
      if (!isSearch && !inList && tag !== "BODY" && el.id !== "root") return;

      const activeIdx = activeId
        ? filtered.findIndex((it) => it.id === activeId)
        : -1;
      const move = (to: number) => {
        if (filtered.length === 0) return;
        const clamped = Math.max(0, Math.min(filtered.length - 1, to));
        const next = filtered[clamped];
        if (!next || next.id === activeId) return;
        setSelectedId(next.id);
        // 焦点在列表行内时,把 DOM 焦点同步到新行(roving tabindex)
        if (!isSearch) {
          document.getElementById(`pv-row-${next.id}`)?.focus();
        }
      };

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          move(activeIdx === -1 ? 0 : activeIdx + 1);
          return;
        case "ArrowUp":
          e.preventDefault();
          move(activeIdx === -1 ? filtered.length - 1 : activeIdx - 1);
          return;
        case "Home":
          e.preventDefault();
          move(0);
          return;
        case "End":
          e.preventDefault();
          move(filtered.length - 1);
          return;
        case "Enter": {
          e.preventDefault();
          if (activeIdx !== -1) {
            void handleCopy(filtered[activeIdx]);
          } else if (filtered.length > 0) {
            // 无活动项:先选中第一条,不复制(避免复制看不见的内容)
            setSelectedId(filtered[0].id);
          }
          return;
        }
        case " ": {
          if (!inList || !activeId) return;
          e.preventDefault();
          toggleSelected(activeId);
          return;
        }
        default:
          break;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        (e.key === "e" || e.key === "E")
      ) {
        if (trashOpen || activeIdx === -1) return;
        e.preventDefault();
        setMode({ kind: "edit", id: filtered[activeIdx].id });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    overlayOpen,
    filtered,
    activeId,
    mode,
    trashOpen,
    handleCopy,
    toggleSelected,
  ]);

  const handleImportPick = useCallback(async () => {
    const path = await chooseImportFile(t("dialog.importFile"));
    if (!path) return;
    await importFromPath(path);
  }, [importFromPath, t]);

  /** 收藏/插件分栏切换:清空列表选择与编辑态 */
  const switchPane = useCallback((next: "collection" | "plugins") => {
    setPane(next);
    setSelectedId(null);
    setSelectedIds(new Set());
    shiftAnchor.current = null;
    setMode({ kind: "view" });
    setActiveTag(null);
  }, []);

  /** 球窗「打开详情面板」的跨窗口激活信号(seq 保证同插件重复事件也重触发) */
  const [panelFocus, setPanelFocus] = useState<{ id: string; seq: number } | null>(null);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const stop = await listen<string>("pv-open-plugin-panel", (e) => {
          const id = e.payload;
          if (typeof id !== "string" || id === "") return;
          setPanelFocus((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }));
          switchPane("plugins");
        });
        if (disposed) stop();
        else unlisten = stop;
      } catch {
        /* 浏览器预览无事件系统 */
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [switchPane]);

  /** 原生拖放:第一个路径决定走导入(.json)还是新建文本 */
  const handleDroppedPaths = useCallback(
    async (paths: string[]) => {
      const list = paths.filter((p) => typeof p === "string" && p.length > 0);
      if (list.length === 0) return;
      if (list.length > 1) showToast(t("toast.oneFileAtATime"));
      const path = list[0];
      const multi = list.length > 1;
      const name = fileNameOf(path);
      const meta = await pathMeta(path).catch(() => null);
      if (meta?.isDir) {
        showToast(t("toast.folderUnsupported"), "err");
        return;
      }
      if (name.toLowerCase().endsWith(".json")) {
        if (meta && meta.size > 10 * 1024 * 1024) {
          showToast(t("toast.jsonTooLarge"), "err");
          return;
        }
        await importFromPath(path);
        return;
      }
      // 其余一律按文本处理
      if (meta && meta.size > 1024 * 1024) {
        showToast(t("toast.textTooLarge"), "err");
        return;
      }
      let raw: string | null = null;
      try {
        raw = await readDataFile(path);
      } catch {
        raw = null;
      }
      if (raw === null) {
        showToast(t("toast.dropReadFailed"), "err");
        return;
      }
      const title = name.replace(/\.[^.]+$/, "") || t("common.untitled");
      setPrefill({
        title,
        body: raw,
        source: t("toast.dropSourcePrefix", { name }),
        kind: "drop",
      });
      setPrefillSeq((s) => s + 1);
      setTrashOpen(false);
      setSelectedId(null);
      setMode({ kind: "new" });
      showToast(multi ? t("toast.dropLoadedNamed", { name }) : t("toast.dropLoaded"));
    },
    [importFromPath, showToast, t],
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
        showToast(t("toast.importOverwriteDone", { n: incoming.length }));
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
      showToast(t("toast.importDone", { added, updated }));
    },
    [importCandidate, items, persist, clearSelection, showToast, t],
  );

  const handleExport = useCallback(async () => {
    const path = await chooseExportFile("prompt-vault-export.json", t("dialog.exportFile"));
    if (!path) return;
    try {
      await writeDataFile(path, serializeDataFile(items));
      showToast(t("toast.exportOk"));
    } catch (e) {
      showToast(t("toast.exportFailed", { msg: String(e) }), "err");
    }
  }, [items, showToast, t]);

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
      showToast(t("toast.restoreOk"));
    } catch (e) {
      setRestoreState("idle");
      showToast(t("toast.restoreFailed", { msg: String(e) }), "err");
    }
  }, [loadError, loadFrom, showToast, t]);

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const closeThen = (fn: () => void) => () => {
      setPaletteOpen(false);
      fn();
    };
    return [
      {
        id: "new",
        group: "收藏",
        label: t("palette.cmdNew"),
        keywords: ["new", "create", "xinjian", "新建"],
        shortcut: "Ctrl+N",
        icon: <IconPlus size={15} />,
        run: closeThen(startNew),
      },
      {
        id: "clipboard-new",
        group: "收藏",
        label: t("palette.cmdClipboardNew"),
        keywords: ["clipboard", "paste", "剪贴板", "粘贴"],
        shortcut: formatHotkey(hotkeys.clipboard_new),
        icon: <IconClipboard size={15} />,
        run: closeThen(() => void newFromClipboard()),
      },
      {
        id: "import",
        group: "收藏",
        label: t("palette.cmdImport"),
        keywords: ["import", "json", "导入"],
        icon: <IconImport size={15} />,
        run: closeThen(() => void handleImportPick()),
      },
      {
        id: "export",
        group: "收藏",
        label: t("palette.cmdExport"),
        keywords: ["export", "json", "导出"],
        icon: <IconExport size={15} />,
        run: closeThen(() => void handleExport()),
      },
      {
        id: "trash",
        group: "收藏",
        label: trashOpen ? t("palette.cmdTrashBack") : t("palette.cmdTrashOpen"),
        keywords: ["trash", "recycle", "回收站", "返回"],
        icon: trashOpen ? <IconUndo size={15} /> : <IconTrash size={15} />,
        run: closeThen(toggleTrash),
      },
      {
        id: "theme",
        group: "视图",
        label: theme === "dark" ? t("palette.cmdThemeLight") : t("palette.cmdThemeDark"),
        keywords: ["theme", "dark", "light", "主题", "暗色", "亮色"],
        icon: theme === "dark" ? <IconSun size={15} /> : <IconMoon size={15} />,
        run: closeThen(toggleTheme),
      },
      {
        id: "sort-updated",
        group: "视图",
        label: t("palette.cmdSortUpdated"),
        keywords: ["sort", "updated", "排序", "更新"],
        checked: sortMode === "updated",
        run: closeThen(() => setSortMode("updated")),
      },
      {
        id: "sort-recent",
        group: "视图",
        label: t("palette.cmdSortRecent"),
        keywords: ["sort", "recent", "排序", "复制"],
        checked: sortMode === "recent",
        run: closeThen(() => setSortMode("recent")),
      },
      {
        id: "sort-most",
        group: "视图",
        label: t("palette.cmdSortMost"),
        keywords: ["sort", "most", "排序", "常用"],
        checked: sortMode === "most",
        run: closeThen(() => setSortMode("most")),
      },
      {
        id: "cheatsheet",
        group: "视图",
        label: t("palette.cmdCheatsheet"),
        keywords: ["shortcut", "keys", "快捷键", "帮助", "?"],
        shortcut: "?",
        icon: <IconSparkles size={15} />,
        run: closeThen(() => setCheatsheetOpen(true)),
      },
      {
        id: "settings",
        group: "应用",
        label: t("palette.cmdSettings"),
        keywords: ["settings", "hotkey", "设置", "热键"],
        hint: t("palette.cmdSettingsHint", { hotkey: formatHotkey(hotkeys.quickpick) }),
        icon: <IconSettings size={15} />,
        run: closeThen(() => setSettingsOpen(true)),
      },
      {
        id: "open-plugins",
        group: "应用",
        label: t("palette.cmdOpenPlugins"),
        keywords: ["plugins", "market", "plugin", "插件", "插件市场"],
        icon: <IconPlugin size={15} />,
        run: closeThen(() => switchPane("plugins")),
      },
    ];
  }, [
    trashOpen,
    theme,
    sortMode,
    hotkeys,
    t,
    startNew,
    newFromClipboard,
    handleImportPick,
    handleExport,
    toggleTrash,
    toggleTheme,
    setSortMode,
    switchPane,
  ]);

  /** 插件命令并入命令面板(group「插件」,恒加 plugin: 前缀防 id 冲突) */
  const pluginPaletteCommands = useMemo<PaletteCommand[]>(
    () =>
      pluginCmds.map((c) => ({
        ...c,
        group: "插件",
        icon: <IconPlugin size={15} />,
      })),
    [pluginCmds],
  );

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
          <div className="spinner" aria-label={t("common.loading")} />
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
            placeholder={t("header.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-controls="pv-list"
            aria-activedescendant={activeId ? `pv-row-${activeId}` : undefined}
          />
          {activeTag && !trashOpen && (
            <button
              className="tag-filter"
              title={t("header.clearTagFilter")}
              onClick={() => setActiveTag(null)}
            >
              #{activeTag}
              <IconX size={12} />
            </button>
          )}
        </div>
        <div className="header-actions">
          <button className="btn primary" onClick={startNew}>
            <IconPlus size={15} /> {t("header.new")}
          </button>
          <button
            className="btn"
            title={t("header.clipboardTip")}
            onClick={() => void newFromClipboard()}
          >
            <IconClipboard size={15} /> {t("header.clipboard")}
          </button>
          <button
            className={"btn" + (trashOpen ? " pressed" : "")}
            onClick={toggleTrash}
            title={t("header.trash")}
          >
            <IconTrash size={15} /> {t("header.trash")}
          </button>
          <button className="btn" onClick={() => void handleImportPick()}>
            <IconImport size={15} /> {t("header.import")}
          </button>
          <button className="btn" onClick={() => void handleExport()}>
            <IconExport size={15} /> {t("header.export")}
          </button>
          <button
            className="icon-btn"
            title={t("header.settingsTitle")}
            onClick={() => setSettingsOpen(true)}
          >
            <IconSettings size={16} />
          </button>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </div>
      </header>

      <div className="main">
        <nav className="pane-rail" aria-label={t("pane.railAria")}>
          <button
            className={"pane-tab" + (pane === "collection" ? " active" : "")}
            onClick={() => switchPane("collection")}
            title={t("pane.favorites")}
          >
            <IconSparkles size={16} />
            <span>{t("pane.favorites")}</span>
          </button>
          <button
            className={"pane-tab" + (pane === "plugins" ? " active" : "")}
            onClick={() => switchPane("plugins")}
            title={t("pane.plugins")}
          >
            <IconPlugin size={16} />
            <span>{t("pane.plugins")}</span>
          </button>
        </nav>
        {pane === "plugins" ? (
          <PluginHub
            showToast={showToast}
            onModalOpenChange={setPluginModalOpen}
            onCommandsChanged={refreshPluginCommands}
            activePanelFocus={panelFocus}
          />
        ) : (
          <>
            <Sidebar
              items={filtered}
              total={trashOpen ? trashItems.length : liveItems.length}
              trashOpen={trashOpen}
              sortMode={sortMode}
              onSortChange={setSortMode}
              selectedId={selectedId}
              selectedIds={selectedIds}
              onRowClick={handleRowClick}
              onRowFocus={handleRowFocus}
              onCheckbox={toggleSelected}
              onTagClick={handleTagClick}
              onQuickCopy={(it) => void handleCopy(it)}
              eggOpen={eggOpen}
              eggBody={EGG_BODY}
              onEggCopy={() => void handleEggCopy()}
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
            hasItems={trashOpen ? trashItems.length > 0 : liveItems.length > 0}
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
            onboarding={
              !trashOpen && !onboarded && liveItems.length === 0
                ? {
                    onSkip: markOnboarded,
                    onCreateFirst: startNew,
                    onCreateSample: handleCreateSample,
                  }
                : null
            }
          />
        )}
          </>
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
          title={t("confirm.purgeTitle")}
          message={t("confirm.purgeMessage", {
            name: purgeTarget.title || t("common.untitled"),
          })}
          confirmText={t("confirm.purgeTitle")}
          danger
          onConfirm={() => void handlePurge(purgeTarget)}
          onCancel={() => setPurgeTarget(null)}
        />
      )}
      {batchPurgeOpen && (
        <ConfirmModal
          title={t("confirm.purgeTitle")}
          message={t("confirm.batchPurgeMessage", { n: selectedIds.size })}
          confirmText={t("confirm.purgeTitle")}
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
          commands={[...paletteCommands, ...pluginPaletteCommands]}
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
