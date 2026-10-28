// 浏览器预览夹具:模拟 @tauri-apps/api/webviewWindow。
// StrictMode 会挂载两次 effect,mock 用集合保存 handler,避免后一次注册被前一次清理误删。
// 在控制台触发拖放:
//   __pvDrop({ payload: { type: "enter", paths: ["C:/x.md"], position: { x: 10, y: 10 } } })
type DropPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

type DropHandler = (event: { payload: DropPayload }) => void;

const handlers = new Set<DropHandler>();

function installDispatcher() {
  (window as unknown as { __pvDrop?: (e: { payload: DropPayload }) => void }).__pvDrop =
    (event) => {
      for (const h of handlers) h(event);
    };
}

export function getCurrentWebviewWindow() {
  return {
    label: "main",
    async onDragDropEvent(handler: DropHandler) {
      handlers.add(handler);
      installDispatcher();
      return () => {
        handlers.delete(handler);
      };
    },
    async onResized(_handler: () => void) {
      // 预览环境没有真实窗口尺寸变化;返回 unlisten 形状保持一致
      return () => {};
    },
  };
}
