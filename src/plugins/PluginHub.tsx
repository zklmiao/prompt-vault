// 插件区(PluginHub):已安装 / 插件源 / 市场三段管理界面。
// 样式走 App.css 的 CSS token;图标用 icons.tsx 内联 SVG;文案走 i18n(域 ph.*)。
// 弹层(Modal/ConfirmModal)沿用既有组件与守卫模式。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { appExePath, copyToClipboard } from "../api";
import ConfirmModal from "../components/ConfirmModal";
import Modal from "../components/Modal";
import {
  IconCopy,
  IconMarket,
  IconMcp,
  IconPlugin,
  IconRefresh,
  IconTrash,
  IconWindow,
} from "../components/icons";
import {
  fetchSource,
  installPlugin,
  pluginCloseWindow,
  pluginInstalledManifest,
  pluginOpenWindow,
  uninstallPlugin,
} from "./api";
import { injectAfterEnable, loadPluginsState, savePluginsState } from "./host";
import type { HostHooks } from "./host";
import { useI18n } from "../i18n";
import { getPanel, getWindowSetup, registeredPanels } from "./registry";
import { isNewerVersion } from "./semver";
import type {
  ChannelRef,
  InstalledEntry,
  MarketEntry,
  PluginManifest,
  PluginsState,
  ProviderKind,
  SourceConfig,
  SourceManifest,
} from "./types";

type Section = "installed" | "sources" | "market" | `panel:${string}`;
type Channel = "release" | "beta";

/** 更新完成后延迟 reload:让结果 toast 完整可读(宿主 toast 2200ms 自动消失) */
const UPDATE_RELOAD_DELAY_MS = 1500;

/** 仓库主页地址解析:github/gitee/gitlab 按域名自动识别,其余按 gitea 处理(可手动纠正) */
export function parseRepoHome(url: string): {
  provider: ProviderKind;
  owner: string;
  repo: string;
  host: string | null;
  /** #分支 后缀(D4);缺省 null → Rust 走 main→master 默认分支探测 */
  branch: string | null;
} | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length < 2) return null;
    const [owner, repoRaw] = segs;
    const repo = repoRaw.replace(/\.git$/i, "");
    if (owner === "" || repo === "") return null;
    let provider: ProviderKind;
    if (u.hostname === "github.com") provider = "github";
    else if (u.hostname === "gitee.com") provider = "gitee";
    else if (u.hostname === "gitlab.com") provider = "gitlab";
    else provider = "gitea";
    // gitea 主机带 scheme 前缀(Rust 侧跟随主页地址推导 raw URL 的 scheme)
    const host =
      provider === "gitea"
        ? (u.protocol === "http:" ? "http://" : "") +
          u.hostname +
          (u.port ? `:${u.port}` : "")
        : null;
    // #分支 后缀(D4):fragment 即分支名,trim 后透传(Rust validate_git_ref 兜底校验)
    const branch =
      u.hash && u.hash.length > 1
        ? decodeURIComponent(u.hash.slice(1)).trim() || null
        : null;
    return { provider, owner, repo, host, branch };
  } catch {
    return null;
  }
}

interface Props {
  showToast(text: string, kind?: "ok" | "err"): void;
  /** 权限确认/卸载确认弹层开关,供 App 的弹层守卫 */
  onModalOpenChange(open: boolean): void;
  onCommandsChanged(): void;
  /** 球窗「打开详情面板」跨窗口激活信号(seq 变化即切到对应面板页签) */
  activePanelFocus?: { id: string; seq: number } | null;
}

