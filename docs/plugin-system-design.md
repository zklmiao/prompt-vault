# Prompt Vault 插件系统 · 设计文档 v1.0

> 状态:**已定稿**(2026-11-12,四轮需求评审 + 三轮联网调研收敛)。
> 分支:`feat/plugin-system`;实施批次见 `docs/backlog.md` P3。
> 本文是实现的唯一事实来源;与代码冲突时以本文为准修订本文。

---

## 0. 决策总账(D1–D11)

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 信任模型 | **可信插件 + 声明式权限清单**,运行于主 WebView,仅可调用受控 API 桥(pv.*) |
| D2 | 技术边界 | **Rust 能力全部内置休眠,插件 = 前端 JS + 数据文件**;第三方插件作者不能写 Rust(Tauri 官方明确运行时动态加载 Rust 插件 out of scope) |
| D3 | 生命周期 | 装/启 → **即时生效**(pv-1 内联 script 注入);停/卸/更 → 状态落盘后 **webview reload(约 1s,进程不重启,数据无损)** |
| D4 | 仓库源 | 四平台(github/gitee/gitlab/gitea)仓库主页地址 + 可选 `#分支`;仓库根 **`pv-plugins.json`**;多源可存、**单源生效**、手动刷新;release/beta **每插件各自选通道** |
| D5 | 安装管线 | 下载(仅 http/https、拒 localhost/环回/私网/保留地址)→ **sha256 校验** → 解压(zip-slip 防护)→ 导入;更新仅提示、由用户手动执行 |
| D6 | 存储 | 新增 `%APPDATA%\prompt-vault\plugins.json` + `plugins\store\<id>\<版本>\`;现有 `config.json` **结构不动** |
| D7 | i18n | **核心内建运行时**(全 UI 抽 key);zh-CN 内置为 fallback;语言包 = `type:"i18n"` 数据插件或手动放 `locales\` 目录;跟随系统 locale、即时切换不 reload |
| D8 | Token 监控 | **圆球悬浮窗**常驻桌面(约 84px、always-on-top、单家显示、手动切换);v1 = **GLM、火山方舟、OpenCode**(官方接口 + Key);v2 = Claude、Codex(无官方 Key)、百炼、KiloPass(社区逆向端点,标注「非官方接口」) |
| D9 | 凭据 | 仅 **Windows 凭据管理器**(keyring)+ 环境变量 `PROMPT_VAULT_<PROVIDER>_KEY`(优先);**Key 明文全程不出 Rust 进程**,JS 只见响应 |
| D10 | MCP | **作 MCP Server**(`prompt-vault.exe --mcp` headless,stdio JSON-RPC):tools + 原生 prompts(`{{变量}}` → MCP 参数);**只读 + `save_prompt` 只增不删不改**;默认关;面板一键复制各家接入配置 |
| D11 | 网络/隐私 | README 承诺改写为「**核心离线,插件按需联网**」;v1 无签名(HTTPS + sha256 + 四平台协议白名单);**剪贴板插件取消**(直接用系统 Win+V) |

---

## 1. 总体架构

```
┌────────────────────────── 主进程 prompt-vault.exe ──────────────────────────┐
│  Rust 能力层(全部内置,默认休眠,插件启用才唤醒)                               │
│  ├─ 插件安装管线:plugin_fetch_source → plugin_install(下载→sha256→解压→落盘)│
│  ├─ 网络代理 plugin_net_fetch:插件 host 白名单 + SSRF 防护 + 三种认证模式   │
│  │   (raw / bearer / volcengine HMAC-SHA256,凭据由 Rust 注入)              │
│  ├─ 凭据服务:keyring(Windows 凭据管理器)读写,仅 Rust 可达                   │
│  ├─ MCP Server:--mcp headless(stdio JSON-RPC,与 GUI 同数据文件、命名互斥)  │
│  └─ 数据文件监听:防抖 watcher → emit data-changed → 主窗口静默刷新           │
└──────────────┬──────────────────────────┬──────────────────────────────────┘
               │ invoke / event           │ stdio(被 AI 客户端按需拉起)
