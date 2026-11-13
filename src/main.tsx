import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import QuickPick from "./QuickPick";
import PluginWindow from "./plugins/PluginWindow";
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
