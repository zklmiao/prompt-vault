// 浏览器预览夹具:把 Tauri API 替换成 preview/ 下的 mock,让 UI 在纯浏览器可跑
// 用法: npx vite --config preview/vite.preview.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const r = (f: string) => path.resolve(process.cwd(), "preview", f);

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1421, strictPort: true },
  resolve: {
    alias: [
      { find: "@tauri-apps/api/core", replacement: r("mock-core.ts") },
      { find: "@tauri-apps/plugin-dialog", replacement: r("mock-dialog.ts") },
      {
        find: "@tauri-apps/plugin-clipboard-manager",
        replacement: r("mock-clipboard.ts"),
      },
    ],
  },
});
