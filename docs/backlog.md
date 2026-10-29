# Prompt Vault 待办与路线图

> 最后更新:2026-10-28。
> 维护约定:所有未完成的计划都写在这里,不要只留在聊天记录里;完成后把 `[ ]` 改为 `[x]`,并注明提交号或版本。
> 状态基线:v0.1.0 已发布(GitHub Release 双资产),此后新增功能均已提交:拖拽导入与批量操作(`66cf56a`)、使用统计与可配置热键(`5957037`)、自绘标题栏(`29dea01`)、QuickPick 2.0(`430fbd5`)、命令面板与速查表(`62a6a51`);当前版本 **0.1.9**(待发布 v0.1.9 Release,README 下载资产名仍指向 v0.1.0)。

---

## P0 · 立即修

### P0-1 ✅ 中文输入法(IME)组字期间 Enter/Esc 等按键误触发(已修复 `98cde4f`)
**现象**:用微软拼音等输入法打字时,按 Enter 确认候选词会同时触发业务动作:
- `src/QuickPick.tsx` —— 中文搜索中按 Enter 选字,会**直接复制当前高亮项并隐藏窗口**;方向键被拦截、Esc 取消组字却关窗;
- `src/components/TagInput.tsx` —— 拼音未上屏时按 Enter 会把**拼音串**当标签加入;空输入组字中按 Backspace 会**删掉上一个标签**;
- `src/components/PlaceholderModal.tsx` —— 在最后一个变量框按 Enter 选字会**直接复制**;
- `src/components/Modal.tsx` —— 输入框里按 Esc 取消拼音会**直接关掉弹窗**;
- `src/App.tsx` 两处全局监听、`SettingsModal` 热键录制同样缺保护。

**修复**(`98cde4f`):新增 `src/util.ts` 的 `isComposingEvent()`(同时判定 `isComposing` 与 `keyCode 229`,兼容 Windows/WebView2 输入法),在 8 处按键处理点加守卫:QuickPick(方向键/Enter/Esc)、TagInput(Enter/逗号/Backspace)、PlaceholderModal(Enter)、DetailPane(Ctrl+Enter,并消除正文 textarea 的重复实现)、Modal(Esc)、App 两处全局监听(Ctrl+N/F、Esc/Ctrl+A)、SettingsModal(热键录制)。
**验证**:`tsc` 零错误;预览页合成 IME 事件断言——组字 Enter 不加标签/不复制、普通 Enter 行为不变,组字 Esc 不关弹窗;构建 + 冒烟通过。
**仍需人工**:用真实微软拼音在打包 exe 上过一遍原验收清单(合成事件无法完全替代真实 IME)。

### P0-2 ✅ README / 文档截图落后于当前界面(已修复 `51a6d80`)
**现象**:4 张截图摄于 10-27,早于自绘标题栏、批量操作、使用统计与「2 个变量」徽标收窄;首图露出旧界面。
**修复**(`51a6d80`):用 `preview/` 夹具(mock 掉 Tauri API,仅用 8 条示例数据,未触碰用户真实 `data/prompts.json`)在浏览器内按 1100×750 重新截取 `docs/screenshots/` 四张图——暗色详情、亮色详情、变量填写弹窗、回收站;画面已包含自绘标题栏、小胶囊变量徽标、当前按钮组(新建/剪贴板/回收站/导入/导出/设置/主题)与复制统计信息。
**验证**:逐张回看确认主题与布局正确、无真实数据;四张均为 1100×750 PNG;截图提交的 `git diff` 仅含这 4 个二进制文件。

---

## P1 · UI/UX 炫技优化(2026-10-28 深度评估)

> 依据:逐屏截图 review + 代码核查。成本标注:S ≈ 半天内、M ≈ 1–3 天、L ≈ 3 天以上。

### S 级(签名体验,做 2–3 个即可镇场)

