// 插件窗口通用容器:ui:"window" 插件的专属 WebviewWindow 内容
// (Rust 侧 plugin_open_window 创建窗口并加载 index.html?plugin=<id>,本组件分流至此,
// 注入该插件的 main.js,等待其 pv.window.setup 注册后执行 onMount 渲染插件内容)。
// 语言跟随创建时状态(无跨窗口语言事件,v2 评估,见开工卡 §3.6)。

import { useEffect, useRef, useState } from "react";
import { getWindowSetup } from "./registry";
import { injectOne } from "./host";
import { useI18n } from "../i18n";

type Status = "loading" | "ready" | "error";

export default function PluginWindow({ pluginId }: { pluginId: string }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return; // StrictMode 双挂载只注入一次
    startedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        await injectOne(pluginId);
        const setup = getWindowSetup(pluginId);
        if (!setup) {
          throw new Error(t("pw.noSetup"));
        }
        if (cancelled) return;
        setStatus("ready");
        // 等容器渲染一帧后交给插件
        requestAnimationFrame(() => {
          if (cancelled) return;
          const el = containerRef.current;
          if (el) setup.onMount(el);
        });
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pluginId, t]);

  return (
    <div className="plugin-window-root">
      {status === "error" ? (
        <div className="plugin-window-error" role="alert">
          {t("pw.loadFailed", { msg: error ?? "" })}
        </div>
      ) : null}
      {status === "loading" ? (
        <div className="plugin-window-hint">{t("pw.loading")}</div>
      ) : null}
      <div ref={containerRef} className="plugin-window-body" />
    </div>
  );
}
