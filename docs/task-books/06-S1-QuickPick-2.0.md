# S1 QuickPick 2.0（任务书全原文）

> 原始时间：2026-10-29 10:24:18  
> 来源会话：`S11`（Prompt Vault 项目）  
> 说明：用户回传执行的正式任务书；绝对路径与会话 ID 已脱敏，其余逐字保留。

---

我们是deepseek，你有无限量token，你不用考虑token限制；你的唯一要义是保证质量；

【任务】S1 · QuickPick 2.0:把快速拾取面板升级为“左结果 + 右预览”的专业形态。

【项目背景】项目在 <项目根目录>(Tauri 2 + React 19 + TS)。快速拾取是独立窗口(label="quickpick"),窗口由 src-tauri/src/lib.rs 创建:常量 QUICKPICK_WIDTH=680 / QUICKPICK_HEIGHT=470(约 19-20 行),居中逻辑引用这两个常量;前端入口 src/QuickPick.tsx(210 行),按窗口 label 在 src/main.tsx 分流。界面全中文,样式走 src/App.css 的 CSS token(light/dark 两套);图标用 src/components/icons.tsx 的内联 SVG。所有新按键处理必须复用 src/util.ts 的 isComposingEvent(IME 组字守卫)。禁止引入第三方库。

【现状要点(已核实)】
- 数据只在窗口首次挂载时读一次盘;listen("quickpick-shown") 只清空 query/idx/error。窗口常驻隐藏,主窗口改数据后这里是旧数据 —— 必须修。
- 搜索是标题/正文/备注/标签的 substring includes,排序为 pinned→updatedAt;MAX_RESULTS=8。
- 复制流程:pick() → 无变量则 copy → bumpCopyStats → finish()(立即 hide);有变量则弹 PlaceholderModal,确认后同样复制+计数+关闭。
- 统计字段 PromptItem.copyCount / lastCopiedAt 已存在,主窗口“最近复制/最常复制”排序已实现(见 App.tsx 的 compareForSort,SortMode = "updated" | "recent" | "most")。