#### S1 ✅ QuickPick 2.0(已修复 `430fbd5`)
**已完成**:窗口改为 900×480 双栏(左结果列 360px,右侧实时预览);`src/util.ts` 新增 `fuzzyMatch` / `matchPrompt`(子序列匹配,连续命中/词首/完整子串加权;字段权重 标题×3、标签×2、来源×1.5、备注×1、正文×1),主窗口搜索同步切换;命中字符 `<mark class="hl">` 高亮;正文命中且标题/标签未命中时显示一行上下文片段;空查询显示「最近复制 / 最常复制」分区(去重,无数据时回退置顶+最近更新);底部快捷键提示条;复制后 420ms 确认态(含已填充变量数);`Tab` 经新增 Rust 命令 `open_editor` 跳转主窗口进入编辑;每次面板显示重新读盘。
**验证**:`tsc` 零错误;`cargo check`、构建、冒烟通过;预览页合成事件断言:子串/子序列命中并高亮、反序不命中、正文片段、分区、↑↓ 跨分区、确认态 420ms 后复位、Tab 复位;主窗口搜索「代助」命中、「助代」不命中。
**说明**:窗口高度按实际布局取 480(原评估 460 放不下 7 行含片段的结果区 + 底栏)。

#### S2 ❌ Windows 11 Mica / Acrylic 窗口材质(2026-10-29 决定不做)
**决定**:用户明确不做,不再排期。原方案仅作追溯:接入 `window-vibrancy`(Win11 `apply_mica` / Win10 `apply_acrylic`),标题栏与侧栏半透明、内容区保持实底。若将来重新考虑,先评估 WebView2 文字渲染与滚动性能。

#### S3 ✅ 应用内命令面板 `Ctrl+K` + 快捷键速查表 `?`(已完成 `62a6a51`)
**已完成**:
- `src/components/CommandPalette.tsx`:640px 居中面板,复用 qp-* 视觉;分组(收藏 / 视图 / 应用)共 11 条命令,支持子序列模糊过滤(标签权重×3、关键词×2)与命中高亮;↑↓ 跨分组循环、Enter 执行、Esc(窗口级,焦点无关)关闭、点遮罩关闭;执行命令先关闭面板;排序项显示当前勾选;全局热键与「快速拾取」热键动态读取配置展示。
- `src/components/CheatsheetModal.tsx`:`?` 打开,复用 Modal(focus trap + Esc);全局 / 窗口 / 编辑与列表三组 kbd 键帽;全局热键动态读取 `getHotkeys`(预览环境回退默认值)。
- `src/App.tsx`:主题状态提升到 App(ThemeToggle 改为受控);新增 paletteOpen / cheatsheetOpen 并纳入 modalOpen 与 Ctrl+N/F 守卫;Ctrl+K / `?` 新增窗口级监听(IME 组字守卫);设置关闭后重新加载热键;命令动作复用现有回调(startNew / newFromClipboard / handleImportPick / handleExport / toggleTrash / setSortMode / setSettingsOpen / toggleTheme)。
- `src/util.ts` 新增 `formatHotkey`,设置弹窗改用同一格式化函数,三处展示一致。
**验证**:`tsc` 零错误;构建 + 冒烟通过;预览页断言:Ctrl+K 打开(11 条 / 3 组)、「排序」过滤 3 条并高亮、↓ + Enter 切换排序(recent)、主题命令切换成功、速查表命令与 `?` 均能打开/关闭、面板内 Ctrl+K 关闭、面板打开时 Ctrl+N / Ctrl+A 不生效、设置打开时 Ctrl+K / `?` 不响应;暗色视觉核对通过。
**修正**:测试发现面板 Esc 原只绑在输入框,已补窗口级监听(焦点离开输入框仍可关闭)。

#### S4 占位符弹窗实时预览 + Tab 跳转(成本 S,消除不确定性)
**现状**:只有输入框;`lastValues` 预填已有。
**目标**:弹窗下半区实时渲染**填充后的完整文本**(变量替换为输入值,空值保持 `{{变量}}` 原样);`Tab`/`Shift+Tab` 在变量间移动;`Ctrl+Enter` 直接复制。
**验收**:边输入边预览;预填值参与预览;无变量时行为不变。

### A 级(小成本高感知,任选)

