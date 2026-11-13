import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export function windowLabel(): string {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    // 纯浏览器预览(无 Tauri 运行时):支持 ?quickpick=1 单独预览快速拾取窗口
    try {
      const qp = new URLSearchParams(window.location.search).get("quickpick");
      if (qp === "1") return "quickpick";
    } catch {
      /* ignore */
    }
    return "main";
  }
}

/** 插件窗口按 URL 参数 ?plugin=<id> 分流(与 Rust 侧 plugin_open_window 约定一致) */
export function pluginWindowId(): string | null {
  try {
    const id = new URLSearchParams(window.location.search).get("plugin");
    return id && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** 快速拾取/插件窗口下把页面背景变透明,只露出各自面板内容 */
export function applyWindowModeClass(): void {
  if (windowLabel() === "quickpick") {
    document.documentElement.classList.add("qp-mode");
  } else if (pluginWindowId() !== null) {
    document.documentElement.classList.add("pv-plugin-mode");
  }
}