┌──────────────▼─────────────┐   ┌────────▼─────────┐
│ 主窗口 WebView(React)      │   │ MCP headless     │
│ ├─ 插件宿主 Host            │   │ tools: search_   │
│ │  (注入 script、面板/悬浮窗 │   │  prompts/get_    │
│ │  /命令注册与分发)         │   │  prompt/list_    │
│ └─ 核心现有功能(不动)       │   │  tags/save_prompt│
└──────────────┬─────────────┘   │ prompts: 全库模板│
               │ 动态创建插件窗口 └──────────────────┘
┌──────────────▼─────────────┐
│ 插件悬浮窗(label:          │
│  pv-plugin-<id>,如圆球)   │
└────────────────────────────┘
```

**新增 Rust 依赖**(全部轻量):`zip`(default-features=false,仅 deflate)、`sha2`、`hmac`、`ureq`(rustls,替代 reqwest 约省 1.8MB)、`keyring`(Windows 凭据管理器)、`notify`(数据文件 watcher)。**不需要** clipboard-win(D11)。

**Tauri 配置变更**:插件 JS 不经 asset 协议(pv-1 内联注入,`plugin_read_entry` 读源码);`csp` 保持 null(可信插件模型,D1)。

---

## 2. 插件包格式与插件运行时

### 2.1 zip 内结构

```
token-monitor/
├─ manifest.json     # 必需
├─ main.js           # standard 型必需;i18n 型无(纯数据)
└─ assets/…          # 可选资源(图标外的图片/JSON 等)
```

### 2.2 manifest.json

```jsonc
{
  "id": "token-monitor",          // 唯一,kebab-case,安装目录名
  "name": "Coding 套餐用量监控",
  "version": "1.0.0",             // semver
  "minAppVersion": "0.2.0",       // 低于则拒绝安装/提示升级应用
  "type": "standard",             // standard | i18n
  "ui": "window",                 // panel | window | none —— 插件自声明形态
  "permissions": [
    "net:open.bigmodel.cn",       // 联网 host 白名单(精确 host)
    "net:ark.cn-beijing.volcengineapi.com",
    "net:opencode.ai",
    "credential:glm",             // 允许 Rust 用凭据管理器中该 scope 的凭据发请求
    "window:float"                // 允许创建悬浮窗
  ]
}
```

**权限串语法**:统一 `ns:value` 形状 —— `net:<精确host>`(联网白名单)、`credential:<scope>`(凭据取用,scope 映射规则见 §5.3)、`window:float`(创建悬浮窗);`ui:"panel"` 复用宿主内置排版,不需要单独权限。

### 2.3 插件 JS 契约(pv-1:IIFE 参数闭包 + 一次性注入槽位)

宿主把插件 `main.js` 源码经 `plugin_read_entry` 读出,包进 `(function(pv){ "use strict"; …源码… })(window.__pvSlot);` 以 `<script>.textContent` 内联同步执行(不用 `dynamic import()`——Windows 上 tauri.localhost 与 asset.localhost 跨源 + MIME 坑,已调研否决;也不用 asset 协议加载外部脚本——内联注入收窄了 asset 通道攻击面)。桥 pv 随 IIFE 参数闭包封闭:插件在 main.js **顶层捕获 pv** 后,任何异步阶段调用的都是自己的桥,不会被后续插件改写;注入完成后 `__pvSlot` 即被清除,全局不存在任何可再次获取桥的入口(`window.pv` 不存在)。

```js
// main.js 可用 API 面(pv-1,版本化)
pv.panel.register({ id, title, render(el) {} });        // ui:"panel" → 主窗口插件区页签
pv.window.setup({ size, onMount(el) {} });              // ui:"window" → 宿主为其开专属 WebviewWindow
pv.window.hide() / openPanel() / resize(w, h);          // 隐藏窗口 / 唤出主窗详情面板 / 临时扩窗(球窗菜单)
pv.credentials.set/delete(scope, secret) / configured(); // 凭据通道(manifest 快照判权)
pv.commands.register({ id, label, keywords, run });     // 自动进 Ctrl+K 命令面板
pv.i18n.register({ en: { ... } });                      // 声明插件自带翻译
pv.net.fetch(url, { authFrom, mode, method, body, headers });  // 一律走 Rust 代理
pv.storage.get(key) / pv.storage.set(key, value);       // 沙箱 KV:plugins\data\<id>\kv.json
pv.events.on(name, cb) / pv.events.emit(name, payload); // 宿主事件总线(插件间解耦通信)
```

凭据与窗口等敏感通道在桥闭包内按**安装时 manifest.permissions 快照**同步判权(fail-closed:未声明即 reject 可读中文错误;manifest 读取失败视为空权限集),网络越权仍由 Rust 侧 `net:` 白名单拒绝。

### 2.4 生命周期与失败隔离

- **安装/启用**:管线完成 → 写 `plugins.json`(`enabled: true`)→ 经 `plugin_read_entry` 读 `main.js` 源码内联注入(pv-1 闭包模型)**即刻生效**;
- **停用/卸载/更新**:状态落盘 → `location.reload()` → 重载后宿主按新启用清单重新注入(幂等);
- **加载失败**(语法错误 / 注册超时 3s):toast 报错、该插件标记 `error` 状态,**不拖垮主窗口与其他插件**;重试入口在插件区。

---

## 3. 仓库源协议与市场 UI

### 3.1 源配置与 raw URL 推导

源存于 `plugins.json`:`sources: [{ id, name, provider, url, branch? }]` + `activeSourceId`(**同一时刻仅一个生效**)。用户只填仓库主页地址,raw 路径按平台推导:

| provider | raw 模板(默认分支:先试 main,404 再试 master) |
|---|---|
| github | `https://raw.githubusercontent.com/{owner}/{repo}/{ref}/pv-plugins.json` |
| gitee | `https://gitee.com/{owner}/{repo}/raw/{ref}/pv-plugins.json` |
| gitlab | `https://gitlab.com/{owner}/{repo}/-/raw/{ref}/pv-plugins.json` |
| gitea | `https://{host}/{owner}/{repo}/raw/{ref}/pv-plugins.json`(自建域名,过 SSRF 校验) |

