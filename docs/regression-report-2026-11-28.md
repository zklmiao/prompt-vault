# v0.1.9.3 正式版回归测试报告

> 日期:2026-11-28。对象:tag `v0.1.9.3`(清单 semver `0.1.9`,显示 v0.1.9.3)。
> 相对 v0.1.9.3-alpha(`1728e1b`)的增量:审计修复 backport(L1 `b153a40`、L7 `3a13497`、M2 `bfd337d`,均带 `-x` 来源记录)+ 版本转正 + 文档同步。
> 执行分层沿用 `docs/regression-tests.md`:L0 静态 / L1 单元 / L2 浏览器 / L3 构建 / L4 打包冒烟。

## 结论

**全部通过,具备发布条件。** 无新增缺陷;一项环境观察(单实例顶出)确认为设计行为,非缺陷。

## L0 · 静态检查

| 项 | 结果 |
|---|---|
| `npx tsc --noEmit`(严格模式) | 零错误 |
| `cargo check --all-targets` | 零警告 |

## L1 · 单元测试

| 套件 | 结果 |
|---|---|
| `node --experimental-strip-types regression/util.test.ts`(数据纠偏/占位符/模糊匹配/热键格式化/IME 判定) | **29/29 通过** |
| `cargo test`(lib.rs 单测) | **9/9 通过**(alpha 基线 7 + L7 新增 `first_run_default_under_three_tier_fallback` 三级回退 + L1 新增原子写测试) |

## L2 · 浏览器功能回归(preview 夹具 + 浏览器自动化,127.0.0.1:4173)

本轮重点覆盖:三笔 backport 的行为面(M2 保存合并、L7 影响的启动路径提示)与 0.1.9.3-alpha 之后的界面增量(A9/A10 所属面),并对既有核心流抽样回归。全部取得真实证据(DOM 文本 / mock 磁盘 JSON / 剪贴板夹具 / localStorage):

| # | 用例 | 结果 | 关键证据 |
|---|---|---|---|
| 1 | A9 侧栏底部常驻快捷键提示 | ✅ | 快照含 `Ctrl+K 命令面板 · ? 速查表` |
| 2 | **M2 编辑保存前重读磁盘合并**(核心修复) | ✅ | 编辑「代码审查助手」改标题,编辑期间向 mock 磁盘注入外部条目 `ext-1`(模拟 MCP save_prompt),保存后:总数 9(外部新增保留)、新标题落盘、`copyCount=12`/`lastCopiedAt`/正文完整保留 |
| 3 | 新建(Ctrl+N)保存 + new 分支合并基线 | ✅ | 新建「键盘直复测试」后总数 9、种子 8 条无损(磁盘基线 + 新条目) |
| 4 | 复制统计(占位符填写路径) | ✅ | 「翻译润色」填 `{{text}}` 复制:`copyCount 5→6`、`lastCopiedAt` 落盘、`lastValues.text` 预填记忆、剪贴板内容变量已填充、toast「已复制到剪贴板(变量已填充)」 |
| 5 | 回收站闭环(软删→恢复) | ✅ | 软删后 `deletedAt` 落盘、回收站视图 1 条含删除时间;恢复后 `deletedAt` 清除、回主列表、toast「已恢复」 |
| 6 | 命令面板 Ctrl+K 开/执行/关/互斥(M8) | ✅ | 执行「打开回收站」→ 面板卸载(`qpInDom=false`)、视图切至回收站、重开面板后命令标签互斥为「返回收藏列表」 |
| 7 | 主窗口键盘闭环(A8) | ✅ | ↑↓/Home 移动活动项(`aria-activedescendant` 逐步验证);Enter:带变量条目弹填写窗、无变量条目直复(`copyCount 0→1` + 剪贴板 + toast);Esc 分层退出弹窗 |
| 8 | IME 组字守卫(P0-1) | ✅ | 同一输入框对照:合成 `keyCode 229` Enter 不上屏标签、合成 `keyCode 13` 与真实键 Enter 均上屏(守卫精确区分组字/非组字,非「一刀切吞 Enter」) |
| 9 | 主题切换与持久化 | ✅ | 暗→亮→暗往返,`data-theme` 与 `localStorage pv-theme` 同步 |
| 10 | 空态引导(A7) | ✅ | `?empty=1`:0 条空态文案;清 `pv-onboarded` 后三步引导完整呈现(收集/试占位符/随叫随到),跳过后置位不再复现 |
| 11 | 快捷键速查表(`?`) | ✅ | 非输入态 `?` 开启(全局/窗口/主列表/编辑与列表 4 分组),Esc 关闭 |

**执行备注(如实记录)**:
- 用例 6 首轮出现过一次「执行后面板仍在」的观察噪声;干净复现(复位→开→执行→500ms)证明面板按 `closeThen` 语义即时卸载,判定为后台标签页渲染节流的观察假象,非产品缺陷。
- 用例 11 首轮在搜索框聚焦时按 `?` 被当作搜索词输入(`typing` 守卫按设计拦截速查表触发);改在非输入态派发后按预期开启——该守卫行为与代码 `!typing` 条件一致。

## L3 · 构建验证

| 项 | 结果 |
|---|---|
| `npm run tauri build`(含 beforeBuildCommand `tsc && vite build`) | exit 0 |
| 前端产物 | 49 modules,dist JS 305.78 kB(gzip 93.02 kB) |
| Rust release | `prompt-vault v0.1.9` 3m59s 编译完成 |
| NSIS 安装包 | `Prompt Vault_0.1.9_x64-setup.exe`(1.61 MiB) |

## L4 · 打包冒烟

- 产物归档:`releases/PromptVault-0.1.9.3-portable.exe`(5,168,640 B)、`releases/PromptVault-0.1.9.3-setup.exe`(1,692,299 B),另按仓库约定复制 `PromptVault-便携版.exe` / `PromptVault-安装包.exe`。
- 冒烟:启动 `PromptVault-0.1.9.3-portable.exe` → 6 秒后进程存活、主窗口已创建(`SMOKE-ALIVE pid=424 title="Prompt Vault"`),随后结束进程。
- **单实例行为观察(设计行为,非缺陷)**:冒烟前用户正运行旧版便携实例,新实例启动即被单实例机制(`tauri_plugin_single_instance`,lib.rs:579)顶出、exit code 0——与已知良好的 alpha 版在同一环境下行为完全一致;结束旧实例后新版正常常驻。

## 安全审计(Mimosa,static-only)

- 深度扫描两轮:首轮于 backport 前(0 findings,`scan-2026-11-27T23-03-07.147Z-8f4428f3d720`);**终扫于发布提交(即本报告所在提交)之后的同一代码状态**:0 findings,依赖 524 包扫描、0 命中已知通告,scanId `scan-2026-11-27T23-30-16.033Z-28b139509d81`,seal `sha256:9de58a0ca88359d3baaf961833fd454a52849921b1a724a5e5dfd9e05396f3a9`。

## 已知残留(留档,不阻塞)

- M2 修复后的重读→写盘间仍存在毫秒级并发窗口,彻底闭合需 Rust 锁内读改写命令(原提交已留档,窗口较修复前缩小 4–6 个数量级)。
- 真实全局热键、托盘交互、窗口位置记忆、真实 IME、真实文件对话框等仅可人工验证项未在本轮覆盖(沿用 0.1.9 系列两轮预发布的人工验证结论;本轮无相关代码变更)。
