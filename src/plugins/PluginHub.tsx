// 插件区(PluginHub):已安装 / 插件源 / 市场三段管理界面。
// 全部中文文案;样式走 App.css 的 CSS token;图标用 icons.tsx 内联 SVG。
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

const CHANNEL_LABELS: Record<Channel, string> = {
  release: "正式版",
  beta: "测试版",
};

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

/** 权限串的中文说明(未知形状原样展示) */
function permissionHint(p: string): string {
  if (p === "window:float") return "创建桌面悬浮窗";
  if (p.startsWith("net:")) return `联网请求(仅限 ${p.slice(4)})`;
  if (p.startsWith("credential:")) return `使用已录入的 ${p.slice(11)} 凭据发起请求`;
  return "其他权限";
}

interface Props {
  showToast(text: string, kind?: "ok" | "err"): void;
  /** 权限确认/卸载确认弹层开关,供 App 的弹层守卫 */
  onModalOpenChange(open: boolean): void;
  onCommandsChanged(): void;
}

export default function PluginHub({
  showToast,
  onModalOpenChange,
  onCommandsChanged,
}: Props) {
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
    () => ({ showToast, onCommandsChanged }),
    [showToast, onCommandsChanged],
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
      showToast(`插件状态读取失败:${String(e)}`, "err"),
    );
  }, [reloadState, showToast]);

  // 弹层守卫上报(沿用 modalOpen 模式)
  useEffect(() => {
    onModalOpenChange(!!(installCandidate || uninstallTarget));
  }, [installCandidate, uninstallTarget, onModalOpenChange]);

  const activeSource = useMemo(
    () => state?.sources.find((s) => s.id === state.activeSourceId) ?? null,
    [state],
  );

  const loadMarket = useCallback(async (source: SourceConfig | null) => {
    if (!source) {
      setMarket(null);
      setMarketError("尚未激活插件源:请先在「插件源」中添加并激活一个源");
      return;
    }
    const parsed = parseRepoHome(source.url);
    if (!parsed) {
      setMarket(null);
      setMarketError("插件源地址无法解析,应为仓库主页地址");
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
  }, []);

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
        showToast(`插件状态保存失败:${String(e)}`, "err");
        return null;
      }
    },
    [state, showToast],
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
          showToast(`已安装 ${marketEntry.name} ${ref.version}`);
        } else {
          showToast(`已安装 ${marketEntry.name} ${ref.version}(保持停用)`);
        }
      } catch (e) {
        showToast(`安装失败:${e instanceof Error ? e.message : String(e)}`, "err");
      } finally {
        setBusy(false);
      }
    },
    [hooks, reloadState, showToast],
  );

  const doUninstall = useCallback(
    async (id: string) => {
      setUninstallTarget(null);
      await pluginCloseWindow(id).catch(() => {});
      try {
        await uninstallPlugin(id);
        showToast("已卸载插件");
        // 注入的脚本无法在运行中卸载:落盘完成后 reload 重载宿主
        window.location.reload();
      } catch (e) {
        showToast(`卸载失败:${String(e)}`, "err");
      }
    },
    [showToast],
  );

  const openPluginWindow = useCallback(
    (id: string) => {
      const size = getWindowSetup(id)?.size;
      pluginOpenWindow(id, size).catch((e) =>
        showToast(`打开插件窗口失败:${String(e)}`, "err"),
      );
    },
    [showToast],
  );

  /* ---------- 插件源动作 ---------- */

  const handleAddSource = useCallback(async () => {
    const parsed = parseRepoHome(addUrl);
    if (!parsed) {
      showToast("无法解析仓库地址,请填写仓库主页 URL", "err");
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
      showToast(`已添加插件源 ${source.name}`);
    }
  }, [addUrl, addProvider, mutateState, showToast]);

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
        <div className="ph-empty">还没有已安装的插件,去「市场」看看。</div>
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
                  <span className="badge">{CHANNEL_LABELS[entry.channel]}</span>
                  {entry.error ? <span className="badge danger">异常</span> : null}
                </div>
                <div className="ph-row-sub">
                  {entry.version} · {id}
                  {manifest?.type === "i18n" ? " · 语言包" : ""}
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
                    title={`更新到 ${ref.version}(${CHANNEL_LABELS[entry.channel]})`}
                    onClick={() => void doInstall(me!, entry.channel)}
                  >
                    更新 {ref.version}
                  </button>
                ) : null}
                {isWindow && entry.enabled ? (
                  <button
                    className="icon-btn"
                    title="打开插件窗口"
                    onClick={() => openPluginWindow(id)}
                  >
                    <IconWindow size={16} />
                  </button>
                ) : null}
                <label className="switch" title={entry.enabled ? "停用" : "启用"}>
                  <input
                    type="checkbox"
                    checked={entry.enabled}
                    onChange={() => void toggleEnabled(id)}
                  />
                  <span />
                </label>
                <button
                  className="icon-btn"
                  title="卸载"
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
          placeholder="仓库主页地址,如 https://github.com/owner/repo"
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
          title="平台类型;非 GitHub/Gitee/GitLab 官方域名的仓库请手动选择"
        >
          <option value="auto">自动识别</option>
          <option value="github">GitHub</option>
          <option value="gitee">Gitee</option>
          <option value="gitlab">GitLab</option>
          <option value="gitea">Gitea(自建)</option>
        </select>
        <button
          className="btn primary"
          disabled={addUrl.trim() === ""}
          onClick={() => void handleAddSource()}
        >
          添加
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
              title="设为生效源(同一时刻仅一个生效)"
            />
            <div className="ph-row-main">
              <div className="ph-row-title">{s.name}</div>
              <div className="ph-row-sub">
                {s.url}
                {s.branch ? ` · 分支 ${s.branch}` : ""}
              </div>
            </div>
          </label>
        ))
      ) : (
        <div className="ph-empty">
          还没有插件源。添加一个仓库主页地址(仓库根需有 pv-plugins.json)。
        </div>
      )}
    </div>
  );

  const renderMarket = () => {
    if (!activeSource) {
      return (
        <div className="ph-empty">
          尚未激活插件源:请先在「插件源」中添加并激活一个源。
        </div>
      );
    }
    return (
      <div className="ph-list">
        <div className="ph-market-head">
          <span>
            源:{market?.name || activeSource.name}
            {marketLoading ? " · 拉取中…" : ""}
          </span>
          <button
            className="btn small"
            onClick={() => void loadMarket(activeSource)}
            disabled={marketLoading}
          >
            <IconRefresh size={14} /> 刷新
          </button>
        </div>
        {marketError ? <div className="ph-row-error">{marketError}</div> : null}
        {market && market.plugins.length === 0 ? (
          <div className="ph-empty">该源暂无可用插件。</div>
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
          <IconPlugin size={16} /> 插件
        </div>
        <div className="ph-sections">
          <button
            className={"ph-seg" + (section === "installed" ? " active" : "")}
            onClick={() => setSection("installed")}
          >
            已安装 {installedRows.length}
          </button>
          <button
            className={"ph-seg" + (section === "sources" ? " active" : "")}
            onClick={() => setSection("sources")}
          >
            插件源 {state?.sources.length ?? 0}
          </button>
          <button
            className={"ph-seg" + (section === "market" ? " active" : "")}
            onClick={() => setSection("market")}
          >
            <IconMarket size={14} /> 市场
          </button>
          {panels.map(({ pluginId, def }) => (
            <button
              key={pluginId}
              className={"ph-seg" + (section === `panel:${pluginId}` ? " active" : "")}
              onClick={() => setSection(`panel:${pluginId}`)}
            >
              {def.title}
            </button>
          ))}
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
        <Modal title="安装插件" onCancel={() => setInstallCandidate(null)}>
          <p className="modal-message">
            「{installCandidate.entry.name}」{" "}
            {installCandidate.entry[installCandidate.channel]?.version}(
            {CHANNEL_LABELS[installCandidate.channel]})请求以下权限,同意后才安装:
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
            <p className="muted">该插件未申请任何权限。</p>
          ) : null}
          <div className="modal-actions">
            <button className="btn" onClick={() => setInstallCandidate(null)}>
              取消
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
              同意并安装
            </button>
          </div>
        </Modal>
      ) : null}

      {uninstallTarget ? (
        <ConfirmModal
          title="卸载插件"
          message={`确定卸载「${manifests[uninstallTarget]?.name ?? uninstallTarget}」?其数据目录与已下载文件将被删除,此操作不可恢复。`}
          confirmText="卸载"
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
            <span className="badge ok">已安装 {installed.version}</span>
          ) : null}
        </div>
        <div className="ph-row-sub">{entry.desc || entry.id}</div>
        {entry.minAppVersion ? (
          <div className="ph-row-sub muted">要求应用 ≥ {entry.minAppVersion}</div>
        ) : null}
      </div>
      <div className="ph-row-actions">
        <select
          className="input select small"
          value={channel}
          onChange={(e) => setChannel(e.target.value as Channel)}
          title="选择通道"
        >
          {entry.release ? (
            <option value="release">正式版 {entry.release.version}</option>
          ) : null}
          {entry.beta ? (
            <option value="beta">测试版 {entry.beta.version}</option>
          ) : null}
        </select>
        <button
          className="btn small primary"
          disabled={busy || !ref || installedCurrent}
          onClick={() => onPick(channel)}
        >
          {installedCurrent ? "已是最新" : ref ? `安装 ${ref.version}` : "无可用包"}
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
