# plugin-source · 插件源分发目录

本目录是一个**可直接当插件源用的仓库布局**:`pv-plugins.json`(源清单)+ 各插件 zip 包。
把本目录 push 到 github / gitee / gitlab / gitea 仓库(或用 serve.mjs 本地起服务),
在应用「插件区 → 插件源」里填入仓库主页地址,市场即可刷出并安装。

## 目录内容

| 文件 | 说明 |
|---|---|
| `pv-plugins.json` | 插件源清单(id/name/desc/channels[version·url·sha256]/minAppVersion/permissions),由 `build-source.mjs` 生成 |
| `token-monitor-1.0.0.zip` | 插件包(根级 `manifest.json` 布局,sha256 见清单) |
| `build-source.mjs` | 打包器:扫描 `../plugins-src/*/` → 生成 zip + sha256 + 源清单 |
| `serve.mjs` | 本地静态服务:把本目录当 gitea 形态源提供(raw URL 重写),本地试用市场全链路 |

> 目前成品插件:**token-monitor 1.0.0**(Coding 套餐用量监控)。
> 新增插件:在 `plugins-src/<id>/` 放 `manifest.json + main.js(可选 desc.txt)`,重跑打包器即可。

## 快速本地试用(SSRF 提示:环回/私网地址会被应用拒绝)

```powershell
# 1. 起本地源服务(自动打印可粘贴的源地址)
node serve.mjs

# 2. 应用 → 插件区 → 插件源 → 添加源:粘贴输出的 http://[<全局IPv6>]:8899/pv/plugins
#    (gitea 形态,http/IPv6 均支持;仅限本机全局地址)

# 3. 市场 → 选择 token-monitor → 安装(权限确认后走 下载→sha256→解压→落盘 全链路)
```

## 重新生成(IPv6 变化 / 插件更新后)

```powershell
node build-source.mjs                # 自动探测全局 IPv6,zip 前缀 = http://[<v6>]:8899/pv/plugins/raw/main
node build-source.mjs --base <zip下载前缀>   # 显式指定(绝对 http(s) 前缀,拼 <id>-<version>.zip)
```

- 打包器按 `plugins-src/<id>/manifest.json` 的 `id/version/minAppVersion/permissions` 生成
  清单与 `<id>-<version>.zip`;`desc.txt`(可选)作为市场展示描述。
- `--base` 是**各托管平台对应的 raw 前缀**:
  - github:`https://raw.githubusercontent.com/<owner>/<repo>/<branch>`
  - gitee / gitea:`https://<host>/<owner>/<repo>/raw/main`
  - 本地 serve.mjs:`http://[<IPv6>]:8899/pv/plugins/raw/main`(缺省自动探测)

## 上架到真实仓库

1. 把清单与 zip push 到仓库分支根(本仓库已推 `plugin-source` 孤儿分支,根即清单+zip);
2. 用对应平台的 raw 前缀重新生成清单(命令见上节);
3. 应用里添加源:github 填 `https://github.com/<owner>/<repo>#<branch>`,
   gitee/gitea 填仓库主页地址 → 市场安装。

## 安全说明

安装完整性由应用侧管线执行:HTTPS 下载 → sha256 逐字节校验 → zip-slip 与条目数/
解压体积限额防护 → 权限确认弹窗 → 原子落盘。本目录只负责「源清单 + 分发包」。
