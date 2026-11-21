/**
 * Coding 套餐用量监控 —— 数据层 + UI 层(多账号:同供应商可录多个 Key)
 *
 * 数据层:GLM(智谱)/ 火山方舟 / OpenCode 三家套餐用量的取数与解析,
 * 统一输出 { provider, fiveHour:{percent, resetAt}, weekly:{...}, tokens24h?, mcpMonthly? }。
 *   - percent:0-100 数值(非法/缺失为 null;火山限流语义见 parseOpencodeUsage);
 *   - resetAt:ISO 8601 UTC 字符串或 null(各家的毫秒/秒时间戳在此统一归一);
 *   - tokens24h 仅 GLM 系;mcpMonthly 仅 GLM 系(MCP 月度,字段原样透传)。
 *
 * 多账号模型(K 开工卡):
 *   - 账号 = {provider, label};账号 id/scope = `provider:label`(与 Rust scope 语法
 *     `<provider>[:<label>]` 对齐);provider ∈ {glm, glm-intl, volcengine,
 *     volcengine-intl, opencode}(端点变体即 provider,端点是账号属性);
 *   - Key 经 pv.credentials.set('provider:label', key) 进凭据管理器(明文不出 Rust);
 *   - 账号清单存 kv tm.accounts,清单单写者 = 面板实例(主窗);球实例只读,
 *     空清单时以 configured() 探测的 default 账号作内存 fallback 视图(不写 kv);
 *   - 迁移(面板实例,惰性):tm.accounts 缺失/为空 → 探测已配置 provider →
 *     命中者建 {provider, label:"default"} 入清单(幂等,仅命中才落盘);
 *   - cache 键按账号粒度 cache:<provider>:<label>;label "default" 读取回落旧
 *     cache:<provider>(旧单账号缓存兼容,显示后新键接管写)。
 *
 * UI 层(消费 window.pvTokenMonitor):
 *   - 球体:pv.window.setup({ size:{84,84}, onMount }) —— SVG 圆环(当前账号 5h
 *     百分比),左键在全部已配置账号间轮换,右键菜单(按供应商分组直选/立即刷新/
 *     打开详情面板/隐藏),悬停 tooltip(供应商+label);位置不感知不落盘;
 *   - 详情面板:pv.panel.register —— 每账号一张卡(5h/周/24h/MCP 月度)+ 设置区
 *     (添加账号:供应商下拉+标签+Key;账号列表;轮询开关存 ball.poll)。
 *
 * 约定:
 *   - pv-1 书写形态:本文件只写 IIFE 函数体,由宿主包进
 *     (function(pv){ "use strict"; … })(window.__pvSlot) 内联执行;
 *     桥随闭包参数 pv 封闭,本文件不引用 window.pv;
 *   - 所有网络请求一律经宿主桥 pv.net.fetch(url, { authFrom, mode }) 走 Rust 代理,
 *     host 白名单 / SSRF 校验 / 认证注入(含火山 V4 签名)都在 Rust 内完成,
 *     Key 明文不出 Rust 进程,本文件接触不到任何凭据;
 *   - 解析函数全部为无副作用的纯函数,便于用假响应单测;
 *   - 双实例语义(设计 §5.1):本文件在主窗(面板实例)与球窗(球实例)各注入一次,
 *     registry 每窗口独立,事件总线不跨窗口;kv 是两实例唯一共享数据面
 *     (清单单写者=面板实例,cache 双实例写,last-wins)。两个实例都注册 panel 与
 *     window.setup:panel 只会在主窗被渲染,setup 的 onMount 只会在球窗被调用。
 *
 * 存储键契约(§5.1 + 多账号):
 *   window:visible(bool)—— 插件写(隐藏前落盘 false),宿主启动读(缺省视为 true);
 *   window:x / window:y(int,物理像素)—— 仅 Rust 拖动防抖独占写,插件不感知;
 *   ball.provider —— 当前账号('provider:label';旧值裸 provider 读取时升级
 *     '<provider>:default',保序不丢);
 *   ball.poll = {enabled, intervalSec}(钳制 ≥120s,默认关);
 *   tm.accounts —— 账号清单 [{provider,label}](清单单写者=面板实例);
 *   cache:<provider>:<label> —— 每账号最近一次成功数据 + fetchedAt,失败不覆盖;
 *     label "default" 读取回落旧 cache:<provider>(旧单账号缓存兼容);
 *   tm.alert.<provider>:<label> —— 每账号告警阈值 {enabled,threshold}
 *     (键按账号 scope;单写者=面板实例,球实例只读;删除账号时随链清理);
 *   tm.alertState.<provider>:<label> —— 通知去重状态 {firedAt,resetAt}(球实例写,
 *     键按账号 scope;resetAt = 已通知窗口的重置时间,同窗口不重发;评估入口
 *     maybeNotifyFor(account, data, cfg) 按账号传参,轮转周期内每账号刷完即评,
 *     resetAt ≤ now 的已结束窗口不发)。
 */

  // ============ 实例门:球实例 ============

  // 球实例判定:宿主 PluginWindow 分流 URL 即 index.html?plugin=<id>(批次 1 落地),
  // 面板实例(主窗注入)无该参数 → false。打在真实 location.search 上,不依赖
  // __TAURI_INTERNALS__(纯浏览器夹具同路径可用);与 IS_BALL_WINDOW(窗口 label
  // 判定,清单单写者语义)互补。通知职责由球实例独占,maybeNotifyFor 零开销跳过面板实例
  var IS_BALL_INSTANCE = /[?&]plugin=token-monitor(\b|[&=])/.test(location.search);

  // ============ 常量:五家供应商的取数契约(端点事实见设计文档附录 A,2026-11 核实) ============

  /**
   * 供应商元信息:端点变体即 provider(国际同 abbr + 角标 i)。
   * label 供详情面板/球菜单分组;abbr 供圆球中心缩写(设计 §5.1:GLM / ARK / OC);
   * endpoint/host 为该 provider 的取数端点(账号属性,替代旧国际版开关);
   * family:glm 系(含国际)共享 24h 聚合与 MCP 月度两行。
   */
  var PROVIDERS = {
    glm: {
      label: 'GLM Coding', abbr: 'GLM', family: 'glm',
      endpoint: 'https://open.bigmodel.cn', host: 'open.bigmodel.cn'
    },
    'glm-intl': {
      label: 'GLM Coding 国际版', abbr: 'GLM', intl: true, family: 'glm',
      endpoint: 'https://api.z.ai', host: 'api.z.ai'
    },
    volcengine: {
      label: '火山方舟', abbr: 'ARK', family: 'volcengine',
      endpoint: 'https://ark.cn-beijing.volcengineapi.com', host: 'ark.cn-beijing.volcengineapi.com'
    },
    'volcengine-intl': {
      label: '火山方舟国际版', abbr: 'ARK', intl: true, family: 'volcengine',
      endpoint: 'https://ark.ap-southeast.bytepluses.com', host: 'ark.ap-southeast.bytepluses.com'
    },
    opencode: {
      label: 'OpenCode', abbr: 'OC', family: 'opencode',
      endpoint: 'https://opencode.ai/zen/go/v1/usage', host: 'opencode.ai'
    }
  };

  var PROVIDER_ORDER = ['glm', 'glm-intl', 'volcengine', 'volcengine-intl', 'opencode'];

  // ============ 纯函数:归一化工具 ============

  /** 任意值 → 0-100 的两位小数数值;非法/缺失返回 null */
  function toPercent(value) {
    var num = typeof value === 'string' ? Number(value) : value;
    if (typeof num !== 'number' || !isFinite(num)) return null;
    return Math.min(100, Math.max(0, Math.round(num * 100) / 100));
  }

  /** 任意值 → 有限数值;非法返回 null(上游 Quota/Used 常以字符串下发) */
  function numOrNull(value) {
    var num = typeof value === 'string' ? Number(value) : value;
    return typeof num === 'number' && isFinite(num) ? num : null;
  }

  /** 毫秒时间戳 → ISO 8601;非法/缺失返回 null */
  function msToIso(ms) {
    var num = Number(ms);
    if (!isFinite(num) || num <= 0) return null;
    return new Date(num).toISOString();
  }

  /** 毫秒/秒级时间戳或 ISO 字符串 → ISO 8601;非法返回 null(< 1e12 视为秒级) */
  function epochValueToIso(value) {
    if (value == null) return null;
    var num = Number(value);
    if (isFinite(num) && num > 0) {
      return new Date(num < 1e12 ? num * 1000 : num).toISOString();
    }
    var parsed = new Date(String(value));
    return isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  // ============ 纯函数:账号模型(与 Rust scope 语法对齐) ============

  /** 账号 → scope/id 字符串 `provider:label` */
  function accountScope(account) {
    return account.provider + ':' + account.label;
  }

  /** 账号标签校验:与 Rust label 段同一字符集 [A-Za-z0-9_-\u4e00-\u9fa5]{1,16}
   *  (禁冒号/斜杠/空白 —— 与 Rust 前缀权限门控和 cache 键解析对齐) */
  function isValidLabel(label) {
    return typeof label === 'string'
      && /^[\u4e00-\u9fa5A-Za-z0-9_-]{1,16}$/.test(label);
  }

  /** 任意值 → 合法账号数组(纠偏:丢非法项、去重,保序);非数组返回 [] */
  function sanitizeAccounts(value) {
    if (!Array.isArray(value)) return [];
    var out = [];
    for (var i = 0; i < value.length; i++) {
      var item = value[i];
      if (!item || typeof item !== 'object') continue;
      if (!PROVIDERS[item.provider] || !isValidLabel(item.label)) continue;
      var scope = accountScope(item);
      var dup = false;
      for (var j = 0; j < out.length; j++) {
        if (accountScope(out[j]) === scope) { dup = true; break; }
      }
      if (dup) continue;
      out.push({ provider: item.provider, label: item.label });
    }
    return out;
  }

  /** 选择值升级:旧值裸 provider(无冒号)→ '<provider>:default';其余原样 */
  function upgradeSelection(saved) {
    if (typeof saved !== 'string' || saved === '') return null;
    return saved.indexOf(':') >= 0 ? saved : saved + ':default';
  }

  // ============ 纯函数:GLM 响应解析 ============

  /** Date → "yyyy-MM-dd HH:mm:ss"(本地时区,URL 编码交给调用方) */
  function pad2(n) {
    return String(n).padStart(2, '0');
  }
  function glmLocalTime(date) {
    return (
      date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
      ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
    );
  }

  /** 近 24h 起止:model-usage 接口的 startTime/endTime 参数 */
  function glmDayRange(now) {
    var end = now instanceof Date ? now : new Date();
    var start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
    return { startTime: glmLocalTime(start), endTime: glmLocalTime(end) };
  }

  /**
   * quota/limit 响应 → 窗口百分比与 MCP 月度。
   * 附录 A:data.limits[] 中 TOKENS_LIMIT 按套餐有两条,按 nextResetTime(毫秒)升序
   * [0]=5h、[1]=周,percentage 0-100;TIME_LIMIT 名字易混淆,实为 MCP 月度
   * (currentValue/usage/remaining),原样透传给详情面板。
   */
  function parseGlmQuota(payload) {
    var data = payload && payload.data ? payload.data : payload || {};
    var limits = Array.isArray(data.limits) ? data.limits : [];
    var tokenLimits = limits
      .filter(function (item) { return item && item.type === 'TOKENS_LIMIT'; })
      .slice()
      .sort(function (a, b) { return numOrNull(a.nextResetTime || 0) - numOrNull(b.nextResetTime || 0); });
    var fiveHour = tokenLimits[0] || null;
    var weekly = tokenLimits[1] || null;
    var timeLimit = null;
    for (var i = 0; i < limits.length; i++) {
      if (limits[i] && limits[i].type === 'TIME_LIMIT') { timeLimit = limits[i]; break; }
    }
    return {
      fiveHour: {
        percent: toPercent(fiveHour ? fiveHour.percentage : null),
        resetAt: msToIso(fiveHour ? fiveHour.nextResetTime : null)
      },
      weekly: {
        percent: toPercent(weekly ? weekly.percentage : null),
        resetAt: msToIso(weekly ? weekly.nextResetTime : null)
      },
      mcpMonthly: timeLimit
        ? {
            currentValue: numOrNull(timeLimit.currentValue),
            usage: numOrNull(timeLimit.usage),
            remaining: numOrNull(timeLimit.remaining)
          }
        : null
    };
  }

  /** 单个 model-usage 小时桶的数值:数字直接用,对象桶(分列字段)按数值字段求和 */
  function bucketValue(item) {
    if (typeof item === 'number') return isFinite(item) ? item : 0;
    if (typeof item === 'string') {
      var n = Number(item);
      return isFinite(n) ? n : 0;
    }
    if (item && typeof item === 'object') {
      var sum = 0;
      for (var key in item) {
        if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
        var v = typeof item[key] === 'string' ? Number(item[key]) : item[key];
        if (typeof v === 'number' && isFinite(v)) sum += v;
      }
      return sum;
    }
    return 0;
  }

  /** model-usage 响应 → 近 24h token 聚合(data.x_time[] 为小时标签,只取对应 tokensUsage 求和) */
  function parseGlmModelUsage(payload) {
    var data = payload && payload.data ? payload.data : payload || {};
    var buckets = Array.isArray(data.tokensUsage) ? data.tokensUsage : [];
    var total = 0;
    for (var i = 0; i < buckets.length; i++) total += bucketValue(buckets[i]);
    return { tokens24h: Math.round(total) };
  }

  // ============ 纯函数:火山方舟响应解析 ============

  /**
   * GetAFPUsage 响应 → 窗口百分比与重置时间。
   * 官方响应(2026-11 核实):Result.AFPFiveHour / AFPDaily / AFPWeekly / AFPMonthly,
   * 每窗口 { Quota: "50.0", Used: "12.5", SubscribeTime: 毫秒, ResetTime: 毫秒 };
   * 接口不直接给百分比,按 Used/Quota 自算(圆球只用 5h 与周两窗口)。
   */
  function parseVolcUsage(payload) {
    var result = payload && payload.Result ? payload.Result : {};
    var windowFor = function (key) {
      var item = result[key];
      var quota = numOrNull(item ? item.Quota : null);
      var used = numOrNull(item ? item.Used : null);
      return {
        percent: quota !== null && quota > 0 ? toPercent(((used || 0) / quota) * 100) : 0,
        resetAt: epochValueToIso(item ? item.ResetTime : null)
      };
    };
    return { fiveHour: windowFor('AFPFiveHour'), weekly: windowFor('AFPWeekly') };
  }

  // ============ 纯函数:OpenCode 响应解析 ============

  /**
   * usage 响应 → 窗口百分比与重置时间。
   * usage.rolling ≈ 5h、usage.weekly / usage.monthly,每项
   * { status: "ok"|"rate-limited", percent, resetsAt(ISO) };
   * 403 + EntitlementError 表示无 Go 订阅(由 callNet 的状态码检查抛错,不进本函数)。
   */
  function parseOpencodeUsage(payload) {
    var usage = payload && payload.usage ? payload.usage : {};
    var pick = function (item) {
      if (!item) return { percent: null, resetAt: null };
      var percent = toPercent(item.percent);
      return {
        // 限流态且上游没给百分比时,按 100% 展示
        percent: percent === null && item.status === 'rate-limited' ? 100 : percent,
        resetAt: typeof item.resetsAt === 'string' ? item.resetsAt : null
      };
    };
    return { fiveHour: pick(usage.rolling), weekly: pick(usage.weekly) };
  }

  // ============ 取数:一律经 pv.net.fetch 走 Rust 代理 ============

  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('供应商响应不是有效 JSON');
    }
  }

  /** 桥可用性与非 2xx 统一处理;成功返回响应体文本(pv 经闭包参数封闭) */
  function callNet(url, opts) {
    if (!pv || !pv.net || typeof pv.net.fetch !== 'function') {
      return Promise.reject(new Error('宿主桥未就绪:pv.net.fetch 不可用'));
    }
    return pv.net.fetch(url, opts).then(function (resp) {
      if (!resp || typeof resp.status !== 'number' || typeof resp.body !== 'string') {
        throw new Error('pv.net.fetch 返回结构异常');
      }
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error('供应商接口返回 HTTP ' + resp.status);
      }
      return resp.body;
    });
  }

  /** GLM 系(GLM/GLM 国际):quota/limit + model-usage(近 24h 聚合),mode raw。
   *  端点是账号属性(国内 open.bigmodel.cn / 国际 api.z.ai 由 provider 决定) */
  function fetchGlm(account) {
    var base = PROVIDERS[account.provider].endpoint;
    var auth = 'credential:' + accountScope(account);
    var quotaPromise = callNet(base + '/api/monitor/usage/quota/limit', {
      authFrom: auth,
      mode: 'raw'
    }).then(parseJson).then(parseGlmQuota);
    // 时间参数格式 yyyy-MM-dd HH:mm:ss,URL 编码后拼 query
    var range = glmDayRange(new Date());
    var usageQuery =
      '?startTime=' + encodeURIComponent(range.startTime) +
      '&endTime=' + encodeURIComponent(range.endTime);
    var usagePromise = callNet(base + '/api/monitor/usage/model-usage' + usageQuery, {
      authFrom: auth,
      mode: 'raw'
    }).then(parseJson).then(parseGlmModelUsage);
    return Promise.all([quotaPromise, usagePromise]).then(function (results) {
      var quota = results[0];
      var tokens = results[1];
      return {
        provider: account.provider,
        fiveHour: quota.fiveHour,
        weekly: quota.weekly,
        mcpMonthly: quota.mcpMonthly,
        tokens24h: tokens.tokens24h
      };
    });
  }

  /** 火山系(国内/国际):GetAFPUsage,mode volcengine(V4 签名双头 X-Date/Authorization
   *  在 Rust 内完成);host 为账号端点,Rust 签名 region 随 host 推导(零 Rust 改动) */
  function fetchVolcengine(account) {
    var host = PROVIDERS[account.provider].endpoint;
    return callNet(host + '/?Action=GetAFPUsage&Version=2024-01-01', {
      authFrom: 'credential:' + accountScope(account),
      mode: 'volcengine'
    })
      .then(parseJson)
      .then(function (payload) {
        var usage = parseVolcUsage(payload);
        return { provider: account.provider, fiveHour: usage.fiveHour, weekly: usage.weekly };
      });
  }

  /** OpenCode:zen/go/v1/usage,mode bearer */
  function fetchOpencode(account) {
    return callNet(PROVIDERS[account.provider].endpoint, {
      authFrom: 'credential:' + accountScope(account),
      mode: 'bearer'
    })
      .then(parseJson)
      .then(function (payload) {
        var usage = parseOpencodeUsage(payload);
        return { provider: account.provider, fiveHour: usage.fiveHour, weekly: usage.weekly };
      });
  }

  // ============ 对外入口 ============

  var FETCHERS = {
    glm: fetchGlm,
    'glm-intl': fetchGlm,
    volcengine: fetchVolcengine,
    'volcengine-intl': fetchVolcengine,
    opencode: fetchOpencode
  };

  /**
   * 刷新指定账号,resolve 统一结构:
   * { provider, fiveHour:{percent, resetAt}, weekly:{percent, resetAt}, tokens24h?, mcpMonthly? }
   * 失败 reject Error(桥未就绪 / HTTP 非 2xx / 响应非 JSON / 解析异常),由 UI 层按账号粒度上报。
   */
  function refreshAccount(account) {
    var fetcher = FETCHERS[account.provider];
    if (!fetcher) return Promise.reject(new Error('未知的供应商:' + account.provider));
    return fetcher(account);
  }

  // 暴露给宿主 UI 与后续单测(假响应直喂各 parse 纯函数;账号纯函数供 node 回归)
  window.pvTokenMonitor = {
    providers: Object.keys(FETCHERS),
    meta: PROVIDERS,
    refreshAccount: refreshAccount,
    parseGlmQuota: parseGlmQuota,
    parseGlmModelUsage: parseGlmModelUsage,
    parseVolcUsage: parseVolcUsage,
    parseOpencodeUsage: parseOpencodeUsage,
    glmDayRange: glmDayRange,
    accountScope: accountScope,
    isValidLabel: isValidLabel,
    sanitizeAccounts: sanitizeAccounts,
    upgradeSelection: upgradeSelection
  };

  /* ==================== UI 层(多账号) ==================== */

  // ---------- 常量与存储键(契约见文件头) ----------

  var KV_VISIBLE = 'window:visible';
  var KV_X = 'window:x';          // 仅 Rust 写,插件不读写
  var KV_Y = 'window:y';          // 仅 Rust 写,插件不读写
  var KV_PROVIDER = 'ball.provider';  // 值为 'provider:label';旧值裸 provider 读取时升级
  var KV_POLL = 'ball.poll';
  var KV_ACCOUNTS = 'tm.accounts';    // 账号清单(单写者=面板实例)
  var KV_CACHE_PREFIX = 'cache:';
  var KV_ALERT_PREFIX = 'tm.alert.';  // 告警阈值配置,键 = 前缀 + 账号 scope(单写者=面板实例)
  var KV_ALERT_STATE_PREFIX = 'tm.alertState.'; // 通知去重状态,键 = 前缀 + 账号 scope(球实例写)
  var BALL_SIZE = 84;             // 球窗边长(与设计 §5.1 一致)
  var MENU_WIDTH = 172;           // 右键菜单宽度
  var POLL_MIN_SEC = 120;         // 轮询间隔下限(参照社区 statusline 120s 缓存实践)
  var POLL_DEFAULT_SEC = 300;     // 开启轮询且未指定间隔时的默认值
  var ALERT_MIN = 5;              // 阈值滑杆下限(%)
  var ALERT_MAX = 100;            // 阈值滑杆上限(%)
  var ALERT_DEFAULT_THRESHOLD = 80; // 无 kv 记录时的默认阈值(%)

  // ---------- 微型 i18n:zh 默认 + en;窗口语言创建时定格(批次 2 已知限制) ----------

  var TM_I18N = {
    zh: {
      panelTitle: '用量监控',
      ballEmpty: '尚未配置账号:请在详情面板添加账号并录入 Key',
      ballIdle: '左键轮换 · 右键菜单 · 边缘拖动',
      refreshNow: '立即刷新',
      refreshAll: '全部刷新',
      openPanel: '打开详情面板',
      hideBall: '隐藏圆球',
      fiveHour: '5h',
      weekly: '周',
      tokens24h: '24h Token',
      mcpMonthly: 'MCP 月度',
      resetsIn: '距重置',
      noData: '暂无数据',
      panelEmpty: '尚未配置账号:请在下方添加账号并录入 Key',
      addAccount: '添加账号',
      providerPh: '选择供应商',
      labelPh: '账号标签(如 主号/备用)',
      keyPlaceholder: '粘贴 API Key',
      akPlaceholder: '粘贴 Access Key(AK)',
      skPlaceholder: '粘贴 Secret Key(SK)',
      addBtn: '添加',
      accountList: '账号列表',
      configured: '已配置',
      notConfigured: '未配置',
      removeAccount: '删除',
      labelInvalid: '标签需为 1-16 位字母/数字/下划线/连字符/中文(禁冒号斜杠空白)',
      labelDuplicate: '同一供应商下已有同名账号',
      keyRequired: 'Key 不能为空',
      akSkRequired: 'AK 与 SK 均不能为空',
      addOk: '账号已添加',
      alertGroup: '告警阈值 · 5 小时窗口',
      alertChip: '已超阈值',
      alertTooltip: '已超阈值 {n}%',
      alertSwitch: '{label} 阈值告警开关',
      alertSlider: '{label} 告警阈值滑杆',
      notifyTitle: '用量告警',
      notifyBody: '{name} 5 小时用量已达 {pct}%,超过阈值 {thr}%。',
      pollLabel: '自动轮询(球窗常驻刷新)',
      pollInterval: '间隔(秒,≥120)',
      credFail: '凭据操作失败:',
      errPrefix: '取数失败:',
      lastRefresh: '上次刷新',
      justNow: '刚刚',
      minsAgo: '{n} 分钟前',
      hoursAgo: '{n} 小时前'
    },
    en: {
      panelTitle: 'Usage Monitor',
      ballEmpty: 'No account configured: add one in the details panel',
      ballIdle: 'Click to rotate · Right-click menu · Drag edges',
      refreshNow: 'Refresh now',
      refreshAll: 'Refresh all',
      openPanel: 'Open details panel',
      hideBall: 'Hide ball',
      fiveHour: '5h',
      weekly: 'Week',
      tokens24h: '24h Tokens',
      mcpMonthly: 'MCP monthly',
      resetsIn: 'Resets in',
      noData: 'No data yet',
      panelEmpty: 'No account configured: add one below and paste its key',
      addAccount: 'Add account',
      providerPh: 'Select provider',
      labelPh: 'Account label (e.g. main/spare)',
      keyPlaceholder: 'Paste API key',
      akPlaceholder: 'Paste access key (AK)',
      skPlaceholder: 'Paste secret key (SK)',
      addBtn: 'Add',
      accountList: 'Accounts',
      configured: 'Configured',
      notConfigured: 'Not configured',
      removeAccount: 'Remove',
      labelInvalid: 'Label must be 1-16 chars of letters/digits/underscore/hyphen/CJK',
      labelDuplicate: 'An account with the same label already exists for this provider',
      keyRequired: 'Key is required',
      akSkRequired: 'Both AK and SK are required',
      addOk: 'Account added',
      alertGroup: 'Alert threshold · 5h window',
      alertChip: 'Over threshold',
      alertTooltip: 'Over threshold {n}%',
      alertSwitch: '{label} threshold alert switch',
      alertSlider: '{label} alert threshold slider',
      notifyTitle: 'Usage alert',
      notifyBody: '5-hour usage for {name} is at {pct}%, over the {thr}% threshold.',
      pollLabel: 'Auto poll (ball refresh)',
      pollInterval: 'Interval (sec, ≥120)',
      credFail: 'Credential operation failed: ',
      errPrefix: 'Fetch failed: ',
      lastRefresh: 'Refreshed',
      justNow: 'just now',
      minsAgo: '{n} min ago',
      hoursAgo: '{n} h ago'
    }
  };

  // 语言检测:宿主偏好(pv-lang,非 auto 且非 zh → en)优先,回退 navigator
  var TM_LANG = (function () {
    var pref = null;
    try { pref = window.localStorage.getItem('pv-lang'); } catch (e) { /* ignore */ }
    if (pref && pref !== 'auto' && !/^zh/i.test(pref)) return 'en';
    if (/^en/i.test(typeof navigator !== 'undefined' ? (navigator.language || '') : '')) return 'en';
    return 'zh';
  })();

  function tm(key) {
    return (TM_LANG === 'en' ? TM_I18N.en[key] : null) || TM_I18N.zh[key] || key;
  }

  // en 字典并入宿主 i18n 目录链(键名 tm.* 前缀,不与核心 key 冲突)
  if (pv.i18n && typeof pv.i18n.register === 'function') {
    pv.i18n.register({ en: TM_I18N.en });
  }

  // ---------- 共享工具 ----------

  /** resetAt → "2h 13m";无效/已过期返回 '' */
  function formatCountdown(resetAt) {
    if (!resetAt) return '';
    var ms = new Date(resetAt).getTime() - Date.now();
    if (!isFinite(ms) || ms <= 0) return '';
    var mins = Math.floor(ms / 60000);
    if (mins < 1) return '<1m';
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }

  /** fetchedAt → 相对时间:<60s「刚刚」/ x 分钟前 / x 小时前(P4 新鲜度展示,
   *  界面语言相关);非法输入返回 null(调用方回退「—」) */
  function formatRelativeTime(ts) {
    if (typeof ts !== 'number' || !isFinite(ts)) return null;
    var diff = Date.now() - ts;
    if (diff < 0) diff = 0; // 时钟轻微偏差:按刚刚处理
    if (diff < 60e3) return tm('justNow');
    var mins = Math.floor(diff / 60e3);
    if (mins < 60) return tm('minsAgo').replace('{n}', String(mins));
    return tm('hoursAgo').replace('{n}', String(Math.floor(mins / 60)));
  }

  /** 轮询间隔钳制:≥120s(§5.1 参照社区实践) */
  function clampPollSec(sec) {
    var n = typeof sec === 'string' ? Number(sec) : sec;
    if (typeof n !== 'number' || !isFinite(n)) return POLL_DEFAULT_SEC;
    return Math.max(POLL_MIN_SEC, Math.round(n));
  }

  /** 去尾零:1.50 → 1.5、1.00 → 1 */
  function trimNum(x, digits) {
    return Number(x).toFixed(digits).replace(/\.?0+$/, '');
  }

  /** token 大数紧凑格式化(界面语言相关):zh 万/亿,en k/M/B;非法返回 null */
  function formatTokens(n) {
    if (typeof n !== 'number' || !isFinite(n)) return null;
    if (TM_LANG === 'en') {
      if (n >= 1e9) return trimNum(n / 1e9, 2) + 'B';
      if (n >= 1e6) return trimNum(n / 1e6, 1) + 'M';
      if (n >= 1e3) return trimNum(n / 1e3, 1) + 'k';
      return String(Math.round(n));
    }
    if (n >= 1e8) return trimNum(n / 1e8, 2) + '亿';
    if (n >= 1e4) return trimNum(n / 1e4, 1) + '万';
    return String(Math.round(n));
  }

  /** 行内线性图标(与宿主 icons.tsx 同形:24 viewBox 1.8px 圆角描边,currentColor) */
  var ICON_TRASH =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 6h18"/>' +
    '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>' +
    '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>' +
    '<path d="M10 11v6M14 11v6"/></svg>';
  var ICON_REFRESH =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20 12a8 8 0 1 1-2.3-5.6"/>' +
    '<path d="M20 3v4h-4"/></svg>';
  var ICON_WINDOW =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="4" y="6" width="16" height="12" rx="1.5"/>' +
    '<path d="M4 10h16"/></svg>';
  var ICON_HIDE =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/>' +
    '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/>' +
    '<path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/>' +
    '<line x1="2" y1="2" x2="22" y2="22"/></svg>';
  var ICON_BELL =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>' +
    '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>' +
    '<path d="M4 2C2.8 2.6 2 3.9 2 5.4"/>' +
    '<path d="M20 2c1.2.6 2 1.9 2 3.4"/></svg>';

  /** 拉取并写缓存:成功刷新该账号缓存(带 fetchedAt),失败不覆盖上次成功 cache */
  function fetchAndCache(account) {
    return window.pvTokenMonitor.refreshAccount(account).then(function (data) {
      data.fetchedAt = Date.now();
      return pv.storage.set(KV_CACHE_PREFIX + accountScope(account), data)
        .then(function () { return data; })
        .catch(function () { return data; }); // 缓存写失败不影响本次数据展示
    });
  }

  /** 读取该账号上次成功 cache:<provider>:<label>(label "default" 回落旧
   *  cache:<provider> 兼容旧单账号缓存;无数据返回 null) */
  function readCache(account) {
    return pv.storage.get(KV_CACHE_PREFIX + accountScope(account)).then(function (data) {
      if (data && typeof data === 'object') return data;
      if (account.label !== 'default') return null;
      return pv.storage.get(KV_CACHE_PREFIX + account.provider).then(function (old) {
        return old && typeof old === 'object' ? old : null;
      });
    }).catch(function () { return null; });
  }

  /** 读该账号告警阈值配置 tm.alert.<scope>:缺省/纠偏回 {enabled:false, threshold:80}。
   *  双实例皆只读本函数;写入仅面板实例(单写者,与 tm.accounts 约定一致),球实例只读 */
  function readAlertCfg(account) {
    return pv.storage.get(KV_ALERT_PREFIX + accountScope(account)).then(function (cfg) {
      if (!cfg || typeof cfg !== 'object') {
        return { enabled: false, threshold: ALERT_DEFAULT_THRESHOLD };
      }
      var thr = numOrNull(cfg.threshold);
      if (thr === null) thr = ALERT_DEFAULT_THRESHOLD;
      thr = Math.min(ALERT_MAX, Math.max(ALERT_MIN, Math.round(thr)));
      return { enabled: cfg.enabled === true, threshold: thr };
    }).catch(function () {
      return { enabled: false, threshold: ALERT_DEFAULT_THRESHOLD };
    });
  }

  /** 告警派生(纯 UI 派生,不持久化告警事件):开关开 && 未被错误/空态阻断 && pct ≥ 阈值。
   *  pct 取该账号 fiveHour.percent(可为 null);blocked 由调用方传(球=错误/空态,卡=取数错误) */
  function isAlerting(cfg, pct, blocked) {
    if (!cfg || cfg.enabled !== true || blocked) return false;
    return pct !== null && pct !== undefined && pct >= cfg.threshold;
  }

  function tmEl(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // ---------- 实例判定:球窗(label = pv-plugin-<id>)不写账号清单 ----------

  var IS_BALL_WINDOW = (function () {
    try {
      var internals = window.__TAURI_INTERNALS__;
      var meta = internals && internals.metadata;
      var label = meta && meta.currentWindow && meta.currentWindow.label;
      return label === 'pv-plugin-' + pv.pluginId;
    } catch (e) { return false; }
  })();

  // ---------- 账号清单:读 / 写 / 迁移(单写者=面板实例) ----------

  /** 读账号清单(纠偏保序);缺失/为空返回 [](球实例空清单时走 fallback 视图) */
  function readAccounts() {
    return pv.storage.get(KV_ACCOUNTS).then(function (value) {
      return sanitizeAccounts(value);
    }).catch(function () { return []; });
  }

  function writeAccounts(list) {
    return pv.storage.set(KV_ACCOUNTS, list).catch(function (err) {
      throw new Error(tm('credFail') + ((err && err.message) || String(err)));
    });
  }

  /**
   * 迁移(首启动):tm.accounts 缺失/为空 → 探测各 provider 的 legacy 配置态
   * (桥 configured() 无参,等价逐 provider configured('provider'),命中新旧任一)
   * → 命中者建 {provider, label:"default"} 入清单。幂等:仅命中才落盘,已有清单
   * 原样返回。仅面板实例调用(清单单写者);球实例只读,空清单走 fallback 视图。
   */
  function ensureAccountsMigrated() {
    if (IS_BALL_WINDOW) return readAccounts();
    return readAccounts().then(function (list) {
      if (list.length > 0) return list;
      return Promise.resolve(pv.credentials.configured()).then(function (configuredList) {
        var migrated = (Array.isArray(configuredList) ? configuredList : [])
          .filter(function (p) { return !!PROVIDERS[p]; })
          .map(function (p) { return { provider: p, label: 'default' }; });
        if (migrated.length === 0) return [];
        return writeAccounts(migrated).then(function () { return migrated; });
      }).catch(function () { return []; });
    });
  }

  /** 逐账号探测已配置态(并行),返回配置齐全的账号子序列(保清单序) */
  function probeConfiguredAccounts(accounts) {
    return Promise.all(accounts.map(function (account) {
      return Promise.resolve(pv.credentials.configured(accountScope(account)))
        .then(function (ok) { return ok === true ? account : null; })
        .catch(function () { return null; });
    })).then(function (results) {
      return results.filter(function (a) { return a !== null; });
    });
  }

  /**
   * 球实例的账号视图:清单非空 → 逐账号探测过滤;空清单(未迁移)→ legacy
   * fallback 视图 —— configured() 无参探测已配置 provider,映射为 default 账号
   * (与迁移产出一致,内存态不写 kv,保持清单单写者=面板实例)。
   */
  function loadBallAccounts() {
    return readAccounts().then(function (list) {
      if (list.length > 0) return probeConfiguredAccounts(list);
      return Promise.resolve(pv.credentials.configured()).then(function (configuredList) {
        return (Array.isArray(configuredList) ? configuredList : [])
          .filter(function (p) { return !!PROVIDERS[p]; })
          .map(function (p) { return { provider: p, label: 'default' }; });
      }).catch(function () { return []; });
    });
  }

  // ---------- 样式:一次性注入(类前缀 pv-tm-,颜色全部走宿主 CSS token) ----------

  function ensureTmStyles() {
    if (document.getElementById('pv-tm-style')) return;
    var style = document.createElement('style');
    style.id = 'pv-tm-style';
    style.textContent = [
      '.pv-tm-wrap{position:relative;width:100%;height:100%;}',
      '.pv-tm-ball{position:absolute;left:50%;top:4px;width:76px;height:76px;margin-left:-38px;',
        'background:transparent;border:none;padding:0;cursor:pointer;display:block;',
        'transition:transform .15s ease;}',
      '.pv-tm-ball:hover{transform:scale(1.05);}',
      '.pv-tm-ball:active{transform:scale(0.96);}',
      '.pv-tm-ball svg{display:block;}',
      // 桌面任意壁纸上可读:文字加 panel 色光晕描边(paint-order 先描后填,字形干净)
      '.pv-tm-abbr{font-size:15px;font-weight:600;fill:var(--text);',
        'paint-order:stroke;stroke:var(--panel);stroke-width:3px;stroke-linejoin:round;}',
      '.pv-tm-intl{font-size:9px;fill:var(--muted);',
        'paint-order:stroke;stroke:var(--panel);stroke-width:2.5px;stroke-linejoin:round;}',
      '.pv-tm-pct{font-size:11px;fill:var(--text);font-variant-numeric:tabular-nums;',
        'paint-order:stroke;stroke:var(--panel);stroke-width:2.5px;stroke-linejoin:round;}',
      '.pv-tm-pct.err{fill:var(--danger);font-weight:700;}',
      '.pv-tm-pct.empty{fill:var(--muted);}',
      '.pv-tm-ring{transition:stroke-dashoffset .4s ease,stroke .4s ease;}',
      // 右键菜单:与主窗卡片同族(10px 圆角),动作行带同形小图标,选中账号加粗
      '.pv-tm-menu{position:absolute;left:4px;top:84px;width:172px;z-index:10;',
        'background:var(--panel);border:1px solid var(--border);border-radius:10px;',
        'padding:5px;box-shadow:var(--shadow-lg);}',
      '.pv-tm-menu-item{display:flex;justify-content:space-between;align-items:center;gap:12px;',
        'padding:6px 9px;border-radius:6px;font-size:12px;color:var(--text);cursor:pointer;',
        'white-space:nowrap;transition:background .12s ease;}',
      // 悬停高亮走项目「指向项」惯用色 --accent-soft(.row.active/.option:hover 同源):
      // --panel-hover 与菜单底色同族过淡,球窗小字号下不可辨;移出即随 :hover 还原
      '.pv-tm-menu-item:hover{background:var(--accent-soft);}',
      '.pv-tm-menu-item .pv-tm-check{color:var(--accent);font-weight:700;}',
      '.pv-tm-menu-item.pv-tm-selected .pv-tm-menu-label{font-weight:600;}',
      '.pv-tm-menu-label{display:inline-flex;align-items:center;gap:7px;min-width:0;',
        'overflow:hidden;text-overflow:ellipsis;}',
      '.pv-tm-menu-icon{display:inline-flex;color:var(--muted);flex-shrink:0;}',
      '.pv-tm-menu-item:hover .pv-tm-menu-icon{color:var(--accent);}',
      '.pv-tm-menu-head{padding:5px 9px 3px;font-size:11px;font-weight:600;color:var(--muted);}',
      '.pv-tm-menu-sep{height:1px;background:var(--border);margin:4px 6px;}',
      // 面板:主-分栏仪表布局(账号卡在左,设置栏在右;总宽对齐插件区 880px 节奏;
      // 窄窗口塌成单列)。max-width 与 .ph-list(860px)同族,避免左满右空失衡
      '.pv-tm-panel{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:12px;',
        'max-width:880px;align-items:start;}',
      '.pv-tm-col{display:flex;flex-direction:column;gap:10px;min-width:0;}',
      '.pv-tm-side{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px;}',
      '@media (max-width:760px){.pv-tm-panel{grid-template-columns:1fr;}}',
      '.pv-tm-cards{display:flex;flex-direction:column;gap:10px;}',
      '.pv-tm-cards-head{display:flex;justify-content:flex-end;}',
      '.pv-tm-card{border:1px solid var(--border);border-radius:10px;padding:12px 14px;',
        'display:flex;flex-direction:column;gap:10px;background:var(--panel);}',
      '.pv-tm-card-head{display:flex;align-items:center;gap:10px;}',
      '.pv-tm-abbr-chip{width:34px;height:34px;border-radius:9px;background:var(--accent-soft);',
        'color:var(--accent);font-size:12px;font-weight:700;letter-spacing:.03em;white-space:nowrap;',
        'display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
      '.pv-tm-abbr-chip sup{font-size:8px;font-weight:600;margin-left:1px;}',
      '.pv-tm-card-titlewrap{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1;}',
      '.pv-tm-card-title{font-size:13px;font-weight:600;color:var(--text);}',
      '.pv-tm-card-sub{font-size:11px;color:var(--muted);white-space:nowrap;',
        'overflow:hidden;text-overflow:ellipsis;}',
      // 计量条:track 中性面(--border),fill accent,≥80% 转 danger —— 面板的记忆点
      '.pv-tm-meter{display:flex;flex-direction:column;gap:5px;}',
      '.pv-tm-meter-top{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:12px;}',
      '.pv-tm-meter-name{color:var(--muted);}',
      '.pv-tm-meter-val{color:var(--text);font-weight:600;font-variant-numeric:tabular-nums;}',
      '.pv-tm-meter-val.danger{color:var(--danger);}',
      '.pv-tm-meter-track{height:6px;border-radius:999px;background:var(--border);overflow:hidden;}',
      '.pv-tm-meter-fill{height:100%;border-radius:999px;background:var(--accent);transition:width .3s ease;}',
      '.pv-tm-meter-fill.danger{background:var(--danger);}',
      '.pv-tm-meter-sub{font-size:11px;color:var(--muted);}',
      // 24h 聚合 / MCP 月度双瓦片(GLM 系)
      '.pv-tm-tiles{display:flex;gap:8px;}',
      '.pv-tm-tile{flex:1;min-width:0;background:var(--body-bg);border-radius:8px;padding:8px 10px;',
        'display:flex;flex-direction:column;gap:2px;}',
      '.pv-tm-tile-label{font-size:11px;color:var(--muted);}',
      '.pv-tm-tile-value{font-size:13px;font-weight:600;color:var(--text);',
        'font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.pv-tm-card-error{color:var(--danger);font-size:12px;background:var(--danger-soft);',
        'border-radius:7px;padding:6px 8px;word-break:break-all;}',
      '.pv-tm-empty{color:var(--muted);font-size:12px;text-align:center;padding:18px 12px;',
        'border:1px dashed var(--border);border-radius:10px;}',
      '.pv-tm-muted{color:var(--muted);font-size:12px;}',
      // 设置区(侧栏卡内):小节标题 + 表单行
      '.pv-tm-settings{display:flex;flex-direction:column;gap:8px;}',
      '.pv-tm-section-title{font-size:12px;font-weight:600;color:var(--text);}',
      '.pv-tm-form-row{display:flex;align-items:center;gap:8px;}',
      '.pv-tm-form-row .input{flex:1 1 0;min-width:0;width:auto;}',
      '.pv-tm-add-status{color:var(--muted);font-size:12px;min-height:1em;}',
      '.pv-tm-add-status.err{color:var(--danger);}',
      // 账号列表行
      '.pv-tm-acct-list{display:flex;flex-direction:column;gap:6px;}',
      '.pv-tm-acct-row{display:flex;align-items:center;gap:10px;padding:7px 10px;',
        'border:1px solid var(--border);border-radius:8px;background:var(--panel);font-size:12px;}',
      '.pv-tm-acct-chip{width:24px;height:24px;border-radius:7px;background:var(--panel-hover);',
        'color:var(--muted);font-size:10px;font-weight:700;letter-spacing:.03em;white-space:nowrap;',
        'display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
      '.pv-tm-acct-main{display:flex;flex-direction:column;min-width:0;flex:1;gap:1px;}',
      '.pv-tm-acct-name{color:var(--text);font-weight:600;overflow:hidden;',
        'text-overflow:ellipsis;white-space:nowrap;}',
      '.pv-tm-acct-sub{color:var(--muted);font-size:11px;overflow:hidden;',
        'text-overflow:ellipsis;white-space:nowrap;}',
      '.pv-tm-status{display:inline-flex;align-items:center;gap:5px;font-size:11px;',
        'color:var(--muted);flex-shrink:0;}',
      '.pv-tm-status::before{content:"";width:6px;height:6px;border-radius:50%;',
        'background:var(--border-strong);}',
      '.pv-tm-status.ok{color:var(--accent);}',
      '.pv-tm-status.ok::before{background:var(--accent);}',
      '.pv-tm-acct-del{border:none;background:none;cursor:pointer;color:var(--muted);',
        'padding:4px;border-radius:6px;display:inline-flex;align-items:center;flex-shrink:0;',
        'transition:color .15s ease,background .15s ease;}',
      '.pv-tm-acct-del:hover{color:var(--danger);background:var(--danger-soft);}',
      // 轮询行:自制 switch(与宿主 .switch 同观感)+ 窄数字框
      '.pv-tm-poll-row{display:flex;align-items:center;gap:10px;font-size:12px;}',
      '.pv-tm-poll-label{color:var(--muted);}',
      '.pv-tm-switch{position:relative;display:inline-block;width:34px;height:19px;flex-shrink:0;}',
      '.pv-tm-switch input{opacity:0;width:0;height:0;position:absolute;margin:0;}',
      '.pv-tm-switch span{position:absolute;inset:0;border-radius:999px;',
        'background:var(--border-strong);transition:background .15s ease;cursor:pointer;}',
      '.pv-tm-switch span::before{content:"";position:absolute;width:15px;height:15px;left:2px;top:2px;',
        'border-radius:50%;background:var(--panel);transition:transform .15s ease;}',
      '.pv-tm-switch input:checked + span{background:var(--accent);}',
      '.pv-tm-switch input:checked + span::before{transform:translateX(15px);}',
      '.pv-tm-poll-row .input{width:84px;margin-left:auto;flex:none;}',
      // 告警阈值行:每账号一行 [缩写 chip | switch | 滑杆 4px 轨道 14px thumb | 数值];
      // 关闭态整行 opacity .45、滑杆不可交互(视觉规格见设计稿 §3)
      '.pv-tm-alert-list{display:flex;flex-direction:column;gap:8px;}',
      '.pv-tm-alert-row{display:flex;align-items:center;gap:8px;font-size:12px;}',
      '.pv-tm-alert-chip{flex-shrink:0;width:44px;text-align:center;font-size:11px;font-weight:600;',
        'color:var(--accent);background:var(--accent-soft);border-radius:999px;padding:3px 0;}',
      '.pv-tm-alert-chip sup{font-size:8px;font-weight:600;margin-left:1px;}',
      '.pv-tm-slider{flex:1;min-width:100px;height:4px;border-radius:999px;',
        '-webkit-appearance:none;appearance:none;outline-offset:2px;cursor:pointer;',
        'background:var(--border-strong);border:none;padding:0;margin:0;}',
      '.pv-tm-slider::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;',
        'width:14px;height:14px;border-radius:999px;background:var(--panel);',
        'border:2px solid var(--border-strong);}',
      '.pv-tm-slider:disabled{cursor:default;}',
      '.pv-tm-alert-val{flex-shrink:0;width:38px;text-align:right;font-size:12px;font-weight:600;',
        'color:var(--text);font-variant-numeric:tabular-nums;}',
      '.pv-tm-alert-row.pv-tm-alert-off{opacity:.45;}',
      '.pv-tm-alert-row.pv-tm-alert-off .pv-tm-slider{pointer-events:none;}',
      '.pv-tm-alert-row.pv-tm-alert-off .pv-tm-alert-val{color:var(--muted);font-weight:400;}',
      // 卡片告警胶囊:danger-soft 底 + danger 字 + 小铃铛,999px 圆角(设计稿 §3)
      '.pv-tm-card-alert{display:inline-flex;align-items:center;gap:5px;flex-shrink:0;',
        'background:var(--danger-soft);color:var(--danger);border-radius:999px;',
        'padding:3px 9px;font-size:11px;font-weight:600;white-space:nowrap;}',
      // 球告警态:脉冲图层常驻 DOM(默认 opacity 0,告警态 2.4s 呼吸;reduced-motion 降级
      // 静态外圈)+ 右上角徽标(containing block = .pv-tm-ball 自身定位)
      '.pv-tm-pulse{opacity:0;transform-origin:38px 38px;}',
      '.pv-tm-ball.pv-tm-alerting .pv-tm-pulse{animation:pv-tm-pulse 2.4s ease-in-out infinite;}',
      '@keyframes pv-tm-pulse{0%,100%{opacity:.16;transform:scale(1);}50%{opacity:.5;transform:scale(1.07);}}',
      '@media (prefers-reduced-motion: reduce){',
        '.pv-tm-ball.pv-tm-alerting .pv-tm-pulse{animation:none;opacity:.32;}}',
      '.pv-tm-badge{display:none;position:absolute;top:2px;right:9px;width:10px;height:10px;',
        'border-radius:999px;background:var(--danger);box-shadow:0 0 0 2px var(--panel);}',
      '.pv-tm-ball.pv-tm-alerting .pv-tm-badge{display:block;}'
    ].join('');
    document.head.appendChild(style);
  }

  // ---------- 球体(pv.window.setup;仅球窗实例的 onMount 会执行) ----------

  var ballAccount = null;    // 当前账号 scope('provider:label')
  var ballData = null;       // 当前账号最近一次成功数据(cache 或本次拉取)
  var ballError = null;      // 最近一次取数错误摘要
  var ballNoConfigured = false; // 无已配置账号的灰态
  var ballAlertCfg = null;   // 当前账号告警阈值配置(readAlertCfg 结果;球实例只读)
  var pollTimer = null;      // 球实例持有;面板实例不轮询
  var pollPeriodMs = 0;

  pv.window.setup({
    size: { width: BALL_SIZE, height: BALL_SIZE },
    onMount: function (el) { setupBall(el); }
  });

  function setupBall(el) {
    ensureTmStyles();
    el.innerHTML = '';
    var wrap = tmEl('div', 'pv-tm-wrap');
    // 不挂 data-tauri-drag-region:原生脚本的双击 = 切换最大化,84px 透明球窗
    // 被最大化成全屏透明窗口后会拦截全部鼠标事件(冒烟实测);
    // 拖动统一走球体的「按住超阈值 → plugin_start_drag」自定义路径
    wrap.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      openTmMenu(wrap);
    });
    var ball = tmEl('button', 'pv-tm-ball');
    ball.type = 'button';
    // 点击/拖动分区(§5.2):球是 <button>,原生 drag-region 脚本豁免按钮元素,
    // 按球拖不动(冒烟实测)——球体自实现分区:mousedown 记录起点,mousemove
    // 超过 6px 即启动系统拖动(plugin:window|start_dragging,拖动终点位置由
    // Rust Moved 防抖独占落盘),未超阈值的松开视为左键轮换。
    // 衬垫(wrap 空白区)仍走原生 data-tauri-drag-region 拖动。
    var dragState = null;
    ball.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return; // 右键走 contextmenu 菜单
      dragState = { x: e.screenX, y: e.screenY, moved: false };
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragState || dragState.moved) return;
      var dx = e.screenX - dragState.x;
      var dy = e.screenY - dragState.y;
      if (dx * dx + dy * dy > 36) {
        dragState.moved = true;
        try {
          // 自定义命令不经 capability 校验(冒烟实测 core 权限面差异会让拖动静默失效)
          void window.__TAURI_INTERNALS__.invoke('plugin_start_drag', { pluginId: pv.pluginId });
        } catch (err) { /* 纯浏览器预览无 Tauri:忽略 */ }
      }
    });
    ball.addEventListener('mouseup', function () {
      var wasClick = dragState !== null && !dragState.moved;
      dragState = null;
      if (wasClick) rotateAccount();
    });
    wrap.appendChild(ball);
    var menu = tmEl('div', 'pv-tm-menu');
    menu.hidden = true;
    wrap.appendChild(menu);
    el.appendChild(wrap);

    // 失焦即收起(球窗右键菜单;§9)
    window.addEventListener('blur', function () { closeTmMenu(wrap); });

    renderBall();
    // 启动序列:取账号视图(清单或 fallback)→ 升级旧 selection → 渲染上次成功
    // cache → 拉一次新数据 → 轮询
    loadBallAccounts().then(function (accounts) {
      if (accounts.length === 0) {
        ballNoConfigured = true;
        renderBall();
        return null;
      }
      return pv.storage.get(KV_PROVIDER).then(function (saved) {
        var selection = upgradeSelection(saved);
        var ids = accounts.map(function (a) { return accountScope(a); });
        ballAccount = ids.indexOf(selection) >= 0 ? selection : ids[0];
        return loadBallAlertCfg().then(function () {
          renderBall();
          return readCache(accountOf(ballAccount, accounts)).then(function (cached) {
            if (cached) {
              ballData = cached;
              renderBall();
            }
            return refreshBallData().then(function () {
              startPollIfEnabled();
            });
          });
        });
      });
    }).catch(function (err) {
      // 桥异常(如 storage 不可用):球体降级为错误态,不拖垮窗口
      ballError = (err && err.message) || String(err);
      renderBall();
    });
  }

  /** 由 scope 在账号视图里找回账号对象;找不到(null selection 等)回退首个 */
  function accountOf(scope, accounts) {
    for (var i = 0; i < accounts.length; i++) {
      if (accountScope(accounts[i]) === scope) return accounts[i];
    }
    return accounts[0] || null;
  }

  /** 球体渲染:圆环 = 当前账号 5h 百分比;环底 --border、进度 --accent(≥80% --danger)、
   *  中心 abbr(国际角标 i)+ 百分比;失败态环保留最近缓存值 + 中心「!」,
   *  tooltip 错误摘要。告警态:SVG 最前为常驻脉冲图层(r=35,描边随环色,
   *  零告警 opacity 0)+ svg 后常驻徽标(display:none,告警态显现);
   *  注意 innerHTML 每次重建,脉冲/徽标必须在模板内(常驻 DOM),不能挂外部节点 */
  function renderBall() {
    var wrap = document.querySelector('.pv-tm-wrap');
    if (!wrap) return;
    var ball = wrap.querySelector('.pv-tm-ball');
    if (!ball) return;
    var account = ballAccount ? parseScope(ballAccount) : null;
    var meta = account ? PROVIDERS[account.provider] : null;
    var pct = ballData && ballData.fiveHour ? ballData.fiveHour.percent : null;
    var ring = 201.06; // 2πr(r=32)
    var offset = pct === null ? ring : ring * (1 - Math.min(100, Math.max(0, pct)) / 100);
    var stroke = pct !== null && pct >= 80 ? 'var(--danger)' : 'var(--accent)';
    var abbr = meta ? meta.abbr : '—';
    var intl = meta && meta.intl ? '<tspan class="pv-tm-intl" dy="-4">i</tspan>' : '';
    var pctClass = ballError ? 'pv-tm-pct err' : (pct === null ? 'pv-tm-pct empty' : 'pv-tm-pct');
    var center2 = ballError ? '!' : (pct === null ? '–' : (Math.round(pct * 100) / 100) + '%');
    ball.innerHTML =
      '<svg viewBox="0 0 76 76" width="76" height="76" aria-hidden="true">' +
      // 常驻脉冲图层:告警态经 .pv-tm-alerting 激活 CSS 呼吸动画
      '<circle class="pv-tm-pulse" cx="38" cy="38" r="35" fill="none" stroke="' + stroke + '" stroke-width="3"/>' +
      '<circle cx="38" cy="38" r="32" fill="none" stroke="var(--border-strong)" stroke-width="6"/>' +
      '<circle class="pv-tm-ring" cx="38" cy="38" r="32" fill="none" stroke="' + stroke + '" stroke-width="6" ' +
      'stroke-linecap="round" stroke-dasharray="' + ring + '" stroke-dashoffset="' + offset + '" transform="rotate(-90 38 38)"/>' +
      '<text class="pv-tm-abbr" x="38" y="36" text-anchor="middle">' + abbr + intl + '</text>' +
      '<text class="' + pctClass + '" x="38" y="51" text-anchor="middle">' + center2 + '</text>' +
      '</svg>' +
      // 常驻徽标(display:none;containing block = .pv-tm-ball 自身已定位)
      '<div class="pv-tm-badge"></div>';
    ball.title = buildBallTooltip();
    applyAlertStates(ball);
  }

  /** scope 字符串 → 账号对象(球内部状态用;仅信任内部构造的 'provider:label') */
  function parseScope(scope) {
    var idx = scope.indexOf(':');
    if (idx <= 0 || idx === scope.length - 1) return null;
    return { provider: scope.slice(0, idx), label: scope.slice(idx + 1) };
  }

  /** tooltip:供应商+label / 5h% / 周% / 距重置倒计时;失败附错误摘要;空态提示添加账号 */
  function buildBallTooltip() {
    if (ballNoConfigured) return tm('ballEmpty');
    if (!ballAccount) return tm('ballEmpty');
    var account = parseScope(ballAccount);
    var meta = account ? PROVIDERS[account.provider] : null;
    var lines = [meta ? meta.label + ' · ' + account.label : ballAccount];
    if (ballData) {
      var five = ballData.fiveHour || {};
      var week = ballData.weekly || {};
      var fivePct = five.percent === null || five.percent === undefined ? '–' : five.percent + '%';
      var weekPct = week.percent === null || week.percent === undefined ? '–' : week.percent + '%';
      lines.push(tm('fiveHour') + ' ' + fivePct +
        (five.resetAt ? ' · ' + formatCountdown(five.resetAt) : ''));
      lines.push(tm('weekly') + ' ' + weekPct +
        (week.resetAt ? ' · ' + formatCountdown(week.resetAt) : ''));
    }
    // 告警行:当前账号派生告警态时追加(title 原生文本,无样式 —— 设计稿弹层为示意)
    if (isBallAlerting()) {
      lines.push(tm('alertTooltip').replace('{n}', String(ballAlertCfg.threshold)));
    }
    if (ballError) {
      lines.push(tm('errPrefix') + ballError);
    }
    if (!ballData && !ballError) lines.push(tm('noData'));
    if (!ballError) lines.push(tm('ballIdle'));
    return lines.join('\n');
  }

  /** 左键:在全部已配置账号间轮换并立即取数(每次现读账号视图,保持新鲜;
   *  当前不在序列(如已被面板删除)时从首个账号重新开始) */
  function rotateAccount() {
    loadBallAccounts().then(function (accounts) {
      if (accounts.length === 0) {
        ballNoConfigured = true;
        ballAccount = null;
        ballData = null;
        ballError = null;
        renderBall();
        return;
      }
      var ids = accounts.map(function (a) { return accountScope(a); });
      var idx = ids.indexOf(ballAccount);
      setAccount(ids[(idx + 1) % ids.length], accounts);
    }).catch(function (err) {
      ballError = (err && err.message) || String(err);
      renderBall();
    });
  }

  /** 切换账号:复位状态 → 持久化('provider:label')→ 读新账号告警配置 → 渲染缓存 → 拉新数据 */
  function setAccount(scope, accounts) {
    var account = accountOf(scope, accounts || [parseScope(scope)].filter(Boolean));
    ballNoConfigured = false;
    ballAccount = accountScope(account);
    ballData = null;
    ballError = null;
    ballAlertCfg = null;
    renderBall();
    pv.storage.set(KV_PROVIDER, ballAccount).catch(function () {});
    // 账号切换时读新配置(面板写入不跨窗通知,球在切换/取数时读到 —— 已知局限,见卡)
    loadBallAlertCfg().then(renderBall).catch(function () {});
    var proceed = readCache(account).then(function (cached) {
      if (cached) {
        ballData = cached;
        renderBall();
      }
      return refreshBallData();
    });
    void proceed;
  }

  /** 球读当前账号告警配置(账号切换/取数完成时刷新;写入仅面板实例,球只读) */
  function loadBallAlertCfg() {
    var account = ballAccount ? parseScope(ballAccount) : null;
    if (!account) {
      ballAlertCfg = null;
      return Promise.resolve();
    }
    return readAlertCfg(account).then(function (cfg) {
      ballAlertCfg = cfg;
    });
  }

  /** 球当前账号告警派生:开关开 && 无错误/无空态 && 5h% ≥ 阈值(纯派生,不持久化) */
  function isBallAlerting() {
    if (ballError || ballNoConfigured || !ballData) return false;
    var pct = ballData.fiveHour ? ballData.fiveHour.percent : null;
    return isAlerting(ballAlertCfg, pct, false);
  }

  /** 球告警态 DOM:按派生结果 toggle 容器类 .pv-tm-alerting(脉冲/徽标随 CSS 显隐) */
  function applyAlertStates(ball) {
    ball.classList.toggle('pv-tm-alerting', isBallAlerting());
  }

  /**
   * 通知状态机(edge-trigger,每账号每窗口周期最多一条;球实例独占,面板实例零开销跳过)。
   * 按账号传参评估(不再读模块单值 ballData/ballAlertCfg):轮转周期(P2)内每账号
   * 刷完即评,「立即刷新」等当前账号路径同此入口。去重按窗口周期:tm.alertState.<scope>
   * 记录已通知窗口的 resetAt,与当次相同 → 不重发(同窗口回落再回升也不重发,
   * resetAt 是窗口身份,预期行为);resetAt 变化(新窗口)即重新武装。重启后状态从
   * kv 恢复,同窗口不重发。
   * 窗口身份缺失(上游未给 resetAt)→ 保守不发:宁漏勿扰 —— 无身份即无法去重,
   * 可能连环打扰。窗口已结束(resetAt ≤ now,M3)→ 不发:过期数据可能源于通知失败
   * 重启后载入的过期 cache 或上游滞后的已结束窗口,基于它发通知是误报。
   * 通知/写状态任何失败一律吞掉:通知是副作用,不污染渲染链;
   * 通知成功才写状态(失败不写,下次取数重试 —— 通知侧宁重勿漏)。
   */
  function maybeNotifyFor(account, data, cfg) {
    if (!IS_BALL_INSTANCE) return Promise.resolve(); // 面板/主窗实例:零开销跳过
    var pct = data && data.fiveHour ? data.fiveHour.percent : null;
    if (!isAlerting(cfg, pct, false)) return Promise.resolve();
    var resetAt = data && data.fiveHour ? data.fiveHour.resetAt : null;
    if (!resetAt) return Promise.resolve(); // 窗口身份缺失:保守不发(宁漏勿扰)
    // M3 时效守卫:窗口已结束的过期数据不发通知(宁漏勿扰)—— 通知失败重启后
    // 载入的过期 cache、上游滞后的已结束窗口,不再基于过期数据发真通知
    if (new Date(resetAt).getTime() <= Date.now()) return Promise.resolve();
    var stateKey = KV_ALERT_STATE_PREFIX + accountScope(account);
    return pv.storage.get(stateKey).then(function (state) {
      if (state && typeof state === 'object' && state.resetAt === resetAt) return; // 同窗口已发
      var meta = PROVIDERS[account.provider];
      var name = (meta ? meta.label : account.provider) +
        (account.label !== 'default' ? ' · ' + account.label : '');
      var body = tm('notifyBody')
        .replace('{name}', name)
        .replace('{pct}', String(data.fiveHour.percent))
        .replace('{thr}', String(cfg.threshold));
      return pv.notify(tm('notifyTitle'), body).then(function () {
        // 通知成功才写状态(通知失败不写,下次取数重试;写状态失败同窗口可能重发一次,
        // 宁重勿漏)
        return pv.storage.set(stateKey, { firedAt: new Date().toISOString(), resetAt: resetAt });
      });
    }).catch(function () {
      /* 通知或状态写入失败:静默(通知是副作用,不污染渲染链;下次取数重新评估) */
    });
  }

  /**
   * 轮转周期原子步:该账号 readAlertCfg → fetchAndCache → 成功即按账号评估通知;
   * 当前账号额外同步球显示链(ballData/ballAlertCfg/ballError),通知与状态写入
   * 先于 renderBall 完成(并发双发窗口归零)。失败:cache 不覆盖(既有语义),
   * 仅当前账号设 ballError 提示,非当前账号静默跳过(监测盲区由下轮周期补)。
   */
  function refreshAccountCycleStep(account) {
    var scope = accountScope(account);
    return readAlertCfg(account).then(function (cfg) {
      return fetchAndCache(account).then(function (data) {
        if (ballAccount === scope) {
          ballData = data;
          ballError = null;
          ballAlertCfg = cfg;
        }
        return maybeNotifyFor(account, data, cfg).then(function () {
          if (ballAccount === scope) renderBall();
        });
      });
    }).catch(function (err) {
      if (ballAccount === scope) {
        ballError = (err && err.message) || String(err);
        renderBall();
      }
    });
  }

  /** 拉当前账号数据并渲染(= 轮转周期原子步的当前账号单步;菜单「立即刷新」/
   *  账号切换/挂载首刷共用);失败:环保留缓存值 + 中心「!」+ tooltip 错误 */
  function refreshBallData() {
    if (!ballAccount) return Promise.resolve();
    var account = parseScope(ballAccount);
    if (!account) return Promise.resolve();
    return refreshAccountCycleStep(account);
  }

  /** 告警轮转周期(P2):对全部账号串行 fetchAndCache,每账号刷完即独立评估通知
   *  —— 原 tick 仅刷当前账号,N 账号任意时刻仅 1 个被监测的盲区消除;
   *  N×15s 单账号取数超时上界 vs ≥120s 轮询下限(N≤5 成立),重入守卫兜底任意 N */
  function runAlertCycle(accounts) {
    var chain = Promise.resolve();
    for (var i = 0; i < accounts.length; i++) {
      (function (account) {
        chain = chain.then(function () {
          return refreshAccountCycleStep(account);
        });
      })(accounts[i]);
    }
    return chain;
  }

  /** 轮询生命周期(§5.2):球实例持有 —— mount 且 ball.poll.enabled 即启;
   *  每 tick 重读配置与账号视图(面板增删账号经 kv 同步,删除当前账号即切下一个),
   *  停用即自停,间隔变更重启 */
  function startPollIfEnabled() {
    stopPoll();
    pv.storage.get(KV_POLL).then(function (cfg) {
      if (!cfg || cfg.enabled !== true) return;
      pollPeriodMs = clampPollSec(cfg.intervalSec) * 1000;
      pollTimer = window.setInterval(function () {
        pv.storage.get(KV_POLL).then(function (cfg2) {
          if (!cfg2 || cfg2.enabled !== true) {
            stopPoll();
            return;
          }
          var p = clampPollSec(cfg2.intervalSec) * 1000;
          if (p !== pollPeriodMs) {
            startPollIfEnabled(); // 间隔变更:重启计时器
            return;
          }
          tickBall();
        }).catch(function () { stopPoll(); });
      }, pollPeriodMs);
    }).catch(function () { /* 配置读取失败:保持手动模式 */ });
  }

  /** tick:重读账号视图同步清单(删除/失效账号自动让位),再对全部账号串行轮转
   *  刷新(原仅当前账号 → 其余账号监测盲区,P2);in-flight 重入守卫:上一轮
   *  未完新 tick 到点直接跳过(interval ≥120s vs N×15s 超时上界,N≤5 成立,
   *  守卫兜底任意 N) */
  var cycleInFlight = false;
  function tickBall() {
    if (cycleInFlight) return;
    cycleInFlight = true;
    loadBallAccounts().then(function (accounts) {
      if (accounts.length === 0) {
        ballNoConfigured = true;
        ballAccount = null;
        ballData = null;
        ballError = null;
        renderBall();
        return;
      }
      var ids = accounts.map(function (a) { return accountScope(a); });
      if (ids.indexOf(ballAccount) < 0) {
        // 当前账号已被删除/失效:切到清单首个(仅切选择与显示,取数由本轮 cycle
        // 覆盖;不走 setAccount —— 其独立取数链会与本轮 cycle 重复 fetch)
        ballNoConfigured = false;
        ballAccount = ids[0];
        ballData = null;
        ballError = null;
        renderBall();
        pv.storage.set(KV_PROVIDER, ballAccount).catch(function () {});
      }
      return runAlertCycle(accounts);
    }).catch(function (err) {
      ballError = (err && err.message) || String(err);
      renderBall();
    }).then(function () {
      cycleInFlight = false;
    });
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      pollPeriodMs = 0;
    }
  }

  // ---------- 右键菜单(自注入样式见 ensureTmStyles;失焦即收起) ----------

  /** 菜单展开需扩窗:84×84 窗口装不下多组账号菜单(webview 内容裁剪),
   *  经 pv.window.resize 临时扩窗,收起恢复 84×84(实现决策,见开工卡偏差)。
   *  注意:菜单项经账号视图异步填充,必须等填充完成再测高,
   *  否则按空菜单(≈10px)扩窗会把大部分条目裁在窗口外(冒烟实测) */
  function openTmMenu(wrap) {
    var menu = wrap.querySelector('.pv-tm-menu');
    if (!menu) return;
    menu.hidden = false;
    buildTmMenu(menu).then(function () {
      var h = menu.getBoundingClientRect().height;
      return pv.window.resize(MENU_WIDTH + 8, BALL_SIZE + h + 6);
    }).catch(function () { /* 无窗口(纯浏览器预览)时忽略:菜单照常展示 */ });
  }

  function closeTmMenu(wrap) {
    // wrap 缺省回退 document:菜单项点击闭包(buildTmMenu 内)只握 menu 不握 wrap,
    // 1.1.0/1.1.1 的四处裸调用曾在此静默 early-return —— 菜单收不起、窗口保持
    // 扩窗,仅 blur 路径带 wrap 可收(1.1.2 实机验证抓出,backlog 有案)。
    // 球窗内 .pv-tm-menu 唯一,按根节点回退查找无歧义
    var menu = (wrap || document).querySelector('.pv-tm-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    void pv.window.resize(BALL_SIZE, BALL_SIZE).catch(function () {});
  }

  /** 菜单动作行:同形小图标 + 文本(图标 muted,悬停随行转 accent) */
  function buildMenuAction(text, icon, onClick) {
    var item = tmEl('div', 'pv-tm-menu-item');
    var label = tmEl('span', 'pv-tm-menu-label');
    var iconSpan = tmEl('span', 'pv-tm-menu-icon');
    iconSpan.innerHTML = icon;
    label.appendChild(iconSpan);
    label.appendChild(tmEl('span', null, text));
    item.appendChild(label);
    item.addEventListener('click', onClick);
    return item;
  }

  /** 菜单内容:直选账号(按供应商分组列账号,label + ✓ 当前,选中加粗)+
   *  立即刷新 / 打开详情面板 / 隐藏圆球(带图标);返回填充完成 Promise(供扩窗前测量) */
  function buildTmMenu(menu) {
    menu.innerHTML = '';
    return loadBallAccounts().then(function (accounts) {
      for (var i = 0; i < PROVIDER_ORDER.length; i++) {
        (function (providerKey) {
          var group = accounts.filter(function (a) { return a.provider === providerKey; });
          if (group.length === 0) return;
          var meta = PROVIDERS[providerKey];
          menu.appendChild(tmEl('div', 'pv-tm-menu-head', meta ? meta.label : providerKey));
          for (var j = 0; j < group.length; j++) {
            (function (account) {
              var selected = accountScope(account) === ballAccount;
              var item = tmEl('div', 'pv-tm-menu-item' + (selected ? ' pv-tm-selected' : ''));
              item.appendChild(tmEl('span', 'pv-tm-menu-label', account.label));
              if (selected) {
                item.appendChild(tmEl('span', 'pv-tm-check', '✓'));
              }
              item.addEventListener('click', function () {
                closeTmMenu();
                setAccount(accountScope(account), accounts);
              });
              menu.appendChild(item);
            })(group[j]);
          }
        })(PROVIDER_ORDER[i]);
      }
      if (accounts.length > 0) menu.appendChild(tmEl('div', 'pv-tm-menu-sep'));
      menu.appendChild(buildMenuAction(tm('refreshNow'), ICON_REFRESH, function () {
        closeTmMenu();
        refreshBallData();
      }));
      menu.appendChild(buildMenuAction(tm('openPanel'), ICON_WINDOW, function () {
        closeTmMenu();
        pv.window.openPanel();
      }));
      menu.appendChild(buildMenuAction(tm('hideBall'), ICON_HIDE, function () {
        closeTmMenu();
        stopPoll();
        pv.storage.set(KV_VISIBLE, false).then(function () {
          return pv.window.hide();
        }).catch(function () { /* 落盘失败仍尝试隐藏,下次启动按缺省显示 */ });
      }));
    });
  }

  /* ==================== 详情面板(pv.panel.register) ==================== */

  // 面板 cache 重读定时器(模块级单例,P1-a):面板原无任何数据定时器,打开期间
  // 冻结在打开时刻(球写 cache 无跨窗通知通道);30s 仅 readCache 重读不取数,
  // 断连自清。render 入口先清旧定时器(StrictMode 双调 render 防双定时器)
  var panelRefreshTimer = null;
  var PANEL_REFRESH_MS = 30000;

  pv.panel.register({
    id: 'token-monitor',
    title: TM_LANG === 'en' ? 'Usage Monitor' : '用量监控',
    render: function (el) {
      ensureTmStyles();
      // P1-a:入口先清旧定时器(StrictMode 双调 render 防双定时器)
      if (panelRefreshTimer !== null) {
        clearInterval(panelRefreshTimer);
        panelRefreshTimer = null;
      }
      el.innerHTML = '';
      var root = tmEl('div', 'pv-tm-panel');
      var colMain = tmEl('div', 'pv-tm-col');
      var colSide = tmEl('div', 'pv-tm-col pv-tm-side');

      // 设置区:添加账号 + 账号列表 + 轮询设置(卡片在其上)
      var settings = tmEl('div', 'pv-tm-settings');
      var panelErrors = {}; // 账号 scope → 最近一次取数错误(不覆盖该账号 cache)

      // ---- 添加表单:第一行[供应商 | 标签],第二行[Key(或 AK/SK)| 添加] ----
      var addTitle = tmEl('div', 'pv-tm-section-title', tm('addAccount'));
      settings.appendChild(addTitle);
      var addRow1 = tmEl('div', 'pv-tm-form-row');
      var addRow2 = tmEl('div', 'pv-tm-form-row');
      var providerSelect = document.createElement('select');
      providerSelect.className = 'input';
      for (var pi = 0; pi < PROVIDER_ORDER.length; pi++) {
        var opt = document.createElement('option');
        opt.value = PROVIDER_ORDER[pi];
        opt.textContent = PROVIDERS[PROVIDER_ORDER[pi]].label;
        providerSelect.appendChild(opt);
      }
      var labelInput = document.createElement('input');
      labelInput.className = 'input';
      labelInput.type = 'text';
      labelInput.placeholder = tm('labelPh');
      labelInput.autocomplete = 'off';
      var keyInput = document.createElement('input');
      keyInput.className = 'input';
      keyInput.type = 'password';
      keyInput.placeholder = tm('keyPlaceholder');
      keyInput.autocomplete = 'off';
      // 火山系为 AK/SK 双值(凭据管理器按 "AK\nSK" 两行编码,读取侧见 Rust load_credential):
      // 单值 Key 输入框与 AK/SK 两输入框按所选供应商切换,都隐藏在密码框形态
      var akInput = document.createElement('input');
      akInput.className = 'input';
      akInput.type = 'password';
      akInput.placeholder = tm('akPlaceholder');
      akInput.autocomplete = 'off';
      var skInput = document.createElement('input');
      skInput.className = 'input';
      skInput.type = 'password';
      skInput.placeholder = tm('skPlaceholder');
      skInput.autocomplete = 'off';
      var volcMode = false;
      var updateAddMode = function () {
        var meta = PROVIDERS[providerSelect.value];
        volcMode = !!(meta && meta.family === 'volcengine');
        keyInput.style.display = volcMode ? 'none' : '';
        akInput.style.display = volcMode ? '' : 'none';
        skInput.style.display = volcMode ? '' : 'none';
      };
      providerSelect.addEventListener('change', updateAddMode);
      updateAddMode();
      var addBtn = tmEl('button', 'btn small', tm('addBtn'));
      addRow1.appendChild(providerSelect);
      addRow1.appendChild(labelInput);
      addRow2.appendChild(keyInput);
      addRow2.appendChild(akInput);
      addRow2.appendChild(skInput);
      addRow2.appendChild(addBtn);
      settings.appendChild(addRow1);
      settings.appendChild(addRow2);
      var addStatus = tmEl('div', 'pv-tm-add-status');
      settings.appendChild(addStatus);

      /** 添加行状态提示(校验错误 danger;成功 muted) */
      var showAddStatus = function (text, isErr) {
        addStatus.textContent = text || '';
        addStatus.className = 'pv-tm-add-status' + (isErr ? ' err' : '');
      };

      addBtn.addEventListener('click', function () {
        var provider = providerSelect.value;
        var label = labelInput.value.trim();
        var secret;
        if (volcMode) {
          // 火山系:AK/SK 分别录入,拼接为 "AK\nSK" 两行编码写入凭据管理器
          var ak = akInput.value.trim();
          var sk = skInput.value.trim();
          if (ak === '' || sk === '') { showAddStatus(tm('akSkRequired'), true); return; }
          secret = ak + '\n' + sk;
        } else {
          secret = keyInput.value;
          if (secret === '') { showAddStatus(tm('keyRequired'), true); return; }
        }
        if (!PROVIDERS[provider]) { showAddStatus(tm('providerPh'), true); return; }
        if (!isValidLabel(label)) { showAddStatus(tm('labelInvalid'), true); return; }
        ensureAccountsMigrated().then(function (accounts) {
          var scope = provider + ':' + label;
          for (var i = 0; i < accounts.length; i++) {
            if (accountScope(accounts[i]) === scope) {
              showAddStatus(tm('labelDuplicate'), true);
              return null;
            }
          }
          // 先写凭据再入册:录入即刷该账号(失败错误落卡片,不清缓存)
          return pv.credentials.set(scope, secret).then(function () {
            var next = accounts.concat([{ provider: provider, label: label }]);
            return writeAccounts(next).then(function () {
              labelInput.value = '';
              keyInput.value = '';
              akInput.value = '';
              skInput.value = '';
              showAddStatus(tm('addOk'), false);
              return fetchAndCache({ provider: provider, label: label })
                .catch(function (err) {
                  panelErrors[scope] = (err && err.message) || String(err);
                })
                .then(function () {
                  rerender();
                });
            });
          }).catch(function (err) {
            showAddStatus(tm('credFail') + ((err && err.message) || String(err)), true);
          });
        }).catch(function (err) {
          showAddStatus(tm('credFail') + ((err && err.message) || String(err)), true);
        });
      });

      // ---- 账号列表:[缩写徽标 | label + 供应商 | 配置状态点 | 删除] ----
      var listTitle = tmEl('div', 'pv-tm-section-title', tm('accountList'));
      settings.appendChild(listTitle);
      var acctList = tmEl('div', 'pv-tm-acct-list');
      settings.appendChild(acctList);

      // ---- 告警阈值分组:每账号一行(chip + switch + 滑杆 + 数值;存 tm.alert.<scope>) ----
      settings.appendChild(tmEl('div', 'pv-tm-section-title', tm('alertGroup')));
      var alertList = tmEl('div', 'pv-tm-alert-list');
      settings.appendChild(alertList);

      // ---- 轮询行:switch + 间隔(钳制 ≥120s;默认关;存 ball.poll) ----
      var pollRow = tmEl('div', 'pv-tm-poll-row');
      pollRow.appendChild(tmEl('span', 'pv-tm-poll-label', tm('pollLabel')));
      var switchWrap = tmEl('label', 'pv-tm-switch');
      var pollCheck = document.createElement('input');
      pollCheck.type = 'checkbox';
      switchWrap.appendChild(pollCheck);
      switchWrap.appendChild(document.createElement('span'));
      pollRow.appendChild(switchWrap);
      var pollInput = document.createElement('input');
      pollInput.className = 'input';
      pollInput.type = 'number';
      pollInput.min = String(POLL_MIN_SEC);
      pollInput.step = '30';
      pollInput.title = tm('pollInterval');
      pollRow.appendChild(pollInput);
      settings.appendChild(pollRow);

      var persistPoll = function () {
        var cfg = {
          enabled: pollCheck.checked === true,
          intervalSec: clampPollSec(pollInput.value)
        };
        void pv.storage.set(KV_POLL, cfg).catch(function () {});
      };
      pollCheck.addEventListener('change', persistPoll);
      var persistInterval = function (e) {
        if (e && e.isComposing) return; // IME 守卫(沿用现有模式)
        persistPoll();
      };
      // change + blur 双监听:个别环境 blur 时不派发 change(预览 IAB 实测),
      // blur 兜底保证失焦即持久化
      pollInput.addEventListener('change', persistInterval);
      pollInput.addEventListener('blur', persistInterval);
      pv.storage.get(KV_POLL).then(function (cfg) {
        pollCheck.checked = !!(cfg && cfg.enabled === true);
        pollInput.value = cfg && cfg.intervalSec ? String(clampPollSec(cfg.intervalSec)) : String(POLL_DEFAULT_SEC);
      }).catch(function () {});

      // ---- 卡片区:每账号一张卡 + 「全部刷新」(左列;设置区入右侧栏) ----
      var cardsHead = tmEl('div', 'pv-tm-cards-head');
      var refreshAllBtn = tmEl('button', 'btn small', tm('refreshAll'));
      refreshAllBtn.addEventListener('click', function () {
        refreshAllBtn.disabled = true;
        ensureAccountsMigrated().then(function (accounts) {
          return Promise.all(accounts.map(function (account) {
            var scope = accountScope(account);
            return fetchAndCache(account)
              .then(function () { panelErrors[scope] = null; })
              .catch(function (err) {
                panelErrors[scope] = (err && err.message) || String(err);
              });
          }));
        }).then(function () {
          rerender();
        }).catch(function () {
          rerender();
        });
      });
      cardsHead.appendChild(refreshAllBtn);

      var cards = tmEl('div', 'pv-tm-cards');
      colMain.appendChild(cardsHead);
      colMain.appendChild(cards);
      colSide.appendChild(settings);
      root.appendChild(colMain);
      root.appendChild(colSide);
      el.appendChild(root);

      /** 整区重渲染(账号列表 + 告警阈值行 + 卡片;addStatus 保持) */
      function rerender() {
        renderAccountList();
        renderAlertRows();
        renderPanelCards();
      }

      /** 账号列表:逐行 [供应商+端点徽标 | label | 已配置徽标 | 删除];
       *  删除 = credentials.delete + 清该账号 cache + 清单移除(球经 kv 同步跟随) */
      function renderAccountList() {
        ensureAccountsMigrated().then(function (accounts) {
          acctList.innerHTML = '';
          if (accounts.length === 0) {
            acctList.appendChild(tmEl('div', 'pv-tm-empty', tm('panelEmpty')));
            return;
          }
          var probes = accounts.map(function (account) {
            return Promise.resolve(pv.credentials.configured(accountScope(account)))
              .then(function (ok) { return ok === true; })
              .catch(function () { return false; });
          });
          Promise.all(probes).then(function (states) {
            acctList.innerHTML = '';
            for (var i = 0; i < accounts.length; i++) {
              acctList.appendChild(buildAccountRow(accounts[i], states[i]));
            }
          });
        }).catch(function (err) {
          acctList.innerHTML = '';
          acctList.appendChild(tmEl('div', 'pv-tm-card-error', (err && err.message) || String(err)));
        });
      }

      function buildAccountRow(account, configuredOk) {
        var meta = PROVIDERS[account.provider];
        var row = tmEl('div', 'pv-tm-acct-row');
        var scope = accountScope(account);
        var chip = tmEl('span', 'pv-tm-acct-chip', meta ? meta.abbr : '?');
        chip.title = meta ? meta.endpoint : account.provider;
        row.appendChild(chip);
        var main = tmEl('div', 'pv-tm-acct-main');
        main.appendChild(tmEl('div', 'pv-tm-acct-name', account.label));
        main.appendChild(tmEl('div', 'pv-tm-acct-sub', meta ? meta.label : account.provider));
        row.appendChild(main);
        row.appendChild(tmEl('span', 'pv-tm-status' + (configuredOk ? ' ok' : ''),
          configuredOk ? tm('configured') : tm('notConfigured')));
        var delBtn = tmEl('button', 'pv-tm-acct-del');
        delBtn.type = 'button';
        delBtn.title = tm('removeAccount');
        delBtn.setAttribute('aria-label', tm('removeAccount'));
        delBtn.innerHTML = ICON_TRASH;
        delBtn.addEventListener('click', function () {
          delBtn.disabled = true;
          pv.credentials.delete(scope).then(function () {
            // 清该账号 cache(置 null:kv 无删除命令,读侧 null 即无数据)
            return pv.storage.set(KV_CACHE_PREFIX + scope, null);
          }).then(function () {
            // 告警阈值与通知状态孤儿键同模式清理:读侧 null 即默认(阈值行)/
            // 未通知(状态),球侧下次读取不残留已删账号的旧配置/旧窗口身份
            return Promise.all([
              pv.storage.set(KV_ALERT_PREFIX + scope, null),
              pv.storage.set(KV_ALERT_STATE_PREFIX + scope, null),
            ]);
          }).then(function () {
            return ensureAccountsMigrated().then(function (accounts2) {
              var next = accounts2.filter(function (a) {
                return accountScope(a) !== scope;
              });
              return writeAccounts(next);
            });
          }).then(function () {
            rerender();
          }).catch(function (err) {
            delBtn.disabled = false;
            showAddStatus(tm('credFail') + ((err && err.message) || String(err)), true);
          });
        });
        row.appendChild(delBtn);
        return row;
      }

      /** 告警阈值行:每账号一行;配置读写仅面板实例(单写者),球实例只读。
       *  行重建只在账号列表变更时(rerender)—— 交互中不重建,以免打断滑杆拖动;
       *  新增账号追加一行、删除账号行随清单消失(孤儿键随删除链清理) */
      function renderAlertRows() {
        ensureAccountsMigrated().then(function (accounts) {
          alertList.innerHTML = '';
          if (accounts.length === 0) return;
          Promise.all(accounts.map(readAlertCfg)).then(function (cfgs) {
            alertList.innerHTML = '';
            for (var i = 0; i < accounts.length; i++) {
              alertList.appendChild(buildAlertRow(accounts[i], cfgs[i]));
            }
          });
        }).catch(function () { /* kv 不可用:行保持空,不影响其他区域 */ });
      }

      /** 单行:[缩写 chip | switch | 滑杆(5–100 步进 1)| 数值%]。
       *  持久化时机:switch 用 change;滑杆 input 仅更新数值/填充,change(松手)持久化
       *  + blur 兜底(轮询间隔行先例 16311ab;change+blur 双触发幂等无害)。
       *  写完即 renderPanelCards —— 卡片告警 chip 随新配置即时翻转(行本身不重建) */
      function buildAlertRow(account, cfg) {
        var meta = PROVIDERS[account.provider];
        var name = (meta ? meta.label : account.provider) + ' · ' + account.label;
        var row = tmEl('div', 'pv-tm-alert-row');
        var chip = tmEl('span', 'pv-tm-alert-chip');
        chip.innerHTML = (meta ? meta.abbr : '?') + (meta && meta.intl ? '<sup>i</sup>' : '');
        chip.title = meta ? meta.endpoint : account.provider;
        row.appendChild(chip);
        var switchWrap = tmEl('label', 'pv-tm-switch');
        var check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = cfg.enabled === true;
        check.setAttribute('aria-label', tm('alertSwitch').replace('{label}', name));
        switchWrap.appendChild(check);
        switchWrap.appendChild(document.createElement('span'));
        row.appendChild(switchWrap);
        var slider = document.createElement('input');
        slider.className = 'pv-tm-slider';
        slider.type = 'range';
        slider.min = String(ALERT_MIN);
        slider.max = String(ALERT_MAX);
        slider.step = '1';
        slider.value = String(cfg.threshold);
        slider.setAttribute('aria-label', tm('alertSlider').replace('{label}', name));
        row.appendChild(slider);
        var val = tmEl('span', 'pv-tm-alert-val', cfg.threshold + '%');
        row.appendChild(val);

        var persist = function (enabled) {
          void pv.storage.set(KV_ALERT_PREFIX + accountScope(account), {
            enabled: enabled === true,
            threshold: clampThreshold(slider.value)
          }).then(function () {
            renderPanelCards(); // 卡片告警 chip 随新配置即时翻转
          }).catch(function () { /* 写失败静默:下次重渲染按 kv 实际值回显 */ });
        };
        var applyRowState = function () {
          var on = check.checked === true;
          row.classList.toggle('pv-tm-alert-off', !on);
          slider.disabled = !on;
        };
        check.addEventListener('change', function () {
          applyRowState();
          persist(check.checked);
        });
        slider.addEventListener('input', function () {
          val.textContent = slider.value + '%';
          paintSliderFill();
        });
        var persistSlider = function () {
          persist(check.checked);
        };
        slider.addEventListener('change', persistSlider);
        slider.addEventListener('blur', persistSlider);
        applyRowState();
        paintSliderFill();
        return row;

        /** 阈值钳制回滑杆区间(数值来自字符串 input,统一走 Number 纠偏) */
        function clampThreshold(raw) {
          var n = Number(raw);
          if (!isFinite(n)) n = ALERT_DEFAULT_THRESHOLD;
          return Math.min(ALERT_MAX, Math.max(ALERT_MIN, Math.round(n)));
        }

        /** 滑杆 accent 填充:inline gradient 直接引用 CSS var —— 主题切换自动跟随,
         *  无需监听(取舍:与「getComputedStyle 快照 + 重渲染重算」等价且少一条取舍) */
        function paintSliderFill() {
          var pos = (Number(slider.value) - ALERT_MIN) / (ALERT_MAX - ALERT_MIN) * 100;
          slider.style.background = 'linear-gradient(to right, var(--accent) 0%, var(--accent) ' +
            pos + '%, var(--border-strong) ' + pos + '%, var(--border-strong) 100%)';
        }
      }

      /** 渲染卡片区:每账号一张卡(含未配置账号,徽标在列表区);数据渲染该账号 cache,
       *  并读该账号告警配置供卡头派生告警胶囊 */
      function renderPanelCards() {
        ensureAccountsMigrated().then(function (accounts) {
          cards.innerHTML = '';
          if (accounts.length === 0) {
            cards.appendChild(tmEl('div', 'pv-tm-empty', tm('panelEmpty')));
            refreshAllBtn.disabled = true;
            return;
          }
          refreshAllBtn.disabled = false;
          var reads = accounts.map(function (account) {
            return Promise.all([readCache(account), readAlertCfg(account)]).then(function (rs) {
              return { data: rs[0], alert: rs[1] };
            });
          });
          Promise.all(reads).then(function (results) {
            cards.innerHTML = '';
            for (var i = 0; i < accounts.length; i++) {
              var scope = accountScope(accounts[i]);
              cards.appendChild(buildCard(accounts[i], results[i].data,
                panelErrors[scope] || null, results[i].alert));
            }
          });
        }).catch(function (err) {
          cards.innerHTML = '';
          cards.appendChild(tmEl('div', 'pv-tm-card-error', (err && err.message) || String(err)));
        });
      }

      /** 单张卡:卡头=缩写徽标+供应商名·label+端点(该账号派生告警态时追加告警胶囊);
       *  5h/周计量条(≥80% danger,条下倒计时);GLM 系另附 24h 聚合 / MCP 月度双瓦片 */
      function buildCard(account, data, errorText, alertCfg) {
        var meta = PROVIDERS[account.provider];
        var card = tmEl('div', 'pv-tm-card');
        var head = tmEl('div', 'pv-tm-card-head');
        var chip = tmEl('span', 'pv-tm-abbr-chip');
        chip.innerHTML = (meta ? meta.abbr : '?') + (meta && meta.intl ? '<sup>i</sup>' : '');
        chip.title = meta ? meta.endpoint : account.provider;
        head.appendChild(chip);
        var titlewrap = tmEl('div', 'pv-tm-card-titlewrap');
        titlewrap.appendChild(tmEl('div', 'pv-tm-card-title',
          (meta ? meta.label : account.provider) + ' · ' + account.label));
        titlewrap.appendChild(tmEl('div', 'pv-tm-card-sub', meta ? meta.endpoint : ''));
        // P4 新鲜度展示:cache.fetchedAt 相对时间(同步可信度的可见锚点 ——
        // P1-a 面板重读后用户可分辨卡片数值是刚刚同步还是久前旧值);
        // 无 cache / 无 fetchedAt 显示「—」;样式复用 card-sub(muted 小字)
        var freshText = '—';
        var fetchedAt = data && typeof data.fetchedAt === 'number' ? data.fetchedAt : null;
        if (fetchedAt !== null) {
          var rel = formatRelativeTime(fetchedAt);
          if (rel !== null) freshText = rel;
        }
        titlewrap.appendChild(tmEl('div', 'pv-tm-card-sub',
          tm('lastRefresh') + ' ' + freshText));
        head.appendChild(titlewrap);
        // 告警胶囊:纯 UI 派生(开关开 && 无取数错误 && 5h% ≥ 阈值),不发通知
        var fivePct = data && data.fiveHour ? data.fiveHour.percent : null;
        if (isAlerting(alertCfg, fivePct, !!errorText)) {
          var alertChip = tmEl('span', 'pv-tm-card-alert');
          alertChip.innerHTML = ICON_BELL + '<span>' + tm('alertChip') + '</span>';
          head.appendChild(alertChip);
        }
        var refreshBtn = tmEl('button', 'btn small', tm('refreshNow'));
        refreshBtn.addEventListener('click', function () {
          refreshBtn.disabled = true;
          fetchAndCache(account).then(function () {
            panelErrors[accountScope(account)] = null;
            renderPanelCards();
          }).catch(function (err) {
            panelErrors[accountScope(account)] = (err && err.message) || String(err);
            renderPanelCards();
          });
        });
        head.appendChild(refreshBtn);
        card.appendChild(head);

        var five = (data && data.fiveHour) || {};
        var week = (data && data.weekly) || {};
        card.appendChild(meterBlock(tm('fiveHour'), five));
        card.appendChild(meterBlock(tm('weekly'), week));
        if (meta && meta.family === 'glm') {
          var tiles = tmEl('div', 'pv-tm-tiles');
          var tokens = data && typeof data.tokens24h === 'number' ? data.tokens24h : null;
          tiles.appendChild(statTile(tm('tokens24h'),
            tokens === null ? tm('noData') : formatTokens(tokens)));
          var mcp = data && data.mcpMonthly;
          var mcpText = mcp
            ? (formatTokens(mcp.usage) || tm('noData')) + ' / ' + (formatTokens(mcp.currentValue) || tm('noData'))
            : tm('noData');
          tiles.appendChild(statTile(tm('mcpMonthly'), mcpText));
          card.appendChild(tiles);
        }
        if (errorText) card.appendChild(tmEl('div', 'pv-tm-card-error', errorText));
        return card;
      }

      /** 计量条:名称+百分比(≥80% danger)+ track/fill + 距重置倒计时 */
      function meterBlock(name, win) {
        var pct = win && win.percent !== null && win.percent !== undefined ? win.percent : null;
        var danger = pct !== null && pct >= 80;
        var wrap = tmEl('div', 'pv-tm-meter');
        var top = tmEl('div', 'pv-tm-meter-top');
        top.appendChild(tmEl('span', 'pv-tm-meter-name', name));
        top.appendChild(tmEl('span', 'pv-tm-meter-val' + (danger ? ' danger' : ''),
          pct === null ? tm('noData') : pct + '%'));
        wrap.appendChild(top);
        var track = tmEl('div', 'pv-tm-meter-track');
        var fill = tmEl('div', 'pv-tm-meter-fill' + (danger ? ' danger' : ''));
        fill.style.width = (pct === null ? 0 : Math.min(100, Math.max(0, pct))) + '%';
        track.appendChild(fill);
        wrap.appendChild(track);
        if (win && win.resetAt) {
          var cd = formatCountdown(win.resetAt);
          if (cd) wrap.appendChild(tmEl('div', 'pv-tm-meter-sub', tm('resetsIn') + ' ' + cd));
        }
        return wrap;
      }

      /** 静态数值瓦片(24h 聚合 / MCP 月度) */
      function statTile(label, value) {
        var tile = tmEl('div', 'pv-tm-tile');
        tile.appendChild(tmEl('span', 'pv-tm-tile-label', label));
        tile.appendChild(tmEl('span', 'pv-tm-tile-value', value));
        return tile;
      }

      rerender();

      // P1-a:面板挂载期间 30s 重读 cache(仅 readCache,不发起取数 —— cache 是球
      // 在写的,面板轮询重读即「准同步」);el 断连即 clearInterval 自清
      panelRefreshTimer = window.setInterval(function () {
        if (el.isConnected) {
          renderPanelCards();
        } else {
          clearInterval(panelRefreshTimer);
          panelRefreshTimer = null;
        }
      }, PANEL_REFRESH_MS);
    }
  });