provider 由主页 URL 特征自动识别(gitea 需在添加源时手动指定平台类型)。

### 3.2 仓库清单 pv-plugins.json

```jsonc
{
  "name": "Prompt Vault 官方插件源",
  "plugins": [{
    "id": "token-monitor",
    "name": "Coding 套餐用量监控",
    "desc": "GLM / 火山方舟 / OpenCode 用量圆球",
    "channels": {
      "release": { "version": "1.0.0", "url": "https://github.com/…/token-monitor-1.0.0.zip", "sha256": "…" },
      "beta":    { "version": "1.1.0-beta.2", "url": "…", "sha256": "…" }
    },
    "minAppVersion": "0.2.0",
    "permissions": ["net:open.bigmodel.cn", "credential:glm", "window:float"]
  }]
}
```

### 3.3 插件区 UI(主窗口侧栏新增「收藏 / 插件」页签)

- 顶栏**零新增按钮**;命令面板注册「打开插件区」入口(第二层入口收敛原则);
- **已安装**:每插件一行(名称/版本/通道/错误态),操作 = 启用开关 · 更新(有新版亮起)· 卸载(确认框);
- **插件源**:源列表(添加 = 填主页地址)、激活单选切换(**一次仅一个生效**)、**手动刷新按钮**;
- **市场**:展示激活源清单,每插件 = release/beta 通道选择 + 安装 → **权限确认弹窗**(逐条列 permissions,同意才装)。

---

## 4. 安装管线(Rust)