export default function PluginHub({
  showToast,
  onModalOpenChange,
  onCommandsChanged,
  activePanelFocus,
}: Props) {
  const { t } = useI18n();
  const [state, setState] = useState<PluginsState | null>(null);
  const [manifests, setManifests] = useState<Record<string, PluginManifest | null>>({});
  const [market, setMarket] = useState<SourceManifest | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [section, setSection] = useState<Section>("installed");
  /** 注入完成后(宿主重渲染)读取已注册面板,生成插件面板页签 */
  const panels = registeredPanels();
  const [uninstallTarget, setUninstallTarget] = useState<string | null>(null);
  const [installCandidate, setInstallCandidate] = useState<{
    entry: MarketEntry;
    channel: Channel;
  } | null>(null);
  const [addUrl, setAddUrl] = useState("");
  const [addProvider, setAddProvider] = useState<"auto" | ProviderKind>("auto");
  const [busy, setBusy] = useState(false);
  /** 市场清单对应的源 id;激活源变化时触发重新拉取 */
  const [marketForSource, setMarketForSource] = useState<string | null>(null);

  const hooks = useMemo<HostHooks>(
    () => ({ showToast, onCommandsChanged, t }),
    [showToast, onCommandsChanged, t],
  );

  const channelLabel = useCallback(
    (channel: Channel): string => t(channel === "release" ? "ph.channelRelease" : "ph.channelBeta"),
    [t],
  );

  /** 源行的平台徽标文案(ProviderKind 已在添加时定形,无 auto) */
  const providerLabel = useCallback(
    (provider: ProviderKind): string =>
      provider === "gitea" ? t("ph.providerGitea") : provider.charAt(0).toUpperCase() + provider.slice(1),
    [t],
  );

  /** 权限串的中文说明(未知形状原样展示) */
  const permissionHint = useCallback(
    (p: string): string => {
      if (p === "window:float") return t("ph.permFloat");
      if (p.startsWith("net:")) return t("ph.permNet", { host: p.slice(4) });
      if (p.startsWith("credential:")) return t("ph.permCredential", { scope: p.slice(11) });
      return t("ph.permOther");
    },
    [t],
  );

  const refreshManifests = useCallback(async (st: PluginsState) => {
    const ids = Object.keys(st.installed);
    const results = await Promise.all(
      ids.map((id) => pluginInstalledManifest(id).catch(() => null)),
    );
    const map: Record<string, PluginManifest | null> = {};
    ids.forEach((id, i) => {
      map[id] = results[i];
    });
    setManifests(map);
  }, []);

  const reloadState = useCallback(async (): Promise<PluginsState> => {
    const st = await loadPluginsState();
    setState(st);
    void refreshManifests(st);
    return st;
  }, [refreshManifests]);

  useEffect(() => {
    reloadState().catch((e) =>
      showToast(t("ph.toastStateReadFailed", { msg: String(e) }), "err"),
    );
  }, [reloadState, showToast, t]);

  // 弹层守卫上报(沿用 modalOpen 模式)
  useEffect(() => {
    onModalOpenChange(!!(installCandidate || uninstallTarget));
  }, [installCandidate, uninstallTarget, onModalOpenChange]);

  // 跨窗口面板激活:球窗 pv.window.openPanel → pv-open-plugin-panel → 此处切页签
  useEffect(() => {
    if (!activePanelFocus) return;
    setSection(`panel:${activePanelFocus.id}`);
  }, [activePanelFocus]);

  const activeSource = useMemo(
    () => state?.sources.find((s) => s.id === state.activeSourceId) ?? null,
    [state],
  );

  const loadMarket = useCallback(async (source: SourceConfig | null) => {
    if (!source) {
      setMarket(null);
      setMarketError(t("ph.noActiveSource"));
      return;
    }
    const parsed = parseRepoHome(source.url);
    if (!parsed) {
      setMarket(null);
      setMarketError(t("ph.badSourceUrl"));
      return;
    }
    setMarketLoading(true);
    setMarketError(null);
    try {
      const m = await fetchSource({
        provider: parsed.provider,
        owner: parsed.owner,
        repo: parsed.repo,
        branch: parsed.branch ?? source.branch,
        host: parsed.host,
      });
      setMarket(m);
    } catch (e) {
      setMarket(null);
      setMarketError(e instanceof Error ? e.message : String(e));
    } finally {
      setMarketLoading(false);
    }
  }, [t]);

  useEffect(() => {
    const sid = state?.activeSourceId ?? null;
    if (sid !== null && sid !== marketForSource) {
      const src = state?.sources.find((s) => s.id === sid) ?? null;
      setMarketForSource(sid);
      void loadMarket(src);
    }
  }, [state, marketForSource, loadMarket]);

  /** 深拷贝变更后落盘(契约字段完整性由 Rust 写端校验兜底) */
  const mutateState = useCallback(
    async (fn: (st: PluginsState) => void): Promise<PluginsState | null> => {
      if (!state) return null;
      const next: PluginsState = JSON.parse(JSON.stringify(state));
      fn(next);
      try {
        await savePluginsState(next);
        setState(next);
        return next;
      } catch (e) {
        showToast(t("ph.toastStateSaveFailed", { msg: String(e) }), "err");
        return null;
      }
    },
    [state, showToast, t],
  );

  /* ---------- 已安装区动作 ---------- */

  const toggleEnabled = useCallback(
    async (id: string) => {
      const entry = state?.installed[id];
      if (!entry) return;
      if (entry.enabled) {
        // 停用:先落盘 plugins.json,再关闭插件窗口并 reload 重载宿主
        const next = await mutateState((st) => {
          st.installed[id] = { ...st.installed[id], enabled: false };
        });
        if (!next) return;
        await pluginCloseWindow(id).catch(() => {});
        window.location.reload();
      } else {
        // 启用:落盘后立即注入(即插即用);注入失败会写回 error,重读反映错误态
        const next = await mutateState((st) => {
          st.installed[id] = { ...st.installed[id], enabled: true, error: null };
        });
        if (!next) return;
        await injectAfterEnable(id, hooks);
        await reloadState();
      }
    },
    [state, mutateState, hooks],
  );

  const doInstall = useCallback(
    async (marketEntry: MarketEntry, channel: Channel) => {
      const ref: ChannelRef | null = marketEntry[channel];
      if (!ref) return;
      // 更新判定:安装前 installed 里已存在该 id 即为更新(而非首装)
      const isUpdate = !!state?.installed[marketEntry.id];
      setBusy(true);
      try {
        await installPlugin({
          url: ref.url,
          sha256: ref.sha256,
          channel,
          expectId: marketEntry.id,
          expectVersion: ref.version,
        });
        const st = await reloadState();
        if (st?.installed[marketEntry.id]?.enabled) {
          // 即插即用:安装完成后立即注入,不 reload
          await injectAfterEnable(marketEntry.id, hooks);
          // 注入失败时错误会写回 plugins.json,重读以反映错误态
          await reloadState();
          if (isUpdate) {
            // 更新场景:主窗注入代码是安装时快照,延迟 reload 换新(先让 toast 读完整);
            // 球窗(ui:"window")是独立常驻 webview,主窗 reload 热换不到,只能重启生效
            // —— toast 改提示重启(Rust 侧已开窗只会 show+focus,不重复开窗)
            const mf = await pluginInstalledManifest(marketEntry.id).catch(() => null);
            if (mf?.ui === "window") {
              showToast(t("ph.toastUpdatedRestart", { version: ref.version }));
            } else {
              showToast(t("ph.toastInstalled", { name: marketEntry.name, version: ref.version }));
            }
            window.setTimeout(() => window.location.reload(), UPDATE_RELOAD_DELAY_MS);
          } else {
            showToast(t("ph.toastInstalled", { name: marketEntry.name, version: ref.version }));
          }
        } else {
          showToast(
            t("ph.toastInstalledDisabled", { name: marketEntry.name, version: ref.version }),
          );
        }
      } catch (e) {
        showToast(
          t("ph.toastInstallFailed", { msg: e instanceof Error ? e.message : String(e) }),
          "err",
        );
      } finally {
        setBusy(false);
      }
    },
    [hooks, reloadState, showToast, state, t],
  );

  const doUninstall = useCallback(
    async (id: string) => {
      setUninstallTarget(null);
      await pluginCloseWindow(id).catch(() => {});
      try {
        await uninstallPlugin(id);
        showToast(t("ph.toastUninstalled"));
        // 注入的脚本无法在运行中卸载:落盘完成后 reload 重载宿主
        window.location.reload();
      } catch (e) {
        showToast(t("ph.toastUninstallFailed", { msg: String(e) }), "err");
      }
    },
    [showToast, t],
  );

  const openPluginWindow = useCallback(
    (id: string) => {
      const size = getWindowSetup(id)?.size;
      pluginOpenWindow(id, size).catch((e) =>
        showToast(t("ph.toastOpenWindowFailed", { msg: String(e) }), "err"),
      );
    },
    [showToast, t],
  );

  /* ---------- 插件源动作 ---------- */

  const handleAddSource = useCallback(async () => {
    const parsed = parseRepoHome(addUrl);
    if (!parsed) {
      showToast(t("ph.toastBadRepoUrl"), "err");
      return;
    }
    const provider: ProviderKind = addProvider === "auto" ? parsed.provider : addProvider;
    const source: SourceConfig = {
      id: `src-${crypto.randomUUID().slice(0, 8)}`,
      name: `${parsed.owner}/${parsed.repo}`,
      provider,
      url: addUrl.trim(),
      branch: parsed.branch,
    };
    const next = await mutateState((st) => {
      st.sources = [...st.sources, source];
      // 首个源自动激活
      if (!st.activeSourceId) st.activeSourceId = source.id;
    });
    if (next) {
      setAddUrl("");
      setAddProvider("auto");
      showToast(t("ph.toastSourceAdded", { name: source.name }));
    }
  }, [addUrl, addProvider, mutateState, showToast, t]);

  const activateSource = useCallback(
    async (id: string) => {
      setMarketForSource(null); // 允许重新激活同一源时重新拉取
      await mutateState((st) => {
        st.activeSourceId = id;
      });
    },
    [mutateState],
  );

  /** 删除插件源:删除的是激活源时切到剩余首个(没有则清空),市场跟随自动重载 */
  const handleDeleteSource = useCallback(
    async (id: string) => {
      const wasActive = state?.activeSourceId === id;
      const source = state?.sources.find((s) => s.id === id);
      const next = await mutateState((st) => {
        st.sources = st.sources.filter((s) => s.id !== id);
        if (st.activeSourceId === id) {
          st.activeSourceId = st.sources[0]?.id ?? null;
        }
      });
      if (next && source) {
        if (wasActive) setMarketForSource(null);
        showToast(t("ph.toastSourceDeleted", { name: source.name }));
      }
    },
    [state, mutateState, showToast, t],
  );

  /* ---------- MCP Server 固定卡片 ---------- */

  /** MCP 开关:落盘后重读为准(不做乐观更新);失败 toast err 并回读复位开关 */
  const toggleMcp = useCallback(async () => {
    if (!state) return;
    const next: PluginsState = JSON.parse(JSON.stringify(state));
    next.mcp = { enabled: !next.mcp.enabled };
    try {
      await savePluginsState(next);
      await reloadState();
      showToast(t("mcp.toastSaved"));
    } catch (e) {
      showToast(
        t("mcp.toastSaveFailed", { msg: e instanceof Error ? e.message : String(e) }),
        "err",
      );
      // 落盘失败:重读磁盘状态,开关复位到真实值
      await reloadState().catch(() => {});
    }
  }, [state, reloadState, showToast, t]);

  /* ---------- 渲染 ---------- */

  const installedRows = useMemo(() => {
    if (!state) return [];
    return Object.entries(state.installed)
      .map(([id, entry]) => ({ id, entry, manifest: manifests[id] ?? null }))
      .sort((a, b) => (b.entry.installedAt || "").localeCompare(a.entry.installedAt || ""));
  }, [state, manifests]);

  const marketEntryFor = useCallback(
    (id: string): MarketEntry | null =>
      market?.plugins.find((p) => p.id === id) ?? null,
    [market],
  );

  const renderInstalled = () => (
    <div className="ph-list">
      <McpCard
        enabled={state?.mcp.enabled ?? false}
        onToggle={() => void toggleMcp()}
        showToast={showToast}
      />
      {installedRows.length === 0 ? (
        <div className="ph-empty">{t("ph.emptyInstalled")}</div>
      ) : (
        installedRows.map(({ id, entry, manifest }) => {
          const me = marketEntryFor(id);
          const ref = me ? me[entry.channel] : null;
          const updateAvailable = !!(ref && isNewerVersion(ref.version, entry.version));
          const isWindow = manifest?.ui === "window";
          return (
            <div className="ph-row" key={id}>
              <div className="ph-row-main">
                <div className="ph-row-title">
                  {manifest?.name ?? id}
                  <span className="badge">{channelLabel(entry.channel)}</span>
                  {entry.error ? <span className="badge danger">{t("ph.badgeError")}</span> : null}
                </div>
                <div className="ph-row-sub">
                  {entry.version} · {id}
                  {manifest?.type === "i18n" ? t("ph.i18nSuffix") : ""}
                </div>
                {entry.error ? (
                  <div className="ph-row-error" title={entry.error}>
                    {entry.error}
                  </div>
                ) : null}
              </div>
              <div className="ph-row-actions">
                {updateAvailable && ref ? (
                  <button
                    className="btn small"
                    disabled={busy}
                    title={t("ph.updateTitle", {
                      version: ref.version,
                      channel: channelLabel(entry.channel),
                    })}
                    onClick={() => void doInstall(me!, entry.channel)}
                  >
                    {t("ph.update", { version: ref.version })}
                  </button>
                ) : null}
                {isWindow && entry.enabled ? (
                  <button
                    className="icon-btn"
                    title={t("ph.openWindow")}
                    onClick={() => openPluginWindow(id)}
                  >
                    <IconWindow size={16} />
                  </button>
                ) : null}
                {panels.some((p) => p.pluginId === id) ? (
                  <button
                    className="icon-btn"
                    title={t("ph.openPanel")}
                    onClick={() => setSection(`panel:${id}`)}
                  >
                    <IconPlugin size={16} />
                  </button>
                ) : null}
                <label className="switch" title={entry.enabled ? t("ph.toggleDisable") : t("ph.toggleEnable")}>
                  <input
                    type="checkbox"
                    checked={entry.enabled}
                    onChange={() => void toggleEnabled(id)}
                  />
                  <span />
                </label>
                <button
                  className="icon-btn"
                  title={t("ph.uninstall")}
                  onClick={() => setUninstallTarget(id)}
                >
                  <IconTrash size={15} />
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );

  const renderSources = () => (
    <div className="ph-list">
      <div className="ph-add-card">
        <div className="ph-add-title">{t("ph.addSourceTitle")}</div>
        <div className="ph-add-hint">{t("ph.addSourceHint")}</div>
        <div className="ph-form">
          <input
            className="input"
            placeholder={t("ph.urlPlaceholder")}
            value={addUrl}
            onChange={(e) => setAddUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                void handleAddSource();
              }
            }}
          />
          <select
            className="input select"
            value={addProvider}
            onChange={(e) => setAddProvider(e.target.value as "auto" | ProviderKind)}
            title={t("ph.providerTitle")}
          >
            <option value="auto">{t("ph.providerAuto")}</option>
            <option value="github">GitHub</option>
            <option value="gitee">Gitee</option>
            <option value="gitlab">GitLab</option>
            <option value="gitea">{t("ph.providerGitea")}</option>
          </select>
          <button
            className="btn primary"
            disabled={addUrl.trim() === ""}
            onClick={() => void handleAddSource()}
          >
            {t("ph.addSource")}
          </button>
        </div>
      </div>
      {state && state.sources.length > 0 ? (
        state.sources.map((s) => (
          <label
            className={"ph-row source" + (state.activeSourceId === s.id ? " active" : "")}
            key={s.id}
          >
            <input
              type="radio"
              name="active-source"
              checked={state.activeSourceId === s.id}
              onChange={() => void activateSource(s.id)}
              title={t("ph.setActiveSource")}
            />
            <div className="ph-row-main">
              <div className="ph-row-title">
                {s.name}
                <span className="badge">{providerLabel(s.provider)}</span>
                {state.activeSourceId === s.id ? (
                  <span className="badge ok">{t("ph.activeSourceBadge")}</span>
                ) : null}
              </div>
              <div className="ph-row-sub">
                {s.url}
                {s.branch ? t("ph.sourceBranchSuffix", { branch: s.branch }) : ""}
              </div>
            </div>
            <button
              type="button"
              className="ph-row-del"
              title={t("ph.deleteSource")}
              aria-label={t("ph.deleteSource")}
              onClick={(e) => {
                // 行是 label:点击会转发给 radio 触发激活,preventDefault 阻断
                e.preventDefault();
                e.stopPropagation();
                void handleDeleteSource(s.id);
              }}
            >
              <IconTrash size={14} />
            </button>
          </label>
        ))
      ) : (
        <div className="ph-empty">{t("ph.emptySources")}</div>
      )}
    </div>
  );

  const renderMarket = () => {
    if (!activeSource) {
      return (
        <div className="ph-empty">{t("ph.noActiveSourceHint")}</div>
      );
    }
    return (
      <div className="ph-list">
        <div className="ph-market-head">
          <span className="ph-market-source">
            {t("ph.marketSourcePrefix")}
            <span className="ph-market-name">{market?.name || activeSource.name}</span>
            {marketLoading ? t("ph.fetchingSuffix") : ""}
          </span>
          <button
            className="btn small"
            onClick={() => void loadMarket(activeSource)}
            disabled={marketLoading}
          >
            <IconRefresh size={14} /> {t("ph.refresh")}
          </button>
        </div>
        {marketError ? <div className="ph-row-error">{marketError}</div> : null}
        {market && market.plugins.length === 0 ? (
          <div className="ph-empty">{t("ph.emptyMarket")}</div>
        ) : null}
        {market?.plugins.map((p) => (
          <MarketRow
            key={p.id}
            entry={p}
            installed={state?.installed[p.id]}
            busy={busy}
            onPick={(channel) => setInstallCandidate({ entry: p, channel })}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="plugin-hub">
      <div className="ph-head">
        <div className="ph-title">
          <IconPlugin size={16} /> {t("ph.title")}
        </div>
        <div className="ph-sections">
          <button
            className={"ph-seg" + (section === "installed" ? " active" : "")}
            onClick={() => setSection("installed")}
          >
            {t("ph.tabInstalled", { n: installedRows.length })}
          </button>
          <button
            className={"ph-seg" + (section === "sources" ? " active" : "")}
            onClick={() => setSection("sources")}
          >
            {t("ph.tabSources", { n: state?.sources.length ?? 0 })}
          </button>
          <button
            className={"ph-seg" + (section === "market" ? " active" : "")}
            onClick={() => setSection("market")}
          >
            <IconMarket size={14} /> {t("ph.tabMarket")}
          </button>
        </div>
      </div>
      <div className="ph-body">
        {section === "installed" ? renderInstalled() : null}
        {section === "sources" ? renderSources() : null}
        {section === "market" ? renderMarket() : null}
        {section.startsWith("panel:") ? (
          <PanelHost pluginId={section.slice("panel:".length)} />
        ) : null}
      </div>

      {installCandidate ? (
        <Modal title={t("ph.installModalTitle")} onCancel={() => setInstallCandidate(null)}>
          <p className="modal-message">
            {t("ph.installPermRequest", {
              name: installCandidate.entry.name,
              version: installCandidate.entry[installCandidate.channel]?.version ?? "",
              channel: channelLabel(installCandidate.channel),
            })}
          </p>
          <ul className="perm-list">
            {installCandidate.entry.permissions.map((p) => (
              <li key={p}>
                <code>{p}</code>
                <span className="perm-hint">{permissionHint(p)}</span>
              </li>
            ))}
          </ul>
          {installCandidate.entry.permissions.length === 0 ? (
            <p className="muted">{t("ph.noPermissions")}</p>
          ) : null}
          <div className="modal-actions">
            <button className="btn" onClick={() => setInstallCandidate(null)}>
              {t("common.cancel")}
            </button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => {
                const { entry, channel } = installCandidate;
                setInstallCandidate(null);
                void doInstall(entry, channel);
              }}
            >
              {t("ph.agreeInstall")}
            </button>
          </div>
        </Modal>
      ) : null}

      {uninstallTarget ? (
        <ConfirmModal
          title={t("ph.uninstallModalTitle")}
          message={t("ph.uninstallConfirm", {
            name: manifests[uninstallTarget]?.name ?? uninstallTarget,
          })}
          confirmText={t("ph.uninstall")}
          danger
          onConfirm={() => void doUninstall(uninstallTarget)}
          onCancel={() => setUninstallTarget(null)}
        />
      ) : null}
    </div>
  );
}

/* ---------- 市场行(通道选择 + 安装/已安装态) ---------- */

function MarketRow({
  entry,
  installed,
  busy,
  onPick,
}: {
  entry: MarketEntry;
  installed: InstalledEntry | undefined;
  busy: boolean;
  onPick(channel: Channel): void;
}) {
  const { t } = useI18n();
  const channelLabel = (channel: Channel): string =>
    t(channel === "release" ? "ph.channelRelease" : "ph.channelBeta");
  const [channel, setChannel] = useState<Channel>(
    entry.release ? "release" : "beta",
  );
  const ref = entry[channel];
  const installedCurrent = !!(installed && ref && installed.version === ref.version);
  return (
    <div className="ph-row market">
      <div className="ph-market-icon">
        <IconPlugin size={18} />
      </div>
      <div className="ph-row-main">
        <div className="ph-row-title">
          {entry.name}
          {installed ? (
            <span className="badge ok">{t("ph.installedVersion", { version: installed.version })}</span>
          ) : null}
        </div>
        <div className="ph-row-desc">{entry.desc || entry.id}</div>
        <div className="ph-market-foot">
          <span className="ph-row-sub muted">
            {entry.minAppVersion ? t("ph.reqAppVersion", { version: entry.minAppVersion }) : ""}
          </span>
          <div className="ph-row-actions">
            <select
              className="input select small"
              value={channel}
              onChange={(e) => setChannel(e.target.value as Channel)}
              title={t("ph.chooseChannel")}
            >
              {entry.release ? (
                <option value="release">
                  {channelLabel("release")} {entry.release.version}
                </option>
              ) : null}
              {entry.beta ? (
                <option value="beta">
                  {channelLabel("beta")} {entry.beta.version}
                </option>
              ) : null}
            </select>
            <button
              className={"btn small" + (installedCurrent || !ref ? "" : " primary")}
              disabled={busy || !ref || installedCurrent}
              onClick={() => onPick(channel)}
            >
              {installedCurrent
                ? t("ph.upToDate")
                : ref
                  ? t("ph.installVersion", { version: ref.version })
                  : t("ph.noPackage")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- MCP Server 固定卡片(批次 4;内置能力非插件,无卸载/通道) ---------- */

type McpTab = "claude" | "codex" | "opencode" | "mcpjson";

const MCP_TABS: Array<{ id: McpTab; labelKey: string }> = [
  { id: "claude", labelKey: "mcp.tabClaudeCode" },
  { id: "codex", labelKey: "mcp.tabCodex" },
  { id: "opencode", labelKey: "mcp.tabOpencode" },
  { id: "mcpjson", labelKey: "mcp.tabMcpJson" },
];

/**
 * 四页签配置片段(代码组装,exe 插值;文案不进 i18n —— 各客户端片段与
 * 界面语言无关,进语言包纯属膨胀)。
 * 引号规则:命令行(Claude Code)路径含空格才用双引号包裹;JSON 由
 * JSON.stringify 处理引号与转义;TOML 基本字符串中反斜杠是转义符,
 * Windows 路径需逐个翻倍,否则 "\U" 会被当成 unicode 转义导致配置非法。
 * OpenCode 层级按官方文档(2026-11-14 核实)为 mcp.servers.<name>。
 */
export function buildMcpSnippets(exePath: string): Record<McpTab, string> {
  const commandLine = exePath.includes(" ") ? `"${exePath}"` : exePath;
  const tomlString = `"${exePath.replace(/\\/g, "\\\\")}"`;
  return {
    claude: `claude mcp add prompt-vault -- ${commandLine} --mcp`,
    codex: `[mcp_servers.prompt-vault]\ncommand = ${tomlString}\nargs = ["--mcp"]`,
    opencode: JSON.stringify(
      {
        mcp: {
          servers: {
            "prompt-vault": { type: "local", command: [exePath, "--mcp"] },
          },
        },
      },
      null,
      2,
    ),
    mcpjson: JSON.stringify(
      {
        mcpServers: { "prompt-vault": { command: exePath, args: ["--mcp"] } },
      },
      null,
      2,
    ),
  };
}

function McpCard({
  enabled,
  onToggle,
  showToast,
}: {
  enabled: boolean;
  onToggle(): void;
  showToast(text: string, kind?: "ok" | "err"): void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<McpTab>("claude");
  const [exePath, setExePath] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    appExePath()
      .then((p) => {
        if (alive) setExePath(p);
      })
      .catch(() => {
        if (alive) setExePath(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const snippet = exePath ? buildMcpSnippets(exePath)[tab] : null;

  const copySnippet = useCallback(async () => {
    if (!snippet) return;
    try {
      await copyToClipboard(snippet);
      showToast(t("toast.copied"));
    } catch (e) {
      showToast(t("toast.copyFailed", { msg: String(e) }), "err");
    }
  }, [snippet, showToast, t]);

  return (
    <div className="ph-mcp-card">
      <div className="ph-mcp-head">
        <div className="ph-row-title">
          <IconMcp size={16} />
          {t("mcp.title")}
          <span className="badge">{t("mcp.badgeBuiltIn")}</span>
          <span className={"badge" + (enabled ? " ok" : "")}>
            {enabled ? t("mcp.statusOn") : t("mcp.statusOff")}
          </span>
        </div>
        <label
          className="switch"
          title={enabled ? t("ph.toggleDisable") : t("ph.toggleEnable")}
        >
          <input type="checkbox" checked={enabled} onChange={onToggle} />
          <span />
        </label>
      </div>
      {/* 风险明示:常驻不折叠 */}
      <div className="ph-mcp-risk">{t("mcp.riskNotice")}</div>
      <div className="ph-mcp-tabs" role="tablist">
        {MCP_TABS.map(({ id, labelKey }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={"ph-seg" + (tab === id ? " active" : "")}
            onClick={() => setTab(id)}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>
      {snippet !== null ? (
        <>
          <pre className="ph-mcp-code mono">{snippet}</pre>
          <div className="ph-mcp-actions">
            <button className="btn small" onClick={() => void copySnippet()}>
              <IconCopy size={14} /> {t("common.copy")}
            </button>
          </div>
        </>
      ) : (
        <div className="ph-empty">{t("mcp.exeUnavailable")}</div>
      )}
      <div className="ph-mcp-tools">
        <div className="ph-mcp-tools-title">{t("mcp.toolsTitle")}</div>
        <ul>
          <li>{t("mcp.toolSearch")}</li>
          <li>{t("mcp.toolGet")}</li>
          <li>{t("mcp.toolList")}</li>
          <li>{t("mcp.toolSave")}</li>
          <li>{t("mcp.templateNote")}</li>
        </ul>
      </div>
    </div>
  );
}

/* ---------- 插件面板宿主(ui:"panel" 插件的渲染容器) ---------- */

function PanelHost({ pluginId }: { pluginId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const def = getPanel(pluginId);
    if (def && ref.current) {
      def.render(ref.current);
    }
  }, [pluginId]);
  return <div className="ph-panel-host" ref={ref} />;
}
