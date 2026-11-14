# Prompt Vault 插件源

本仓库是 [Prompt Vault](https://github.com/zklmiao/prompt-vault) 的**插件源**:仓库根的
`pv-plugins.json` 是插件市场拉取的清单,zip 为安装包。

## 使用

应用 → 插件区 → 插件源 → 添加源:

```
https://github.com/zklmiao/prompt-vault#plugin-source
```

市场刷新后即可安装(权限确认 → sha256 校验 → 解压落盘)。当前收录:

| 插件 | 版本 | 类型 | 权限 |
|---|---|---|---|
| Coding 套餐用量监控(token-monitor) | 1.0.0 | 界面插件(悬浮球+面板) | 9 项(三家联网+凭据+悬浮窗) |
| English 语言包(lang-english) | 1.0.0 | 纯数据(type:i18n) | 无 |

## 更新流程

插件源码与打包器位于主仓库 `plugin-source/` 与 `plugins-src/`;插件更新时用
`build-source.mjs --base https://raw.githubusercontent.com/zklmiao/prompt-vault/plugin-source`
重新生成清单与包,再更新本分支。
