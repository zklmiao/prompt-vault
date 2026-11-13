# AGENTS.md — Prompt Vault 协作说明

本地优先的 Prompt 收藏桌面工具:Tauri 2(Rust 壳)+ React 19 + TypeScript(Vite)。收藏数据保存在单个本地 JSON 文件;插件系统另有 `plugins.json`(插件状态)与 `plugins\`、`locales\` 目录。核心离线,插件按需联网(经 Rust 代理校验)。

## 开工前先读

1. **`docs/backlog.md`** —— 所有未完成的待办与优化都在这里(P0 问题、UI/UX 炫技清单、实施批次)。做完对应条目请勾掉。
2. **`README.md`** —— 功能、架构、构建方式与快捷键。

## 硬性约定

- 界面全中文;样式全部走 `src/App.css` 的 CSS token(`:root` 与 `[data-theme="dark"]`),不硬编码颜色。
- 图标统一用 `src/components/icons.tsx` 的内联 SVG(线性、16px),不引入图标库或 UI 框架。
- 数据是单个 JSON:写盘必须复用现有原子写实现(临时文件 + `MoveFileEx` 替换 + `.bak` 备份);新字段一律可选,`src/util.ts` 的 `coerceItems` 必须兼容旧数据。
- 插件联网一律经 `pv.net.fetch` 的 Rust 代理(host 白名单 + SSRF 防护 + 调用者校验);凭据只进 Windows 凭据管理器或环境变量,不落任何明文 JSON。
- 前端改完跑 `npx tsc --noEmit`(严格模式、`noUnusedLocals`);构建用 `npm run tauri build`(NSIS 打包需从 GitHub 下载工具,偶发超时,重试同一命令即可)。
- 构建后把 `src-tauri/target/release/prompt-vault.exe` 与 `bundle/nsis` 下的安装包复制到 `releases/PromptVault-便携版.exe`、`releases/PromptVault-安装包.exe`,并冒烟启动一次。
- 改完同步 README 的功能表/路线图;提交信息用 conventional commits(`feat:` / `fix:` / `docs:`)。

## 结构速览

- `src/App.tsx` —— 主窗口状态与数据流(两栏界面、回收站、批量、导入导出、拖拽);
- `src/QuickPick.tsx` —— `Alt+Q` 全局快速拾取窗口(独立窗口,`main.tsx` 按 label 分流);
- `src/components/` —— TitleBar / Sidebar / DetailPane / BatchPanel / SettingsModal / Modal 等;
- `src/plugins/` —— 插件宿主与插件区(pv 桥、注入引擎、已安装/源/市场/圆球/MCP 页签);
- `src/i18n/` —— i18n 运行时(t() context、语言切换、zh-CN fallback);
- `src/util.ts` —— 占位符解析、数据纠偏、时间比较等纯函数;
- `src-tauri/src/lib.rs` —— 托盘、全局热键、窗口管理、数据文件读写命令;
- `src-tauri/src/plugins.rs` —— 插件安装管线与宿主状态存储(下载→sha256→解压限额→落盘);
- `src-tauri/src/net.rs` —— 插件网络代理(SSRF 防护、host 白名单、三种认证模式);
- `src-tauri/src/credentials.rs` —— Windows 凭据管理器封装(Key 明文不出 Rust);
- `src-tauri/src/i18n.rs` —— locales 目录扫描与语言包读取;
- `src-tauri/src/mcp/` —— `--mcp` headless MCP Server(stdio JSON-RPC,tools + prompts);
- `preview/` —— 浏览器预览夹具(mock 掉 Tauri API,不参与构建)。

## 预览与测试

- 纯浏览器预览:`npx vite --config preview/vite.preview.config.ts`(端口 1421);
- QuickPick 窗口、托盘、全局热键、Mica 等 Rust 侧行为只能打包后用 `npm run tauri dev` 或 exe 人工验证;
- 构建产物与源码一致性:构建后确认 `releases/` 时间戳更新。