| 命令 | 职责 |
|---|---|
| `plugin_fetch_source(source)` | 拉 `pv-plugins.json`;host 必须命中四平台白名单域名(SSRF 校验);解析失败返回可读错误 |
| `plugin_install(url, sha256)` | ① 下载至 `plugins\cache\`(仅 http/https;DNS 解析后**拒绝 loopback/私网/保留地址**)② sha256 不符即删缓存报错 ③ 解压至 `store\<id>\<version>\`(逐条目检查路径,拒绝 `..`/绝对路径/软链 = zip-slip 防护)④ 更新 `plugins.json` |
| `plugin_uninstall(id)` | 删 `store\<id>\`(含旧版本回滚目录)与 `data\<id>\`,更新 `plugins.json` |
| `plugin_read_state()` / `plugin_write_state(json)` | 宿主读写 `plugins.json`(复用 `write_atomic` 原子写) |
| `plugin_net_fetch(pluginId, url, opts)` | 网络代理:校验 pluginId 对应 manifest 的 `net:` 白名单 + SSRF;`authFrom` 时由 Rust 取凭据注入认证头;详见 §5.3 |
| `plugin_credential_set(scope, secret)` / `plugin_credential_delete(scope)` | 凭据管理器写入/删除(设置面板直调;**读取只发生在请求拼装时,不暴露给 JS**) |

重装/更新 = 新版本目录解压成功后原子切换 `store\<id>\current` 指向;旧版本目录保留一个作为回滚点,再次更新时清理上一个回滚点。

---

## 5. Token 用量监控插件(圆球)

### 5.1 圆球悬浮窗

- 窗口:label `pv-plugin-token-monitor`,约 **84px**、无边框、透明、always-on-top、shadow=false、resizable=false、skip_taskbar;
- 常驻:可拖动(`data-tauri-drag-region`)、**位置与显示状态记忆**、点关闭 = 隐藏(右键菜单/主窗口可唤出)、**随应用启动自动显示**(仅当插件启用);
- 视觉:**环形进度 = 当前供应商 5h 窗口百分比**,中心 = 供应商缩写(GLM / ARK / OC)+ 百分比数字;配色仅用 CSS token:环底 `--border`、进度 `--accent`、≥80% 转 `--danger`,文字 `--text`;
- 交互:**左键点击 = 轮换下一家已配置供应商**(手动切换);右键菜单 = 直选某家 / 立即刷新 / 打开详情面板 / 隐藏;悬停 tooltip = 5h / 周 / 距重置倒计时;
- 刷新:跟随全局设置(默认手动;可选自动轮询,默认关,间隔 ≥2 分钟,参照社区 statusline 实践 120s 缓存)。

**存储键契约**(kv = `plugins\data\<id>\kv.json`,双实例共享,last-wins):
`window:visible`(bool,插件隐藏前写 false,宿主启动读,缺省视为 true)、
`window:x` / `window:y`(int 物理像素,**仅 Rust 拖动防抖独占写**,插件 JS 不感知不读写)、
`ball.provider`(当前供应商)、`ball.poll` = `{enabled, intervalSec}`(钳制 ≥120s,默认关)、
`cache:<provider>`(最近一次成功数据 + fetchedAt,失败不覆盖)。

**双实例语义**:main.js 在主窗(面板实例)与球窗(球实例)各注入一次,registry 每窗口独立,事件总线不跨窗口;`cache:<provider>`(kv)是两实例唯一共享数据面(球实例写、面板实例读)。

**位置持久化(Rust 独占)**:`on_window_event` 的 `WindowEvent::Moved`(限 `pv-plugin-*` 窗口)防抖 300ms 后,由 Rust 直接把最终 `outer_position` 写入该插件 kv.json 的 `window:x/y`(复用沙箱 KV 内部读写,不经 IPC);启动/安装后开窗时宿主读 kv 传给 `plugin_open_window` 可选 x/y 参数(先 set_position 后 show 防闪跳),无记忆沿用主窗内偏移缺省定位。

**自动显示矩阵**:启动 = `window:visible !== false` 才弹;安装/启用成功 = 总是自动弹(即插即用);球窗菜单「隐藏」= 落盘 `window:visible=false` 后隐藏,重启不弹。

### 5.2 主窗口详情面板

每个已配置供应商一张卡:5h 窗口(百分比 + 倒计时)、周限额(百分比 + 倒计时)、24h 聚合 token 数、(GLM)MCP 月度用量;**积分指标不做**(仅体验卡有积分且 API 无字段,做了必是假数据)。设置区:各供应商 Key 录入(写凭据管理器)、自动轮询开关。

### 5.3 认证与数据(v1 三家;端点事实见附录 A)

| 供应商 | 凭据管理器条目 | pv.net.fetch 认证模式 | 说明 |
|---|---|---|---|
| GLM | `prompt-vault:glm` | `raw`(Authorization 裸 Key,无 Bearer) | quota/limit + model-usage 小时桶聚合 24h |
| 火山方舟 | `prompt-vault:volcengine`(AK、SK 两值) | `volcengine`(HMAC-SHA256 V4 签名在 Rust 完成) | GetAFPUsage 四窗口,百分比自算 |
| OpenCode | `prompt-vault:opencode` | `bearer` | zen/go/v1/usage 直接给 percent |

环境变量 `PROMPT_VAULT_GLM_KEY` / `PROMPT_VAULT_VOLCENGINE_AK`+`_SK` / `PROMPT_VAULT_OPENCODE_KEY` 优先于凭据管理器。**Key 明文只在 Rust 内流转**:JS 调 `pv.net.fetch(url, { authFrom: "credential:glm", mode: "raw" })`,Rust 取凭据、拼头、发请求、只回响应体。

**scope 映射规则**:manifest/`authFrom` 的 `credential:<scope>` ↔ 凭据管理器条目 `prompt-vault:<scope>` ↔ 环境变量 `PROMPT_VAULT_<SCOPE>_KEY`;火山方舟因 AK/SK 双值为**命名例外**:`prompt-vault:volcengine` 条目存双值,环境变量为 `PROMPT_VAULT_VOLCENGINE_AK` + `PROMPT_VAULT_VOLCENGINE_SK`。

---

## 6. MCP Server 插件(`--mcp` headless)

### 6.1 进程模型

`prompt-vault.exe --mcp` → **跳过 GUI/托盘/单实例插件**,读 `plugins.json` 的 `mcp.enabled`(未启用 → stderr 输出「MCP 已在 Prompt Vault 设置中禁用」并退出);随后进入 stdio JSON-RPC 2.0 循环(被 Claude Code / Codex / OpenCode 等客户端按需拉起,用完即退)。每次 tools/prompts 调用**重读数据文件**——主窗口任何改动都即时原子落盘,headless 读到的永远最新。

### 6.2 暴露内容

**tools**(AI 自主调用,initialize 声明 capabilities):

| 工具 | 入参 | 行为 |
|---|---|---|
| `search_prompts` | `query`, `limit?`(默认 10,上限 50) | 复用 `fuzzyMatch/matchPrompt` 评分排序,返回 id/title/tags/snippet |
| `get_prompt` | `id` | 返回 title/body/tags/source/note(正文含 `{{变量}}` 原样,由 agent 与用户交互填充) |
| `list_tags` | — | 标签及计数 |
| `save_prompt` | `title`, `body`, `tags?`, `source?` | **只增不删不改**:`newId()` + 当前时间戳,`source` 默认 `"MCP"`,追加进数据文件 |

**原生 prompts**(人直接调用,Claude Code `/prompts` 等):每条未删除收藏 → 一个 MCP 模板;`extractPlaceholders()` 提取的 `{{变量}}` 映射为 MCP prompt arguments;取用时 `fillPlaceholders` 填充,未填参数保持原样返回。

### 6.3 并发写与变更同步

- **跨进程互斥**:Windows 命名互斥 `Global\prompt-vault-data-<数据路径哈希8位>`(超时 5s),包裹**所有**数据文件写操作——现有 `write_data`、`bump_copy_stats` 与 headless `save_prompt` 统一升级为持锁读-改-写;
- **主窗口感知外部写入**:Rust `notify` watcher 监听数据路径(防抖 500ms)→ emit `data-changed` → `refreshFromDisk()`(**编辑态跳过**,防打断草稿;回退方案:窗口聚焦时 mtime 比对)。

### 6.4 产品面板(插件区页签)

- **默认关**:安装插件后需手动开启;关闭后 `--mcp` 直接拒绝;
- 启用开关 + 风险明示:「配置过的 AI 客户端均可检索全部收藏(不含回收站)」;
- 四页签一键复制(自动填本机 exe 路径):
  - Claude Code:`claude mcp add prompt-vault -- "<exe路径>" --mcp`
  - Codex:config.toml `[mcp_servers.prompt-vault]` 片段
  - OpenCode:opencode.json 片段
  - 通用 mcpJson(command/args JSON 片段)
- 「暴露的工具与模板」说明一节;**无假连接状态**(headless 由客户端拉起,主程序无法可靠感知),只显「已启用 / 已禁用」。

---

## 7. i18n(核心运行时 + 语言包)

- 核心引入 `I18nProvider` + `t(key)` React context,**全 UI 抽 key**(约几百字符串,20 个组件全量),`zh-CN` 内置为 fallback;**语言切换即时生效,不 reload**;
- 默认策略:**跟随系统 locale**(非中文 → en,否则 zh-CN);设置里可手动覆盖(存 localStorage);
- 语言包两条途径并存:
  1. 市场安装 `type:"i18n"` 插件(zip 内含 `en.json` 等,manifest 声明 `"type":"i18n","ui":"none"`,无权限需求);manifest 可声明 `languages` 数组,宿主直接读包内 `<code>.json`;
  2. 手动放 `%APPDATA%\prompt-vault\locales\en.json`(免装即用);
- 第三方翻译贡献 = 向插件源仓库提 PR 增加语言包;
- 实施注意:本项目排在批次 2(全量抽 key 是最大单体工作量),期间其他批次的新 UI 直接用 key 写,不留中文硬编码欠账。

---

## 8. 安全模型汇总

1. **网络**:插件所有请求走 Rust 代理;仅 http/https;请求前校验 host ∈ 该插件 manifest `net:` 白名单;DNS 解析后拒绝 loopback/私网/保留地址(SSRF);清单与下载 URL 限定四平台协议域 + 用户显式添加的 gitea 域;
2. **凭据**:仅 Windows 凭据管理器 + 环境变量;**任何 JSON 不落明文**;源码/示例/测试不出现可用凭据字面量;
3. **安装完整性**:HTTPS + 清单 sha256 + zip-slip 防护 + `minAppVersion` 门控;v1 无签名(D11),开放第三方源前再评估;
4. **权限 UX**:安装时弹窗逐条确认;运行期越权调用(如未声明 host)由 Rust 直接拒绝并报错;
5. **失败隔离**:插件加载/运行错误不拖垮宿主;`--mcp` 未启用即拒启。

---

## 9. v1/v2 分期与实施批次

批次明细、勾选状态与 v2 清单的**唯一维护处是 `docs/backlog.md` P3**,本文不复制(避免双份同步漂移)。概览:v1 五批次 = 宿主与管线 → i18n → Token 圆球 → MCP Server → 收尾;v2 = 其余四家供应商(Claude / Codex / 百炼 / KiloPass)、多账号、MCP 标签过滤等。

---

## 10. 硬性约定遵循(AGENTS.md 映射)

界面全中文 ✓;颜色仅 `src/App.css` CSS token(`:root` 与 `[data-theme="dark"]`,圆球/面板全走既有变量)✓;图标仅 `src/components/icons.tsx` 内联 SVG(需新增:插件/市场/球体/MCP 图标)✓;写盘复用原子写(命名互斥是其跨进程升级版)✓;`coerceItems` 兼容(MCP `save_prompt` 与插件产生的新字段一律可选)✓;严格 TS(`noUnusedLocals`)+ 构建刷 releases + 冒烟 + conventional commits ✓;`config.json` 结构不动(插件状态独立 `plugins.json`)✓。

**规范欠账(随批次 5 清偿)**:AGENTS.md 首段「数据保存在单个本地 JSON 文件,不联网」的项目定位将被 D6(新增 `plugins.json`)与 D11(插件按需联网)改写,收尾批次须与 README 一并修订该段,避免规范与实现脱钩。

---

## 附录 A · 供应商端点调研事实(2026-11 核实)

**v1 三家(官方)**:

- **GLM**(base 国内 `https://open.bigmodel.cn`,国际 `https://api.z.ai`;认证 `Authorization: <key>` 裸传):
  - `GET {base}/api/monitor/usage/quota/limit` → `data.level`、`limits[]`:`TOKENS_LIMIT`(新套餐两条,按 `nextResetTime` 升序,**[0]=5h、[1]=周**;`percentage` 0-100)、`TIME_LIMIT`(实为 **MCP 月度**:`currentValue`/`usage`/`remaining`;注意命名易混淆);`nextResetTime` 为毫秒时间戳。
  - `GET {base}/api/monitor/usage/model-usage?startTime=..&endTime=..`(时间 `yyyy-MM-dd HH:mm:ss` URL 编码)→ `data.x_time[]`/`data.tokensUsage[]` 小时桶,聚合出 24h。
  - 依据:官方 Claude Code 插件源码 zai-org/zai-coding-plugins `query-usage.mjs`(逐字核实)。
