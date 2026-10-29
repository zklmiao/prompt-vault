<div align="center">

<img src="src-tauri/icons/128x128.png" width="112" alt="Prompt Vault" />

# Prompt Vault

**本地优先的 Prompt 收藏工具 — 收集、检索、填空、一键复制**

<sub>Collect · Search · Fill · Copy — a local-first prompt vault for Windows.<br/>
No account, no cloud, no telemetry. Your prompts stay in a plain JSON file.</sub>

<br/>

<img src="docs/screenshots/detail-dark.png" width="86%" alt="Prompt Vault 主界面" />

<a href="https://tauri.app"><img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white"></a> <a href="https://react.dev"><img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black"></a> <a href="https://www.typescriptlang.org"><img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white"></a> <a href="https://www.rust-lang.org"><img alt="Rust" src="https://img.shields.io/badge/Rust-stable-000000?logo=rust&logoColor=white"></a> <img alt="Platform" src="https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D4?logo=windows&logoColor=white"> <img alt="Version" src="https://img.shields.io/badge/Version-0.1.9-5865F2"> <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/License-MIT-2ea44f"></a> <img alt="Local First" src="https://img.shields.io/badge/Data-100%25%20Local-success">

</div>

---

## ✨ 为什么是 Prompt Vault

平时攒下的 prompt 散落在笔记、聊天记录和收藏夹里，要用时翻半天。
Prompt Vault 把它们收进一个**托盘常驻、随叫随到**的桌面工具：`Alt+Q` 唤出、输入几个字、`Enter` —— 复制走人，全程两秒。

- 🪶 **轻**：Tauri 2 原生壳，便携版单文件 ≈ 5 MB，内存占用小
- 🔒 **私**：不联网、不登录、无遥测；数据就是一个你可以随手备份的 JSON 文件
- ⚡ **快**：全局热键 + 快速拾取面板，找一条 prompt 不需要离开手头的应用
- 🧩 **巧**：`{{变量}}` 占位符在复制前弹窗填空，并记住你上次的填写

---

## 🚀 功能一览

| | 能力 | 说明 |
|---|---|---|
| 📥 | **收集** | 手动新建、`Alt+Shift+N` 剪贴板速存、导入 JSON、拖拽 `.json` 导入 / 拖文本直接新建 |
| 🎓 | **上手** | 首次启动给出 3 步引导（收集 / 试占位符 / 记热键），可一键跳过；空态始终给出下一步动作 |
| 🔍 | **检索** | 标题/正文/标签/备注即时模糊搜索（子序列匹配、命中词高亮）；点标签直接筛选；标签输入自动补全 |
| 🧩 | **变量占位符** | 正文写 `{{变量}}`，复制前弹窗逐个填空（同名只填一次、留空保持原样），并**记忆上次填写值**；变量在正文中高亮，详情显示变量数量 |
| ⚡ | **快速拾取** | `Alt+Q` 在任意界面唤出双栏面板：模糊搜索 + 命中高亮、右侧实时预览；空查询展示「最近复制 / 最常复制」；`Tab` 直接进入编辑，复制后有确认反馈并自动隐藏 |
| ⌘ | **命令面板** | `Ctrl+K` 模糊搜索执行常用操作（新建/导入/导出/排序/主题/设置…）；`?` 打开快捷键速查表 |
| 📌 | **整理** | 星标置顶、自由标签、来源与备注字段 |
| 📊 | **使用统计** | 自动记录每条 prompt 的复制次数与最近复制时间，列表可按「最近更新 / 最近复制 / 最常复制」排序 |
| 🗑 | **回收站** | 删除先进回收站可随时恢复，彻底删除才二次确认 |
| ☑️ | **批量操作** | 多选后批量加标签、批量移入回收站/恢复、批量导出所选（Ctrl/Shift 多选、Ctrl+A 全选、Esc 取消） |
| 🎨 | **体验** | 自绘标题栏、暗色/亮色主题（跟随系统）、托盘常驻、窗口位置记忆、详情切换级联淡入、**中文输入法组字安全**（拼音选字按 Enter 不会误触发业务动作）、全中文界面 |
| 💾 | **数据安全** | 单 JSON 文件 + 原子写入 + 每次写入前自动 `.bak` 备份，损坏时可一键恢复 |

---

## ⌨️ 快捷键

| 快捷键 | 作用域 | 作用 |
|---|---|---|
| `Alt+Q` | 全局 | 唤出/收起快速拾取面板 |
| `Alt+Shift+N` | 全局 | 把剪贴板内容存为新收藏 |
| `Ctrl+N` | 主窗口 | 新建 |
| `Ctrl+F` | 主窗口 | 聚焦搜索框 |
| `Ctrl+K` | 主窗口 | 打开 / 关闭命令面板 |
| `?` | 主窗口 | 打开 / 关闭快捷键速查表 |
| `Ctrl+A` / `Esc` | 主窗口 | 全选当前列表（多选） / 清除多选 |
| `Ctrl+Enter` | 编辑器 | 保存 |
| `↑` `↓` / `Enter` / `Tab` / `Esc` | 快速拾取 | 选择 / 复制并关闭 / 在主窗口中编辑 / 关闭 |
| `Esc` | 弹窗 | 取消 |

