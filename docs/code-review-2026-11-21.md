# 深度代码审查报告 — 潜在风险与缺陷清单

> 审查日期:2026-11-21。审查基线:`feat/plugin-system` @ `b97a5a5`(便携版通知 AUMID 修复)。
> 范围:全量功能逻辑链(Rust 6 模块 7747 行 + 前端 ~9000 行 + token-monitor 插件 1857 行),
> 覆盖安装管线 / 网络代理与凭据 / MCP Server / 数据原子写与跨进程锁 / 注入引擎与桥 /
> 多账号告警 / i18n / 彩蛋与 UI 打磨新提交(a9af74b 之后 4 个提交)。
> 方法:全文精读 + 链路追踪 + 边界枚举 + 独立动态复验(cargo test 133 全绿、tsc 零错误、
> node 回归 29+6+10 全过、main.js 语法通过——均为审查期间实跑)。
> 分级:🔴 高危(需尽快修)/ 🟠 中危(下个批次修)/ 🟡 低危(择机修)/ ℹ️ 信息。

---

## 🔴 H1 · 安装管线:清单版本串路径穿越 → 沙箱外任意文件写

> **状态:已修复(ab87eb1,修复卡 L)**——parse_channel_ref / install_from_bytes / resolve_version_dir 三校验点收严严格 semver(契约收紧:市场版本从此要求严格 semver,先例 1.0.0/1.1.2/1.2.0 全合规);穿越三形态+污染指针+清单契约三条单测转绿,136 passed 零回退。

**位置**:`src-tauri/src/plugins.rs:898`
`let target = root.store_dir(expect_id).join(expect_version);`

**链条(已逐环核实)**:
1. 市场清单条目的 `channels.release.version` 经 `parse_channel_ref`(:437-453)——**只查非空
   与 url 前缀,版本串形状零校验**;
2. PluginHub `doInstall` 把该值原样传入 `plugin_install` 命令(:1101-1124)——命令层校验了
   channel / expect_id / sha256 形状,**唯独没有 expect_version**;
3. `install_from_bytes`(:815)要求 zip 内 manifest 的 `version` 与 expect_version **逐字一致**
   (:874)——恶意源对两者同时控制,一致性约束形同虚设;
4. `minAppVersion` 门(:879-885)**只在字段存在时校验 minAppVersion 本身**,既不约束
   version,字段缺失时整个门被跳过;
5. `store_dir(id).join(expect_version)`:`PathBuf::join` 对绝对路径**整体替换基路径**,
   相对路径 `..` 逐级逃逸;`extract_plugin_zip` 随后把条目写进该 dest;
6. 污染持续化:`set_current_version` 把版本串原样写进 `current` 指针 →
   `resolve_version_dir`(:122)读指针 join 后 `.is_dir()` 命中 → **跨重启**的
   `plugin_read_entry` / `plugin_installed_manifest` 继续从穿越目录读文件(注入源)。