- [ ] **A1 搜索命中片段 + 高亮**(主窗口):标题命中高亮;正文命中时行下加一行片段;与 S1 共用匹配器。
- [ ] **A2 复制按钮 morph**:复制成功后图标 copy→✓ 1.2s 复原(目前无 IconCheck)。
- [ ] **A3 遮罩模糊**:`.overlay` 增加 `backdrop-filter: blur(8px)`,配合现有淡入。
- [x] **A4 列表→详情级联淡入**:详情内容按 20ms 阶梯淡入(纯 CSS animation-delay)。已修复 `1b1fffd`:视图分支 `.detail-inner.stagger` + `key={item.id}` 重放,20ms 阶梯 / 260ms ease;编辑与空态不参与;`prefers-reduced-motion` 下动画延迟归零。
- [ ] **A5 列表右键菜单**:复制 / 编辑 / 置顶 / 移入回收站 / 导出此条。
- [ ] **A6 标签稳定配色**:tag 字符串 hash → 8–12 个柔和色相,light/dark 两套 alpha;列表与详情同 tag 同色。
- [x] **A7 首次启动引导**:空态 3 步卡片(收集 / 试占位符 / 随叫随到),可跳过;已修复 `001f362`。触发条件为「无收藏(不含回收站)且未置位 localStorage `pv-onboarded`」;任意新建保存成功也置位;示例条目带「示例」标签与「引导示例」来源;热键从配置动态读取;`?empty=1` 预览夹具可复现空态;窄窗(≤980px)单列堆叠。
- [x] **A8 主窗口键盘闭环**:主列表 ↑↓/Home/End 选择(clamp 不循环)、Enter 复制活动项(无活动项先选中首条不复制)、Ctrl+E 编辑(回收站 no-op)、Space 勾选、Esc 分层退出(编辑态退出并回焦搜索 / 清多选);搜索框 combobox 语义(aria-activedescendant)+ 列表 listbox/roving tabindex + 滚动跟随;IME 与弹层守卫;排序下拉聚焦时 Esc 不再误清多选;零新增常驻 UI。提交 `162b760`。
- [x] **导入合并预览**(新增/更新计数)——已有。

### 不建议做(避免炫技翻车)

- 全屏 FLIP 共享元素动画(WebView2 合成层易闪,收益/风险比差);
- 全站玻璃拟态(可读性灾难);
- 音效 / 粒子 / 彩带庆祝、启动闪屏(廉价感 + 冷启动负担);
- 虚拟滚动(数据量到不了:几千条以上再评估 SQLite+FTS5 时一并考虑)。

---

## P2 · 工程与发布

- [ ] 数据量过千后评估 SQLite + FTS5(当前单 JSON 完全够,不要提前迁移);
- [ ] 版本节奏:功能批次后升 0.1.x,重大 UI 批次升 0.2.0;可选 CHANGELOG;
- [ ] **发布 v0.1.9**(`1b1fffd` 已升版本并构建):上传 Release、更新 README 下载资产名(`PromptVault-0.1.9-*`),当前 README 仍指向 v0.1.0;
- [ ] 自动更新:设计上不做(更新 = 重新构建发布);
- [ ] NSIS 构建依赖 GitHub 下载(本机已缓存;换机需镜像/代理,失败重试同命令)。

---

## 建议实施批次

1. **第一批(约半天)**:P0-1 IME + P0-2 重截图 + A2 / A3 / A6;
2. **第二批(2–3 天)**:S1 QuickPick 2.0 + A1(共用匹配器);
3. **第三批(1–2 天)**:S4 + A4 / A5 / A7;
4. ~~第四批:S3 命令面板 + 速查表~~ —— 已完成(`62a6a51`);
5. ~~第五批:S2 Mica~~ —— 2026-10-29 决定不做。

已完成:P0-1、P0-2、S1、S3(见上文勾选)。

---

## 动手前的硬性约束

1. 界面中文;颜色只用 `src/App.css` 的 CSS token(`:root` 与 `[data-theme="dark"]` 两套),禁止硬编码颜色;
2. 图标只用 `src/components/icons.tsx` 的内联 SVG,不引入图标库或 UI 框架;
3. 数据是单个 JSON;写盘必须复用现有原子写实现(临时文件 + MoveFileEx + `.bak`);新字段一律可选,`coerceItems` 必须兼容旧数据;
4. 前端改完跑 `npx tsc --noEmit`(严格模式,`noUnusedLocals`);构建 `npm run tauri build`(NSIS 下载偶发超时,重试同一命令);
5. 构建后刷新 `releases/` 两份 exe 并冒烟启动;同步 README 功能表与路线图;
6. 改 UI 可先用 `npx vite --config preview/vite.preview.config.ts` 在浏览器预览(mock 掉了 Tauri API);QuickPick 窗口只有 `npm run tauri dev` 才能看到。
