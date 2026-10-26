import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

export function windowLabel(): string {
  try {
    return getCurrentWebviewWindow().label;
  } catch {
    // 纯浏览器预览(无 Tauri 运行时)视作主窗口
    return "main";
  }
}

/** 快速拾取窗口下把页面背景变透明,只露出圆角面板 */
export function applyWindowModeClass(): void {
  if (windowLabel() === "quickpick") {
    document.documentElement.classList.add("qp-mode");
  }
}
