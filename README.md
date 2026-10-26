# Prompt Vault

本地 Prompt 收藏工具:把觉得有用的 prompt 以文字形式存下来,随时搜索、置顶、一键复制。

Tauri 2 + React 19 + TypeScript 桌面应用,数据保存在本地单个 JSON 文件中,不联网。

## 功能

- 新增 / 编辑 / 删除,字段:标题、正文、标签、来源、备注
- **回收站**:删除先进回收站,可恢复;彻底删除才二次确认
- 关键词搜索:标题 / 正文 / 标签 / 备注,大小写不敏感;**点标签即可筛选**
- 标签自由输入,输入时自动补全用过的标签
- 星标置顶:置顶的排最前,其余按更新时间倒序
- 变量占位符:正文里写 `{{变量名}}`(中英文均可),复制时弹窗填空(同名只填一次,留空保持原样),**记住上次填写值**自动预填
- 导入 / 导出 JSON:导入可选「合并」(按 id 去重,冲突取 updatedAt 较新者)或「覆盖」
- **全局快捷键**:
  - `Alt+Q` 任意界面唤出**快速拾取**面板:输入过滤,`↑↓` 选择,`Enter` 复制并自动隐藏
  - `Alt+Shift+N` 把剪贴板内容直接存为新收藏
- 窗口内快捷键:`Ctrl+N` 新建、`Ctrl+F` 搜索、编辑器 `Ctrl+Enter` 保存、弹窗 `Esc` 取消
- 系统托盘:点窗口 ✕ 隐藏到托盘;托盘左键唤出/收起主窗口,右键菜单「打开主窗口 / 退出」
- **暗色模式**:跟随系统,右上角按钮手动切换(记忆在 localStorage)
- 主窗口位置 / 大小记忆

## 数据与备份

- 首次启动弹窗选择数据文件保存位置(默认建议 `data/prompts.json`),路径记录在
  `%APPDATA%\prompt-vault\config.json`(窗口位置也记在这里)
- 每次写入前自动把旧文件备份为 `prompts.json.bak`;写入是「临时文件 + MoveFileEx 原子替换」
- 数据文件损坏时应用暂停读写,界面上可一键「用 .bak 备份恢复」
- 换机器迁移:导出 JSON → 新机器导入即可

## 日常使用

装机一次后双击 `Prompt Vault`(安装包版)或便携 exe,不需要命令行。

- 关闭窗口 = 收进托盘,后台常驻,随时托盘左键唤出;推荐记 `Alt+Q` 快速拾取
- 真正退出:托盘图标右键 → 退出
- 构建产物:`releases/` 下有安装包与便携版;原始产物在 `src-tauri/target/release/`

## 开发

```powershell
npm install
npm run tauri dev     # 开发模式
npm run tauri build   # 构建
npx vite --config preview/vite.preview.config.ts   # 纯浏览器预览(mock Tauri API),改 UI 不用起 Tauri
```

前置条件:Node 18+、Rust(MSVC toolchain)、WebView2(Windows 11 自带)。

- 前端:`src/`(React + TS),Rust:`src-tauri/src/lib.rs`(托盘、热键、数据文件读写、窗口管理)
- 应用图标源图:`app-icon.png`,改动后运行 `npx tauri icon app-icon.png` 重新生成全套
- `preview/` 是浏览器预览夹具,不参与 `npm run build`(tsconfig 只含 `src`)