> 两个全局热键可以在应用内 **设置（右上角 ⚙）** 中修改：点击输入框直接录制组合键，保存后立即生效、无需重启；若组合被其他应用占用会提示并保留旧键。

> 点窗口 ✕ = 收进系统托盘（不退出）；托盘**左键**唤出/收起，**右键菜单**可打开主窗口或真正退出。

---

## 🖼 界面一览

<div align="center">

| 亮色模式 | 暗色模式 |
|:---:|:---:|
| <img src="docs/screenshots/detail-light.png" alt="亮色模式" /> | <img src="docs/screenshots/detail-dark.png" alt="暗色模式" /> |

| 变量填空 | 回收站 |
|:---:|:---:|
| <img src="docs/screenshots/placeholder-modal.png" alt="变量填空弹窗" /> | <img src="docs/screenshots/trash.png" alt="回收站" /> |

| 快速拾取（`Alt+Q`） | 命令面板（`Ctrl+K`） |
|:---:|:---:|
| <img src="docs/screenshots/quickpick.png" alt="快速拾取面板" /> | <img src="docs/screenshots/command-palette.png" alt="命令面板" /> |

<img src="docs/screenshots/onboarding.png" width="86%" alt="首次启动引导" />

</div>

---

## 📦 快速开始

### 方式一：下载即用（推荐）

到 [**Releases**](../../releases) 下载任一版本：

| 文件 | 说明 |
|---|---|
| `PromptVault-0.1.0-setup.exe` | NSIS 安装包，装进系统，开始菜单可启动 |
| `PromptVault-0.1.0-portable.exe` | 单文件绿色版，放到哪都能双击运行 |

> 首次启动会让你选择一个 `prompts.json` 的保存位置（默认建议工程内 `data/` 目录），之后路径与窗口位置都会记住。
> 想备份？复制那个 JSON 文件即可；换机器？导出再导入。

> 当前源码版本为 **0.1.9**；Releases 中最新正式发布仍是 v0.1.0。v0.1.9 发布后，上表文件名会同步为 `PromptVault-0.1.9-*`。

### 方式二：从源码构建

