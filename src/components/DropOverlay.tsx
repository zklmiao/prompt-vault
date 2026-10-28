import { IconImport } from "./icons";

/** 拖拽悬停时的全屏提示;不拦截鼠标事件 */
export default function DropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="drop-overlay" aria-hidden="true">
      <div className="drop-card">
        <IconImport size={30} />
        <div className="drop-title">松开以导入 JSON / 新建文本</div>
        <div className="drop-hint">
          .json 走导入流程(合并或覆盖);.txt / .md 等文本直接新建收藏
        </div>
      </div>
    </div>
  );
}
