import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import QuickPick from "./QuickPick";
import PluginWindow from "./plugins/PluginWindow";
import { I18nProvider } from "./i18n";
import { applyWindowModeClass, pluginWindowId, windowLabel } from "./window";

applyWindowModeClass();

function Root() {
  const pluginId = pluginWindowId();
  if (pluginId !== null) {
    // 插件专属窗口:不加载主界面,仅执行该插件的 window.setup
    return <PluginWindow pluginId={pluginId} />;
  }
  return windowLabel() === "quickpick" ? <QuickPick /> : <App />;
}

// App 与 QuickPick 两个渲染根共用同一个 I18nProvider(语言状态在本 webview 内一致)
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <Root />
    </I18nProvider>
  </React.StrictMode>,
);