- **火山方舟**:`https://ark.cn-beijing.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01`(火山 AK/SK V4 HMAC-SHA256 签名,**不支持 Bearer**)→ 5h/日/周/月四窗口 Quota/Used/ResetTime,百分比自算;`GetUsageDetails` 按模型明细。官方公开文档。
- **OpenCode**:`GET https://opencode.ai/zen/go/v1/usage`,认证 `Authorization: Bearer sk-opencode-...` → `usage.{rolling,weekly,monthly}.{status:"ok"|"rate-limited", percent, resetsAt(ISO)}`;403+`EntitlementError`=无 Go 订阅。依据:上游 anomalyco/opencode `packages/core/src/usage-limits.ts`(逐字核实)。

**v2 四家**:

- **Claude(Pro/Max)**:无官方 API;社区标准做法解析本地 `~/.claude/projects/**/*.jsonl` 会话日志自算 5h 窗口(ccusage 方式)。
- **Codex(ChatGPT 订阅)**:读 `~/.codex/auth.json` 的 OAuth token(`Bearer`,会过期,过期提示用户在 Codex CLI 重登)+ `chatgpt-account-id` 头 → `GET https://chatgpt.com/backend-api/wham/usage` → `rate_limit.primary_window(5h)/secondary_window(周)` 的 `used_percent`/`reset_at`。
- **百炼(灰 API)**:控制台内部端点 `queryCodingPlanInstanceInfoV2`(`bailian.console.aliyuncs.com/data/api.json?...`,sk-sp- Key 三 header)→ per5Hour/perWeek/perBillMonth 的 Used/Total/NextRefreshTime;无官方文档,随时可能变动。
- **KiloPass(灰 API)**:kilo.ai 网页内部 tRPC `https://app.kilo.ai/api/trpc/user.getCreditBlocks,kiloPass.getState,...?batch=1&input=...`(`Bearer` Kilo key)→ `currentPeriodUsageUsd`/`currentPeriodBaseCreditsUsd`/`currentPeriodBonusCreditsUsd`/`nextBillingAt` 等;未文档化,随时可能变动。