**影响**:恶意(或被攻陷的)受信源——用户添加源是显式动作且会过权限确认弹窗——在
市场点击安装时即可向**用户可写的任意路径**写文件。实际利用路径已推演:
从 `store\<id>\` 起 5 层 `..` 抵达 `%APPDATA%`,拼接 `Microsoft\Windows\Start Menu\Programs\`
即登录自启动目录(**持久化代码执行**);绝对路径版本串(`join` 语义)可直接覆盖任意
用户可写文件。zip-slip 防护(safe_rel_path)保护的是**条目相对 dest** 的维度,dest 本身
被穿越后全部失效——这是 D5「sha256 + 沙箱」承诺的破口。

**修复**(小改,机械全部就绪):
1. `install_from_bytes` 在 :898 之前强制 `parse_semver(manifest_version)` 成功
   (机械已存在,:146;拒绝即 Err,同时消除 expect_version 的 taint——两者已断言相等);
2. `parse_channel_ref` 跳过 version 非 semver 的条目(坏条目不拖垮清单,既有模式);
3. `resolve_version_dir` 对 `current` 内容做同一校验(防已落盘的污染指针跨重启命中);
4. 单测向量:`version: "../../evil"`、`version: "C:\\x"`、`version: "1.0.0/../../x"`
   三类均应拒绝且不落盘(现有 `install_rejects_id_version_mismatch` 只用了合法版本
   "2.0.0",恶意形状无覆盖——这是该洞漏网的直接原因)。

**触发条件**:用户添加恶意源 → 市场安装该条目。无需任何其它前提。

---

## 🟠 M1 · 核心数据命令无调用者校验:插件窗口可任意读写用户文件

**位置**:`src-tauri/src/lib.rs` —— `read_data`(:310)、`write_data`(:404)、
`set_data_path`(:251)、`path_meta`(:477)、`restore_backup`(:459)、
`bump_copy_stats`(:444)、`set_hotkeys`(:275)——均无 `window` 参数与调用者校验。

**链条**:Tauri v2 自研命令不经 capability ACL(仓库内注释自证:plugin_start_drag
「自定义命令不经 capability 校验」)→ `pv-plugin-*` 插件窗口可绕桥直调上述全部命令。
批次 4 的调用者校验加固(ensure_caller_main / self_or_main / plugin_window)覆盖了
全部 `plugin_*` 命令,但**核心数据命令被明确豁免**(卡 K v2 §2.2:「main/quickpick
都在调,保持原样」)——豁免面写宽了:插件窗口既不是 main 也不是 quickpick。

**影响**(恶意插件窗口):
- `read_data(任意路径)` → **任意文件读取**,内容返回给插件 JS(用户文件、其它
  应用配置——keyring 不落盘不受影响,但磁盘上一切明文敏感文件可读);
- `write_data(任意路径, 内容)` → **任意文件写**(覆盖用户可写的任何文件);
- `set_data_path(任意串)` → 重写 config.json 的 data_path(配合上述两者);
- `restore_backup(path)` → 用 `path.bak` 覆盖 `path`(组合滥用);
- `bump_copy_stats` / `set_hotkeys` / `path_meta` → 次级滥用面。

**修复**(机械性,与既有 helper 同模式):新 helper
`ensure_caller_host(label)`(仅 `main` / `quickpick` 放行——合法调用方恰是这两窗),
套到上述 7 条命令。quickpick 实际调用面:`read_data` / `bump_copy_stats` /
`hide_quickpick` / `open_editor` / `open_new`;main 调全部。
**注意**:`first_run_default` / `get_hotkeys` / `open_*` / `win_*` / `hide_quickpick`
属无害或宿主窗口控制,可一并收进 host 门或保持开放(建议前者,一致性)。

---

## 🟠 M2 · 编辑态保存会抹掉外部新增(MCP save_prompt 数据丢失)

> **状态:已修复(333599d,修复卡 M)**——handleSave 保存前重读磁盘按 id 合并(new 分支外部新增天然保留;edit 分支 draft 盖在磁盘条目上保住统计/软删字段;读盘失败回退内存全量写)。已知残留:重读→写盘毫秒级窗口(需 Rust 锁内读改写命令,留档)。

**位置**:`src/App.tsx:475-478`(data-changed 守卫)+ `:932-958`(handleSave persist)。

**链条**:data-changed 守卫在编辑态跳过刷新(`modeRef.current.kind !== "view"` return)
——设计意图是防打断草稿,正确;但下一步用户**保存**时 `handleSave` 用内存 `items`
(缺外部新增)做 `persist(items.map(...))` 全量覆写 → 编辑期间 MCP 客户端经
`save_prompt` 新增的条目被**静默抹除**。触发链:编辑中 → MCP save_prompt(守卫跳过)
→ 用户 Ctrl+Enter 保存 → P 消失。

**缓解**(已存在):write_atomic 落盘前自动 `.bak` —— 被抹前的文件在 `.bak` 可人工恢复。
**修复建议**:(a) 保存前重读磁盘按 id 合并(新增保留、本条按 updatedAt 新者胜),
或 (b) 编辑态下检测到 data-changed 时把「外部变更待合并」状态提示用户。
同模式潜在面:QuickPick 的 stats-changed 无守卫但只动统计字段(已核验无丢失)。

---

## 🟠 M3 · 通知状态机的过期缓存误报窗口(重启 + 首次通知失败前置)

> **状态:已修复(f32b8f5,修复卡 L)**——maybeNotifyFor 增 resetAt ≤ now 守卫(宁漏勿扰);夹具新增「时效自检」回归 + 通知自检 8 断言零回归。

**位置**:`plugins-src/token-monitor/main.js:1165-1189`(maybeNotify)。

**链条**:通知失败(如 AUMID 修复前的 Windows 静默丢弃、瞬时网络/桥错误)→
状态不写(宁重勿漏)→ 用户重启应用 → 球载入**过期 cache**(上一窗口的 90%,
resetAt 已过)→ `isBallAlerting()` 为真(纯派生不判时效)→ `maybeNotify`:
state 缺失 → **基于过期数据发真实通知**(当前实际用量可能已因窗口重置归零)。
去重键(resetAt)在「state 缺失」分支不设防。徽标/脉冲同理短暂误显(约 1 次
取数周期,轻微)。

**修复**(一行):`maybeNotify` 增加 `resetAt 过去时 → return`(窗口已结束的数据
不触发通知;`new Date(resetAt).getTime() <= Date.now()` 即视为过期)。UI 层徽标
保持现状(短暂显示后由首刷纠正,可接受)。

---

## 🟡 低危 / 信息

- **L1 · `write_config` 非原子**(lib.rs:91 `fs::write`):set_data_path / set_hotkeys
  落盘 config.json 无临时文件+替换;崩溃窗口内截断 → data_path/hotkeys 丢失回默认
  (数据文件本体无恙但**链接丢失**,需重走首启动选择)。修复:复用 write_atomic
  (并加 .bak)。同族:set_hotkeys 失败回滚逻辑依赖 write_config 成功,链路一致性随之改善。
  **状态:已修复(89f9f06,修复卡 M)**——write_config_to 注入形 + write_atomic;.bak 断言测试转绿。
- **L2 · MCP save_prompt 无字段上限**(mcp/data.rs:149):title/body/tags 无长度约束,
  异常 MCP 客户端可写超大连条目(数据文件膨胀)。建议 title≤200、body≤100KB、
  tags≤32 项×32 字符,超限以 isError 结果回包。
- **L3 · pv.notify 无 Rust 侧速率限制**:双闸(桥 manifest 快照 + 命令层)之后,
  持有 notify 权限的插件以高频循环调用即每秒一条系统通知。当前状态机(每窗口一条)
  是行为约束非强制。可选:Rust 侧 per-plugin 最小间隔(如 10s)令牌桶。
- **L4 · 球轮询 tick 逐账号探测 keyring**(main.js:739-748 probeConfiguredAccounts):
  每 tick(≥120s)对每账号做 Windows 凭据管理器读(毫秒级);量小但属常驻 IO。
  可选:configured 态短缓存(如 30s)。
- **L5 · AUMID COM 初始化不配对 CoUninitialize**(plugins.rs:1625-1628):S_OK 路径
  不调用;async 命令线程池复用下泄漏有界。注明即可,修复价值低。
- **L6 · 球窗位置恢复跨屏 DPI 换算用主窗 scale**(plugins.rs:1410-1415):记忆位置
  在另一块不同缩放的显示器上恢复会漂移。建议记录时附 monitor id 或按最近屏 scale。
- **L7 · `DEFAULT_DATA_PATH` 为开发机绝对路径**(lib.rs:31,`E:\Agent\Proj\…`):
  首启动对话框对其它用户建议无效路径(目录创建静默失败)。发布视角的可移植性债务;
  建议 `%USERPROFILE%\Documents\prompt-vault\prompts.json`(设计上有意,需共识后改)。
  **状态:已修复(e070dab,修复卡 M)**——常量已删除,first_run_default_under 三级回退
  (document_dir 优先,含 OneDrive 重定向);dev 冒烟确认对话框建议路径 = Documents 推导。
- **L8(信息)· 彩蛋摘要可被低熵密语爆破**:EGG_DIGEST 公开于仓库,密语若为常见
  短语可被字典攻击恢复。私人彩蛋威胁模型下可接受;密语保持高熵即可。
- **L9(信息)· 球窗全局 mousemove 常驻**(main.js:950):setupBall 在 window 上挂
  mousemove 不卸载(拖动分区判定),球窗常驻后台时每次鼠标移动进一次距离判断;
  成本可忽略,可在 dragState 置空后早退(已做)或挂/卸配对。

## ℹ️ 已知接受项(既往决策,汇总存档不再展开)

D1 主窗 webview 插件直调边界(docs §8 两维威胁模型);SSRF DNS rebinding TOCTOU
(net.rs 校验后 ureq 再解析);`plugin_credential_configured` 存在性布尔泄露(任意
插件窗可查任意 scope 配置态);球窗「隐藏」= 真关窗(设计 §2 措辞待修,行为已核验);
球窗冷启动初始尺寸 170×105 自愈;Mimosa 全量扫描欠账(3c80fee 之后全部提交);
issues.md REG-01/02/03 待修复;插件源 CDN ~5 分钟清单缓存;火山国际 region 灰区
未实测;`install_from_bytes` 同版本重装丢失回滚点(设计取舍)。

## ✅ 正面观察(值得保持的实践)

1. **测试文化**:三方契约样例断言(plugins/net/mcp 读端共享同一 JSON)、签名独立
   固定向量(node crypto 预计算防「抄答案」)、夹具自检带阴性对照(菜单收起修复的
   阴性对照旧代码报超时)、#[ignore] 人工确认测试(通知「静默丢弃 vs 真实显示」
   机器不可分——本次 AUMID bug 的根源,测试设计诚实直视)。
2. **失败语义文档化**:宁漏勿扰(resetAt 缺失不发)/宁重勿漏(通知失败不写状态)
   的每处取舍都有注释与依据。
3. **防御式解析全链一致**:coerceItems / parse_records / sanitizeAccounts /
   parse_source_manifest 的「坏数据跳过不拖垮宿主」语义贯穿。
4. **fix 提交的排查叙事**(b97a5a5 AUMID:红点有/消息无 → show() 返回 Ok 但系统
   静默丢弃 → 与「去重已写」交叉定位)是可复用的排查范式。

## 验证缺口(建议补齐)

- install_from_bytes 无恶意版本串向量(对应 H1,修复时一并补);
- 未测:多显示器不同缩放下的球窗位置恢复(L6);
- 未测:安装版(NSIS)通知可达性(L 级观察项,b97a5a5 后已大概率修复——AUMID
  快捷方式由 plugin_notify 运行时自建,安装版/便携版统一覆盖);
- main.js 无单元测试基建(夹具自检覆盖主链,纯函数已暴露给 node 回归,可继续下沉)。

## 修复优先级建议

1. **立即**:H1(三个校验点 + 三条单测,~1 小时工作量,堵 RCE 持久化口);
2. **下批次**:M1(ensure_caller_host + 7 命令签名)、M2(保存前合并)、
   M3(maybeNotify 时效一行)、L1(config 原子写);
3. **择机**:L2/L3/L4/L6/L7;L5/L8/L9 注记即可;
4. 合回 main 前:Mimosa 全量重扫(3c80fee 之后全部提交)+ 本报告 H1/M1 复验。

---

# 第二轮 · 定时用量监测数据流专项(2026-11-21 追加)

> 触发:用户问「数据有没有定时刷新,监控面板和悬浮球的数据有没有准时同步上」。
> 方法:代码链路追踪(逐行) + preview 夹具**动态对照实验**(真实渲染路径取证)。
> 结论先行:**悬浮球有定时刷新(但只刷当前账号);监控面板没有任何自动刷新,
> 打开期间球写入的新数据不会同步显示** —— 动态实验已证实。

## 数据流地图(谁在何时写/读 cache)

```
写入 cache:<provider>:<label>(kv.json,两 webview 唯一共享面):
  球实例  tick(每 intervalSec≥120s)→ fetchAndCache —— 仅「球当前账号」1 个
  面板实例 手动「全部刷新」/单卡「立即刷新」/添加账号时 —— 按动作