前置条件：[Node.js](https://nodejs.org) 18+、[Rust](https://rustup.rs)（MSVC toolchain）、WebView2（Windows 11 自带）。

```powershell
npm install
npm run tauri build
```

产物：

- 便携版 → `src-tauri/target/release/prompt-vault.exe`
- 安装包 → `src-tauri/target/release/bundle/nsis/`

---

## 🔒 数据与隐私

- **所有数据只存在本地**：一个 JSON 文件，内容完全透明，随时可用任意编辑器查看
- **原子写入**：临时文件 `sync` 落盘后经 `MoveFileEx(REPLACE_EXISTING)` 原地替换，不存在写一半的中间态
- **自动备份**：每次写入前旧文件保存为 `prompts.json.bak`；数据解析失败时应用暂停读写，并可一键从 `.bak` 恢复
- **配置同样本地**：`%APPDATA%\prompt-vault\config.json` 只保存数据文件路径、窗口位置与全局热键，不包含收藏内容
- **无网络请求**：应用不发起任何外部请求，不采集任何信息

数据文件结构：

```json
{
  "version": 1,
  "prompts": [
    {
      "id": "5d0f0f2e-…",
      "title": "代码审查助手",
      "body": "请审查以下代码变更:\n{{diff}}\n\n重点关注:{{关注点}}",
      "tags": ["编码", "审查"],
      "source": "",
      "note": "PR 自查和互查都适用",
      "pinned": true,
      "createdAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-24T02:10:00.000Z",
      "lastValues": { "关注点": "并发安全" },
      "deletedAt": null,
      "copyCount": 12,
      "lastCopiedAt": "2026-10-27T09:12:00.000Z"
    }
  ]
}
```

---

## 🧱 技术栈与架构

```mermaid
flowchart LR
  U([用户]) --> M["主窗口<br/>两栏 UI"]
  U --> Q["快速拾取<br/>Alt+Q"]
  U --> P["命令面板<br/>Ctrl+K"]

  M --> F["React 19 + TypeScript"]
  Q --> F
  P --> F

  F -- "Tauri invoke" --> R["Rust 命令层"]
  R --> D[("prompts.json")]
  R --> B[("prompts.json.bak")]
  R --> C[("config.json<br/>数据路径 · 窗口位置 · 热键")]

  H["全局热键<br/>Alt+Q / Alt+Shift+N"] --> Q
  T["系统托盘"] --> M
```

```text
prompt-vault/
├─ src/                        # React 前端
│  ├─ App.tsx                  # 主窗口:两栏、搜索、批量、回收站、导入导出、命令面板接线
│  ├─ QuickPick.tsx            # 快速拾取:双栏预览、模糊搜索、复制确认
│  ├─ components/              # TitleBar / Sidebar / DetailPane / CommandPalette /
│  │                           # CheatsheetModal / Onboarding / BatchPanel / SettingsModal …
│  ├─ util.ts                  # 模糊匹配、占位符解析、数据纠偏、热键格式化
│  ├─ theme.ts / window.ts     # 主题与窗口模式(含浏览器预览分流)
│  ├─ api.ts                   # Tauri API 封装
│  └─ App.css                  # 主题令牌(亮/暗)+ 全部样式
├─ src-tauri/
│  ├─ src/lib.rs               # 托盘、全局热键、原子写入、窗口与统计命令
│  └─ tauri.conf.json
├─ preview/                    # 浏览器预览夹具(?quickpick=1 / ?empty=1)
├─ docs/
│  ├─ backlog.md               # 待办与路线图
│  └─ screenshots/
└─ AGENTS.md                   # 协作约定(给维护者 / agents)
```

**设计取舍**

- 数据用**单个 JSON 文件**而不是数据库：几十到几百条的规模下零运维、可读、可备份；数据量上千后再评估 SQLite + FTS5
- **不引入 Agent/UI 框架**：界面是手写 React + CSS 变量，按钮是内联 SVG 图标，构建产物小、无风格依赖
- **第二层入口收敛到命令面板**：新能力优先进入命令面板或快捷键，顶栏只保留高频动作，避免界面随功能膨胀
- 占位符记忆、置顶、回收站、复制统计全部落在同一个数据文件里，**无旁路状态**

---

## 🛠 开发

```powershell
npm install
npm run tauri dev      # 开发模式(热更新)
npm run tauri build    # 构建发行版

# 纯浏览器预览:mock 掉 Tauri API,改 UI 不用起 Tauri
npx vite --config preview/vite.preview.config.ts
```

- 前端严格模式 TypeScript(`tsc --noEmit` 零错误)
- 图标源图 `app-icon.png`，修改后 `npx tauri icon app-icon.png` 重新生成全套
- `preview/` 是开发预览夹具，不参与正式构建(tsconfig 只含 `src`)，默认端口 **4173**
  - `?quickpick=1` 单独预览快速拾取窗口；`?empty=1` 以空数据启动（验证首次引导）
- 待办与路线图见 [`docs/backlog.md`](docs/backlog.md)；协作约定见 [`AGENTS.md`](AGENTS.md)

---

## 🗺 路线图

- [x] 托盘常驻 + 全局快速拾取（`Alt+Q`，双栏预览与模糊搜索）
- [x] 剪贴板速存 / 全局热键可配置
- [x] 占位符填空与填写记忆
- [x] 回收站 / 暗色模式 / 窗口位置记忆 / 自绘标题栏
- [x] 拖拽导入 / 批量操作 / 使用统计
- [x] 命令面板（`Ctrl+K`）与快捷键速查表（`?`）
- [x] 首次启动引导 / 详情级联淡入 / 中文输入法组字保护
- [ ] 占位符实时预览、搜索命中片段、右键菜单、标签配色（详见 [docs/backlog.md](docs/backlog.md)）
- [ ] 发布 v0.1.9 Release（代码与构建已就绪，README 下载表待同步）
- [ ] 数据量过千后评估 SQLite + FTS5

---

## 🤝 贡献

欢迎 Issue 与 PR：

1. Fork 本仓库并从 `main` 切出功能分支
2. 提交前跑一遍 `npx tsc --noEmit` 与 `npm run tauri build`
3. PR 里说明改动动机与交互变化（带截图更好）

<details>
<summary><b>English</b></summary>

**Prompt Vault** is a local-first prompt manager for Windows, built with Tauri 2 + React 19 + TypeScript.

- **Collect** prompts manually, from the clipboard (`Alt+Shift+N`), via JSON import, or by drag & drop
- **Find** them with instant fuzzy search (highlighted matches), clickable tag filters, and tag autocomplete
- **Fill** `{{variables}}` in a modal before copying — values are remembered for next time
- **Copy** from a global quick-pick palette (`Alt+Q`): two-pane preview, recent/most-used sections, `↑↓`, `Enter` — done
- **Command everything** with `Ctrl+K`; press `?` for the shortcut cheatsheet
- **Organize** with pins, tags, batch actions, a trash bin, and usage stats (copy count / recency sorting)
- **Get started fast**: a 3-step first-run guide (collect · variables · hotkey) that can be skipped
- **Stay safe**: single JSON file, atomic writes, automatic `.bak` backups, one-click recovery
- **Feel good**: tray-resident, custom title bar, dark/light theme, window-position memory, all in Chinese UI

```bash
npm install && npm run tauri build   # requires Node 18+, Rust (MSVC), WebView2
```

MIT License.

</details>

---

## 📄 许可

[MIT](LICENSE) © 2026 zklmiao

图标路径参考自 [Lucide](https://lucide.dev)（ISC License）。感谢 [Tauri](https://tauri.app)、[React](https://react.dev)、[Vite](https://vite.dev) 社区。

<div align="center"><sub>如果这个工具对你有用，欢迎点一个 ⭐</sub></div>