【需求与交互】
1. 窗口:900×480(resizable 仍 false),居中 y 保持 120;结果列固定约 360px,右侧预览自适应;Rust 常量与 CSS 同步修改。
2. 每次面板显示时重新读盘:把数据加载抽成 loadData(),在挂载时与 listen("quickpick-shown") 时都调用(失败仅显示错误行,不崩溃)。
3. 模糊搜索(与主窗口共用):在 src/util.ts 新增并导出
   - export interface MatchRange { start: number; end: number }
   - export interface FuzzyMatch { score: number; ranges: MatchRange[] }
   - export function fuzzyMatch(query: string, text: string): FuzzyMatch | null
   - export interface PromptMatch { score: number; title: FuzzyMatch | null; tags: (FuzzyMatch | null)[]; bodySnippet: { text: string; ranges: MatchRange[] } | null }
   - export function matchPrompt(query: string, item: PromptItem): PromptMatch | null
   算法:大小写不敏感;query 每个字符按顺序在 text 中出现即为命中(子序列),连续命中加分、词首(空格/标点/# 后)加分、完整子串额外加分;字段权重 title×3、每个 tag×2(取最高)、source×1.5、note×1、body×1,总分交给排序。中文按字符匹配即可,不做拼音(明确不做)。
   主窗口 App.tsx 的搜索过滤改为使用 matchPrompt(保留 activeTag 过滤;有关键词时按 score 降序、pinned 作为并列优先,无关键词时仍按原 sortMode)。
4. 命中高亮:新增 src/components/Highlight.tsx(接收 text 与 ranges,用 `<mark className="hl">` 包裹命中段;ranges 需合并相邻区间)。结果行标题、标签使用高亮;空 query 不高亮。CSS 增加 `.hl` 样式(accent-soft 背景 + accent 文字,圆角 2px)。
5. 正文命中片段:仅当标题/标签未命中而正文命中时,在结果行第二行显示片段:首个命中位置前 ~24 字符、后 ~40 字符,换行折叠为空格,首尾加省略号,片段内命中高亮。
6. 右预览面板(选中项):标题、标签胶囊(TagChips)、来源/备注(有才显示)、正文用 BodyText 渲染(占位符胶囊高亮,长文 overflow-y auto)、底部一行「已复制 N 次 · 最近 …」(使用现有 formatDate)。预览只读,不出现按钮。
7. 空查询状态:显示两个分区「最近复制」(按 lastCopiedAt 降序取前 5)与「最常复制」(按 copyCount 降序取前 5,**排除已在最近复制中出现的项**)。分区标题不可选中;键盘 ↑↓ 在扁平化后的条目上循环。若两项都没有数据,回退为当前的「置顶 + 最近更新」列表。有 query 时只显示搜索结果。
8. 底栏快捷键提示(静态):`↩ 复制 · Tab 编辑 · Esc 关闭`,小号 muted 文本,面板底部固定。
9. Tab 编辑:按下 Tab(非组字)时,
   - 新增 Rust 命令 `open_editor(id: String)`:show_main_window 的主窗口逻辑 + emit_to("main", "open-editor", id);
   - App.tsx 新增 listen("open-editor", id):await refreshFromDisk(),若条目仍存在且未删除则 setTrashOpen(false)、setSelectedId(id)、setMode({kind:"edit", id});否则 toast「该条目已不存在」;
   - quickpick 调用后立即 hide。
10. 复制确认态:复制成功后不立即隐藏,面板进入确认态(输入框禁用;居中显示 ✓ 已复制;若经过占位符填写则附「N 个变量已填充」),420ms 后调用 hideQuickpick。确认态期间:Esc 立即隐藏;Enter 忽略;窗口失焦仍由 Rust 直接隐藏(Rust 逻辑不改)。复制失败不进入确认态,沿用现有错误行。
11. 占位符路径:PlaceholderModal 的确认回调里同样走「复制 → bump → 确认态」;确认态文案带变量数。

【实现约束】
- 所有新 keydown 最先调用 isComposingEvent(e) 并 return。
- 不改变 ⌘/Ctrl 语义;不新增全局热键。
- 主窗口搜索的 UI 不变(本条不做命中高亮/片段,那是 A1 的范围);只切换匹配算法。
- 预览列高度受限时正文滚动,不要撑破窗口。

【边界与异常】
- 数据文件被删/解析失败:错误行提示,列表为空,Esc 可关。
- 面板隐藏再打开:query 清空、idx 归零,数据重新读盘。
- 搜索无结果:显示「没有匹配的 prompt」,不显示预览。
- 复制后 420ms 内再次按 Alt+Q(重新显示):按现有 quickpick-shown 逻辑重置,不得残留确认态。
- 长标题/长标签:结果行 ellipsis;预览标题换行。

【验收标准】
1. npx tsc --noEmit 零错误;npm run tauri build 成功;releases/ 两份产物刷新并冒烟启动。
2. 打包 exe / npm run tauri dev 人工验证:
   a. Alt+Q 打开 → 900×480 双栏,右预览随 ↑↓ 实时变化,正文占位符为胶囊;
   b. 输入中文/英文子序列(如「代码审」「dmz」不要求)命中并高亮;正文命中显示片段;
   c. 空查询显示最近复制/最常复制两段,无重复项;↑↓ 跨段循环正常;
   d. Enter 复制 → 面板显示 ✓ 约 0.4s 后自动隐藏;带变量条目弹窗填写后同样确认态且文案含变量数;
   e. Tab 跳到主窗口并进入该条编辑态;Esc 关闭;点其他窗口失焦即隐藏;
   f. 在主窗口修改一条数据后再次 Alt+Q,列表为最新数据。
3. 主窗口搜索仍可用,且「顺序输入的子串」优先命中;筛选计数正常。
4. README 功能表「快速拾取」行与快捷键表补充(Tab 编辑、模糊搜索、预览);docs/backlog.md 的 S1 标记 [x] 并注明提交号。

【交付】
- 构建产物 + README/backlog 更新;建议 commit:feat: QuickPick 2.0 双栏预览与模糊搜索。