读取:
  球实例  renderBall 用内存 ballData(取数直供,球端显示是新鲜的)
  面板实例 renderPanelCards → readCache(kv 快照)—— 仅在 render()/用户动作时执行
```

## 本轮新发现

### 🔴 P1 · 监控面板数据不自动刷新(用户核心问题的直接答案)

> **状态:已修复(3f06960,修复卡 L,采纳方案 a 最小侵入)**——面板 render 内建模块级单定时器 30s 仅 readCache 重读(断连自清 + StrictMode 双调防护);伴生 P4 卡头「上次刷新」新鲜度行(zh/en 三档相对时间)。方案 b/c(挂载即取数、kv 写事件广播)未采纳,后者留档 P1-c 架构决策。

**证据(代码)**:
- 面板渲染唯一入口 `PanelHost`(PluginHub.tsx:988-996):`def.render()` 在
  `useEffect([pluginId])` 挂载时调用**一次**;
- 面板代码内**无任何数据定时器/变更监听**(main.js 全文唯一的 `setInterval` 在
  :1220,属球实例的 startPollIfEnabled,仅在球 webview 执行);
- `renderPanelCards`(:1741)只读 `readCache` 快照,不发起取数也不周期重读;
- 事件总线不跨窗口(registry.ts:138「仅主窗口 webview 内有效」),球写 cache
  无任何通道可通知面板。

**证据(动态对照实验,preview 夹具,2026-11-21 实测)**:
1. 打开面板:GLM 卡 5h = **23.5%**;
2. 模拟球 tick 写 cache:percent 23.5 → **77**(localStorage mock kv);
3. 等待 4s:面板仍显示 **23.5% ← 未同步**;
4. 切走页签再切回(PanelHost 重挂载 → render 重跑):显示 **77% ← 重挂载才同步**。
(实验后 mock kv 已还原,无残留。)

**影响**:面板页签开着的整个时段,卡片数值、告警胶囊、倒计时全部冻结在
打开时刻;球端数据再新也不会显示。用户刷新路径仅剩:切页签往返、点刷新按钮、
增删账号、改阈值(触发 renderPanelCards)。且面板打开时**只读 cache 不取数**,
打开瞬间看到的就可能是很久前的旧值(上次手动刷新/球轮换经过该账号的时间)。

**修复建议**(按侵入度递增):
- a(最小):面板 render 内加 `setInterval(readCache→renderPanelCards, 30s)`
  + 卸载时清理 —— cache 是球在写的,面板轮询重读即可「准同步」;
- b(较好):面板挂载时先逐账号 `fetchAndCache` 一次(打开即新鲜),再叠加 a;
- c(架构,可 v2):Rust 侧 kv 写事件广播(`kv-changed` emit 到两窗),双端订阅。

### 🟠 P2 · 轮询只监测球的「当前账号」,其余账号处于监测盲区

> **状态:已修复(aefcabb,修复卡 L)**——tick 改全账号串行轮转 + in-flight 重入守卫 + maybeNotifyFor 按账号传参;夹具新增「轮转自检」4 断言(双账号周期 + 守卫),既有四套自检零回归。

**证据**:tickBall(:1239-1254)→ `refreshBallData()` 只刷 `ballAccount`;
maybeNotify 也只对当前账号评估。N 个账号任意时刻只有 1 个在被定时监测,
其余账号 cache 与告警评估停留在「球上次轮换到它 / 上次手动刷新」。
**影响**:用户配置了多账号却以为都在被监控;非当前账号超阈值**不会发通知**。
**修复建议**:tick 改为逐账号轮转刷新(串行,间隔内完成 N×15s 超时上界需评估:
N≤5 × 15s < 120s 最小间隔,可行);或至少在面板文案明示「仅监测当前账号」。

### 🟠 P3 · 球隐藏 = 全部定时监测停止(与 P1/P2 叠加后的完整真相)

**证据**:hideBall(:1346-1352)→ `pv.window.hide()` → Rust `w.close()` 真关窗
(bridge.ts:135 → plugins.rs:1526-1533);轮询存活于球 webview,关窗即停;
而面板不轮询(P1)、轮询也不覆盖全账号(P2)。
**影响**:用户隐藏球(以为只是不显示)后,**告警、刷新、监测全部静默停止**,
且无任何提示。此前 K 轮已记录「close 语义」为已知形态,本轮结合 P1/P2 升级定性:
这是产品级监测断供,不是单纯窗口语义问题。
**修复建议**:与 P2 一起决策——要么监测职责移入面板实例/宿主(P1-c 架构顺带
解决),要么隐藏时明示「隐藏后停止监测」并保留托盘级后台刷新(v2)。

### 🟡 P4 · 面板无数据新鲜度指示

> **状态:已修复(3f06960,修复卡 L,与 P1-a 同提交)**——卡头「上次刷新」相对时间(fetchedAt 三档,zh/en 双语;无 cache 显示「—」)。

**证据**:cache 写入带 `fetchedAt`(:628),但面板/球 UI 均不展示;卡片无
「上次刷新」时间。P1 的旧值问题因此**不可感知**(用户无法分辨 23.5% 是
1 分钟前还是 3 小时前)。
**修复建议**:卡头或计量条下补 `fetchedAt` 相对时间(「3 分钟前」),
P1 修复后此字段即成为同步可信度的可见锚点。

## 上轮发现复核(b97a5a5 基线;2026-11-21 修复卡 L 后状态见括注)

H1(版本串路径穿越,plugins.rs:898)——**已修复(ab87eb1)**;
M1(核心数据命令无调用者校验)——下一卡;M2(编辑态保存抹掉外部新增)——下一卡;
M3(maybeNotify 无 resetAt 过期检查——本轮:1165-1172 再证)——**已修复(f32b8f5)**;
T1(重开不写回 window:visible → 重启球永不自启)——**已修复(1317525)**;
T2(error 态可开兜底尺寸窗口)——**已修复(1317525)**;
T3(切换账号与 tick 竞速短暂串显,记录不修)、
L1(config 原子写)**已修复(89f9f06,修复卡 M)**、L7(路径可移植)**已修复(e070dab,修复卡 M)**、
L2/L3/L4/L5/L6/L8/L9 与已知接受项不变。

## 本轮验证方式说明(诚实边界)

- P1 为 preview 夹具动态实证(真实 render 路径 + mock kv);**跨窗口真机行为**
  (球窗真写 kv → 主窗面板)未跑实机双窗冒烟——mock kv 按页隔离,夹具无法
  表达双 webview 共享;代码链路(事件总线不跨窗 + 无重读定时器)对此无歧义,
  建议修复后实机双窗验证补位。
- 其余结论均为代码行级证据(已标行号)。

## 更新后的修复优先级

1. **立即**:H1(不变);
2. **监测链批次(新增,回应本轮)**:P1-a(+P4 一行)→ T1(一行)→ M3(一行)
   → P2(轮转刷新)→ T2;P3 随 P1-c/P2 的架构决策一并定;
3. M1/M2/L1 维持「下批次」;其余不变。
