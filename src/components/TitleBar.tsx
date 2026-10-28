import { useEffect, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { winClose, winIsMaximized, winMinimize, winToggleMaximize } from "../api";
import { IconMaximize, IconMinimize, IconRestore, IconX } from "./icons";

/**
 * 自绘标题栏(仅主窗口渲染;快速拾取窗口由 main.tsx 分流,不走这里)。
 *
 * 拖动与双击最大化由 Tauri 的 drag-region 脚本原生处理:
 * data-tauri-drag-region="deep" 让空白区与品牌区可拖动,
 * 而按钮等可点击元素会被脚本自动豁免,不会误触发拖动。
 * 因此这里不要再手写 onDoubleClick,否则会与原生行为叠加成双重切换。
 */
export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = () => {
      void winIsMaximized()
        .then((value) => {
          if (!disposed) setMaximized(value);
        })
        .catch(() => {
          /* 浏览器预览等无 Tauri 环境 */
        });
    };
    sync();
    (async () => {
      try {
        // 双击标题栏、系统快捷键(Win+↑)等都会触发 resize,借此同步图标
        const stop = await getCurrentWebviewWindow().onResized(sync);
        if (disposed) stop();
        else unlisten = stop;
      } catch {
        /* 浏览器预览无窗口事件 */
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const toggleMaximize = async () => {
    try {
      await winToggleMaximize();
      // 等系统完成过渡后再取状态,图标切换更稳
      window.setTimeout(() => {
        void winIsMaximized()
          .then(setMaximized)
          .catch(() => {});
      }, 60);
    } catch {
      /* 忽略:窗口状态查询失败不影响主流程 */
    }
  };

  return (
    <header className="titlebar" data-tauri-drag-region="deep">
      <div className="titlebar-brand">
        <img src="/icon.png" width={16} height={16} alt="" draggable={false} />
        <span>Prompt Vault</span>
      </div>
      <div className="titlebar-spacer" />
      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-btn"
          title="最小化"
          onClick={() => void winMinimize()}
        >
          <IconMinimize size={15} />
        </button>
        <button
          type="button"
          className="titlebar-btn"
          title={maximized ? "还原" : "最大化"}
          onClick={() => void toggleMaximize()}
        >
          {maximized ? <IconRestore size={14} /> : <IconMaximize size={14} />}
        </button>
        <button
          type="button"
          className="titlebar-btn titlebar-close"
          title="关闭到托盘"
          onClick={() => void winClose()}
        >
          <IconX size={15} />
        </button>
      </div>
    </header>
  );
}
