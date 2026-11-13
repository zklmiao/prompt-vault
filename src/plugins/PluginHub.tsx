// 插件区(PluginHub):已安装 / 插件源 / 市场三段管理界面。
// 样式走 App.css 的 CSS token;图标用 icons.tsx 内联 SVG;文案走 i18n(域 ph.*)。
// 弹层(Modal/ConfirmModal)沿用既有组件与守卫模式。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ConfirmModal from "../components/ConfirmModal";
import Modal from "../components/Modal";
import {
  IconMarket,
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

/** 仓库主页地址解析:github/gitee/gitlab 按域名自动识别,其余按 gitea 处理(可手动纠正) */
export function parseRepoHome(url: string): {
  provider: ProviderKind;
  owner: string;
  repo: string;
  host: string | null;
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
    return { provider, owner, repo, host };
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
        branch: source.branch,
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
          showToast(t("ph.toastInstalled", { name: marketEntry.name, version: ref.version }));
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
    [hooks, reloadState, showToast, t],
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
      branch: null,
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
      {state && state.sources.length > 0 ? (
        state.sources.map((s) => (
          <label className="ph-row source" key={s.id}>
            <input
              type="radio"
              name="active-source"
              checked={state.activeSourceId === s.id}
              onChange={() => void activateSource(s.id)}
              title={t("ph.setActiveSource")}
            />
            <div className="ph-row-main">
              <div className="ph-row-title">{s.name}</div>
              <div className="ph-row-sub">
                {s.url}
                {s.branch ? t("ph.sourceBranchSuffix", { branch: s.branch }) : ""}
              </div>
            </div>
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
          <span>
            {t("ph.marketSource", { name: market?.name || activeSource.name })}
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
      <div className="ph-row-main">
        <div className="ph-row-title">
          {entry.name}
          {installed ? (
            <span className="badge ok">{t("ph.installedVersion", { version: installed.version })}</span>
          ) : null}
        </div>
        <div className="ph-row-sub">{entry.desc || entry.id}</div>
        {entry.minAppVersion ? (
          <div className="ph-row-sub muted">{t("ph.reqAppVersion", { version: entry.minAppVersion })}</div>
        ) : null}
      </div>
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
          className="btn small primary"
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
