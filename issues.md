# issues.md — 问题记录

> 由 2026-10-29 全量回归测试发现并登记(v0.1.9 @ `36d0e5b`)。
> 测试计划见 `docs/regression-tests.md`,完整结果见回归测试报告。
> 约定:每条含「现象与证据 / 根因 / 影响面 / 修复方案」,修复后请勾选并注明提交号。

## REG-01 ❌ 级联淡入动画滞留 `getAnimations()`,阻碍自动化与可测试性

- **现象与证据**:详情面板(A4 `.detail-inner.stagger`)动画完全播放结束后,`document.getAnimations()` 仍永久返回 6 个 `finished` 状态的 Animation 对象。浏览器自动化(Playwright 系包装)在动画容器内点击会等待动画清空而超时(实测 3000ms),尽管点击本身已生效(两次复现:点击「编辑」超时但编辑态已打开)。
- **根因**:`src/App.css` 第 565 行 `animation: pv-detail-in 0.26s ease forwards` 使用 `fill: forwards`。按 Web Animations 规范,带 forwards 填充的已结束动画永远处于"relevant"状态,不会从 `getAnimations()` 移除;而 keyframes 的终止态与自然态相同,forwards 填充实际多余。
- **影响面**:真实用户无感知;影响一切依赖 Web Animations API 的工具(E2E 测试、截图稳定化、动画埋点)。这也是本次回归中唯一反复拖慢测试执行的因素。
- **修复方案**(纯 CSS,零行为变化):`pv-detail-in` keyframes 只保留 `from`(不写 `to`,让终止态回归自然态),并把 `forwards` 改为 `backwards`(保证 delay 期间保持起始态):

  ```css
  @keyframes pv-detail-in {
    from { opacity: 0; transform: translateY(8px); }
  }
  .detail-inner.stagger > * {
    animation: pv-detail-in 0.26s ease backwards;  /* 原 forwards */
  }
  ```

  改完后 `document.getAnimations()` 在动画结束即清空。
- **状态**:待修复。

## REG-02 ❌ 编辑器「备注 / 来源」字段按 Ctrl+Enter 不保存,与快捷键速查表宣称不一致

- **现象与证据**:在编辑器的备注 textarea 中按 Ctrl+Enter 无任何反应(实测事件已到达目标元素:key=`Enter`、`ctrlKey=true`、`isComposing=false`、`isTrusted=true`,但 900ms 内无 toast、无 `write_data`、仍处编辑态);同一编辑器中标题输入框与正文 textarea 按 Ctrl+Enter 可正常保存。`CheatsheetModal` 窗口组宣称「Ctrl+Enter 保存编辑」,README 快捷键表同,均无字段限定。
- **根因**:`src/components/DetailPane.tsx` 的 `Editor` 组件中,`onKeyDown={ctrlEnter}` 只挂在标题 `<input>` 与正文 `<textarea.mono>` 上(第 311、356 行),备注 `<textarea>`(第 335 行)与来源 `<input>`(第 326 行)漏挂。属实现疏漏而非设计——同一编辑器内行为不一致。
- **影响面**:用户在备注/来源字段按 Ctrl+Enter 期望保存而静默失败;与文档承诺不符。
- **修复方案**:给备注 textarea 与来源 input 补 `onKeyDown={ctrlEnter}`;更稳妥的做法是在 `Editor` 的 `<section>` 容器层统一监听一次(避免未来新增字段再漏)。
- **状态**:待修复。

## REG-03 ⚠️ 复制反馈文案在「0 个变量被填充」时仍显示“已填充”,表述误导

- **现象与证据**:
  - 主窗口:带变量条目在弹窗中全部留空复制,toast 显示「已复制到剪贴板(变量已填充)」——实际一个变量都没填(剪贴板内容仍是 `{{diff}}` 原样,已实测确认复制语义本身正确);
  - 快速拾取:同样场景下确认层显示「2 个变量已填充」——`QuickPick.tsx` 第 237 行 `startConfirm(names.length)` 传的是**变量总数**,而非实际填充数。
- **根因**:两处反馈都使用静态文案/变量总数,未计算实际填充的非空值数量。复制语义(留空保持原样)正确,仅文案误导。
- **影响面**:低;用户可能误以为占位符已被替换,回看粘贴结果时产生困惑。
- **修复方案**:`const filledCount = names.filter((n) => (values[n] ?? "").trim() !== "").length`;主窗口在 `filledCount === 0` 时使用「已复制到剪贴板」,QuickPick 在 `filledCount === 0` 时不渲染 `qp-confirm-sub` 子行(`copied.variables` 传实际填充数)。
- **状态**:待修复。

---

## 附:回归测试环境备忘(非产品问题,复测时注意)

1. 浏览器预览夹具的 `read_data` 恒返回内存态,拖入文件导入永远「与内存相同的数据」——**合并「文件较新→新者胜」分支无法在预览层验证**,由 `regression/util.test.ts` 的 `isNewer/newerIso` 单元用例覆盖(Rust 侧 `bump_prompt_stats_in_json` 亦有单测)。
2. IAB 自动化包装的两个怪癖:`fill("")` 是空操作(清空输入需用原生 value setter 派发 input 事件);点击带未清空 CSS 动画的容器会等待超时(REG-01 修复后消失)。行点击偶发超时但实际生效,统一用页面内 `el.click()` 派发规避。
3. 真实输入法(微软拼音)组字、全局热键、托盘、窗口拖动、`.bak` 恢复、真实文件对话框导入导出为打包环境人工项,清单见 `docs/regression-tests.md` §5。