## 附录 B · 关键技术调研结论(2026-11 核实)

- **Tauri 运行时插件**:官方明确编译期链接、动态加载 out of scope(issue #8090,not planned);Rust dylib 加载因无稳定 ABI 否决。
- **前端 JS 热加载**:官方维护者认可「经典 `<script>` 注入 + `convertFileSrc`」;`dynamic import()` 在 Windows 有 tauri.localhost/asset.localhost 跨源与 MIME 坑,否决;需开 assetProtocol scope 白名单。「加载易、卸载难」→ 停/卸/更接受 webview reload(D3)。社区先例:kunkun(iframe+Worker 沙箱,重,本设计不采用)。
- **Windows 剪贴板历史**:Win+V 有公开 WinRT API(`Clipboard.GetHistoryItemsAsync`,1809+)但**仅前台聚焦可调**,托盘程序恒 `AccessDenied` → 本应自建监听队列;D11 已决定不做该插件,直接用系统 Win+V。
- **HTTP 栈**:`ureq`(rustls,阻塞式)替代 reqwest 约省 1.8MB 二进制;Tauri 应用已带 tokio,阻塞调用放 `spawn_blocking`/线程即可。
- **凭据**:`keyring` crate 封装 Windows 凭据管理器(即安全约束中的"密钥服务"),满足「凭据仅来自环境变量或密钥服务」。
