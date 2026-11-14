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
 *     label "default" 读取回落旧 cache:<provider>(旧单账号缓存兼容)。
 */

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
  var BALL_SIZE = 84;             // 球窗边长(与设计 §5.1 一致)
  var MENU_WIDTH = 172;           // 右键菜单宽度
  var POLL_MIN_SEC = 120;         // 轮询间隔下限(参照社区 statusline 120s 缓存实践)
  var POLL_DEFAULT_SEC = 300;     // 开启轮询且未指定间隔时的默认值

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
      noData: '暂无数据',
      panelEmpty: '尚未配置账号:请在下方添加账号并录入 Key',
      addAccount: '添加账号',
      providerPh: '选择供应商',
      labelPh: '账号标签(如 主号/备用)',
      keyPlaceholder: '粘贴 API Key',
      addBtn: '添加',
      accountList: '账号列表',
      configured: '已配置',
      notConfigured: '未配置',
      removeAccount: '删除',
      labelInvalid: '标签需为 1-16 位字母/数字/下划线/连字符/中文(禁冒号斜杠空白)',
      labelDuplicate: '同一供应商下已有同名账号',
      keyRequired: 'Key 不能为空',
      addOk: '账号已添加',
      pollLabel: '自动轮询(球窗常驻刷新)',
      pollInterval: '间隔(秒,≥120)',
      credFail: '凭据操作失败:',
      errPrefix: '取数失败:'
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
      noData: 'No data yet',
      panelEmpty: 'No account configured: add one below and paste its key',
      addAccount: 'Add account',
      providerPh: 'Select provider',
      labelPh: 'Account label (e.g. main/spare)',
      keyPlaceholder: 'Paste API key',
      addBtn: 'Add',
      accountList: 'Accounts',
      configured: 'Configured',
      notConfigured: 'Not configured',
      removeAccount: 'Remove',
      labelInvalid: 'Label must be 1-16 chars of letters/digits/underscore/hyphen/CJK',
      labelDuplicate: 'An account with the same label already exists for this provider',
      keyRequired: 'Key is required',
      addOk: 'Account added',
      pollLabel: 'Auto poll (ball refresh)',
      pollInterval: 'Interval (sec, ≥120)',
      credFail: 'Credential operation failed: ',
      errPrefix: 'Fetch failed: '
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

  /** 轮询间隔钳制:≥120s(§5.1 参照社区实践) */
  function clampPollSec(sec) {
    var n = typeof sec === 'string' ? Number(sec) : sec;
    if (typeof n !== 'number' || !isFinite(n)) return POLL_DEFAULT_SEC;
    return Math.max(POLL_MIN_SEC, Math.round(n));
  }

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
        'background:transparent;border:none;padding:0;cursor:pointer;display:block;}',
      '.pv-tm-ball svg{display:block;}',
      '.pv-tm-abbr{font-size:15px;font-weight:600;fill:var(--text);}',
      '.pv-tm-intl{font-size:9px;fill:var(--muted);}',
      '.pv-tm-pct{font-size:11px;fill:var(--text);}',
      '.pv-tm-pct.err{fill:var(--danger);font-weight:700;}',
      '.pv-tm-pct.empty{fill:var(--muted);}',
      '.pv-tm-ring{transition:stroke-dashoffset .4s ease,stroke .4s ease;}',
      '.pv-tm-menu{position:absolute;left:4px;top:84px;width:172px;z-index:10;',
        'background:var(--panel);border:1px solid var(--border);border-radius:8px;',
        'padding:4px;box-shadow:var(--shadow-lg);}',
      '.pv-tm-menu-item{display:flex;justify-content:space-between;align-items:center;gap:12px;',
        'padding:5px 10px;border-radius:5px;font-size:12px;color:var(--text);cursor:pointer;',
        'white-space:nowrap;transition:background .12s ease;}',
      // 悬停高亮走项目「指向项」惯用色 --accent-soft(.row.active/.option:hover 同源):
      // --panel-hover 与菜单底色同族过淡,球窗小字号下不可辨;移出即随 :hover 还原
      '.pv-tm-menu-item:hover{background:var(--accent-soft);}',
      '.pv-tm-menu-item .pv-tm-check{color:var(--accent);font-weight:700;}',
      '.pv-tm-menu-head{padding:5px 10px 2px;font-size:11px;font-weight:600;color:var(--muted);}',
      '.pv-tm-menu-sep{height:1px;background:var(--border);margin:4px 6px;}',
      '.pv-tm-panel{display:flex;flex-direction:column;gap:12px;max-width:560px;}',
      '.pv-tm-cards{display:flex;flex-direction:column;gap:8px;}',
      '.pv-tm-cards-head{display:flex;justify-content:flex-end;}',
      '.pv-tm-card{border:1px solid var(--border);border-radius:8px;padding:10px 12px;',
        'display:flex;flex-direction:column;gap:6px;background:var(--panel);}',
      '.pv-tm-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
      '.pv-tm-card-titlewrap{display:flex;flex-direction:column;gap:2px;min-width:0;}',
      '.pv-tm-card-title{font-size:13px;font-weight:600;color:var(--text);}',
      '.pv-tm-card-sub{font-size:11px;color:var(--muted);white-space:nowrap;',
        'overflow:hidden;text-overflow:ellipsis;}',
      '.pv-tm-row{display:flex;justify-content:space-between;gap:12px;font-size:12px;color:var(--muted);}',
      '.pv-tm-row .pv-tm-val{color:var(--text);}',
      '.pv-tm-val.danger{color:var(--danger);font-weight:600;}',
      '.pv-tm-card-error{color:var(--danger);font-size:12px;}',
      '.pv-tm-muted{color:var(--muted);font-size:12px;}',
      '.pv-tm-badge{display:inline-block;padding:1px 8px;border:1px solid var(--border);',
        'border-radius:999px;font-size:11px;color:var(--muted);white-space:nowrap;}',
      '.pv-tm-badge.ok{color:var(--accent);border-color:var(--accent);}',
      '.pv-tm-settings{border-top:1px solid var(--border);padding-top:10px;',
        'display:flex;flex-direction:column;gap:8px;}',
      '.pv-tm-set-row{display:flex;align-items:center;gap:8px;font-size:12px;}',
      '.pv-tm-set-label{min-width:72px;color:var(--muted);white-space:nowrap;}',
      '.pv-tm-acct-row{display:flex;align-items:center;gap:8px;font-size:12px;}',
      '.pv-tm-acct-row .pv-tm-acct-label{color:var(--text);min-width:0;',
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.pv-tm-acct-row .pv-tm-badge{margin-left:auto;}',
      '.pv-tm-add-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
      '.pv-tm-add-row .input{flex:1 1 120px;min-width:96px;}',
      '.pv-tm-add-row .input.pv-tm-key-input{flex:2 1 150px;}',
      '.pv-tm-add-status{color:var(--muted);font-size:12px;min-height:1em;}',
      '.pv-tm-add-status.err{color:var(--danger);}'
    ].join('');
    document.head.appendChild(style);
  }

  // ---------- 球体(pv.window.setup;仅球窗实例的 onMount 会执行) ----------

  var ballAccount = null;    // 当前账号 scope('provider:label')
  var ballData = null;       // 当前账号最近一次成功数据(cache 或本次拉取)
  var ballError = null;      // 最近一次取数错误摘要
  var ballNoConfigured = false; // 无已配置账号的灰态
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
   *  tooltip 错误摘要 */
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
      '<circle cx="38" cy="38" r="32" fill="none" stroke="var(--border)" stroke-width="6"/>' +
      '<circle class="pv-tm-ring" cx="38" cy="38" r="32" fill="none" stroke="' + stroke + '" stroke-width="6" ' +
      'stroke-linecap="round" stroke-dasharray="' + ring + '" stroke-dashoffset="' + offset + '" transform="rotate(-90 38 38)"/>' +
      '<text class="pv-tm-abbr" x="38" y="36" text-anchor="middle">' + abbr + intl + '</text>' +
      '<text class="' + pctClass + '" x="38" y="51" text-anchor="middle">' + center2 + '</text>' +
      '</svg>';
    ball.title = buildBallTooltip();
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

  /** 切换账号:复位状态 → 持久化('provider:label')→ 渲染缓存 → 拉新数据 */
  function setAccount(scope, accounts) {
    var account = accountOf(scope, accounts || [parseScope(scope)].filter(Boolean));
    ballNoConfigured = false;
    ballAccount = accountScope(account);
    ballData = null;
    ballError = null;
    renderBall();
    pv.storage.set(KV_PROVIDER, ballAccount).catch(function () {});
    var proceed = readCache(account).then(function (cached) {
      if (cached) {
        ballData = cached;
        renderBall();
      }
      return refreshBallData();
    });
    void proceed;
  }

  /** 拉当前账号数据并渲染;失败:环保留缓存值 + 中心「!」+ tooltip 错误 */
  function refreshBallData() {
    if (!ballAccount) return Promise.resolve();
    var account = parseScope(ballAccount);
    if (!account) return Promise.resolve();
    return fetchAndCache(account).then(function (data) {
      ballData = data;
      ballError = null;
      renderBall();
    }).catch(function (err) {
      ballError = (err && err.message) || String(err);
      renderBall();
    });
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

  /** tick:重读账号视图同步清单(删除/失效账号自动让位),再刷新当前账号;
   *  单序列不重叠(interval ≥120s,单次取数整体超时 15s) */
  function tickBall() {
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
        setAccount(ids[0], accounts); // 当前账号已被删除/失效:切到清单首个
        return;
      }
      refreshBallData();
    }).catch(function (err) {
      ballError = (err && err.message) || String(err);
      renderBall();
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
    var menu = wrap && wrap.querySelector('.pv-tm-menu');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    void pv.window.resize(BALL_SIZE, BALL_SIZE).catch(function () {});
  }

  /** 菜单内容:直选账号(按供应商分组列账号,显示 label,✓ 当前)+ 立即刷新 +
   *  打开详情面板 + 隐藏;返回填充完成 Promise(供扩窗前测量) */
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
              var item = tmEl('div', 'pv-tm-menu-item');
              item.appendChild(tmEl('span', null, account.label));
              if (accountScope(account) === ballAccount) {
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
      var refresh = tmEl('div', 'pv-tm-menu-item', tm('refreshNow'));
      refresh.addEventListener('click', function () {
        closeTmMenu();
        refreshBallData();
      });
      var panel = tmEl('div', 'pv-tm-menu-item', tm('openPanel'));
      panel.addEventListener('click', function () {
        closeTmMenu();
        pv.window.openPanel();
      });
      var hide = tmEl('div', 'pv-tm-menu-item', tm('hideBall'));
      hide.addEventListener('click', function () {
        closeTmMenu();
        stopPoll();
        pv.storage.set(KV_VISIBLE, false).then(function () {
          return pv.window.hide();
        }).catch(function () { /* 落盘失败仍尝试隐藏,下次启动按缺省显示 */ });
      });
      menu.appendChild(refresh);
      menu.appendChild(panel);
      menu.appendChild(hide);
    });
  }

  /* ==================== 详情面板(pv.panel.register) ==================== */

  pv.panel.register({
    id: 'token-monitor',
    title: TM_LANG === 'en' ? 'Usage Monitor' : '用量监控',
    render: function (el) {
      ensureTmStyles();
      el.innerHTML = '';
      var root = tmEl('div', 'pv-tm-panel');

      // 设置区:添加账号 + 账号列表 + 轮询设置(卡片在其上)
      var settings = tmEl('div', 'pv-tm-settings');
      var panelErrors = {}; // 账号 scope → 最近一次取数错误(不覆盖该账号 cache)

      // ---- 添加行:供应商下拉(含国内/国际变体)+ 标签 + Key + 添加 ----
      var addTitle = tmEl('div', 'pv-tm-set-label', tm('addAccount'));
      settings.appendChild(addTitle);
      var addRow = tmEl('div', 'pv-tm-add-row');
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
      keyInput.className = 'input pv-tm-key-input';
      keyInput.type = 'password';
      keyInput.placeholder = tm('keyPlaceholder');
      keyInput.autocomplete = 'off';
      var addBtn = tmEl('button', 'btn small', tm('addBtn'));
      addRow.appendChild(providerSelect);
      addRow.appendChild(labelInput);
      addRow.appendChild(keyInput);
      addRow.appendChild(addBtn);
      settings.appendChild(addRow);
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
        var secret = keyInput.value;
        if (!PROVIDERS[provider]) { showAddStatus(tm('providerPh'), true); return; }
        if (!isValidLabel(label)) { showAddStatus(tm('labelInvalid'), true); return; }
        if (secret === '') { showAddStatus(tm('keyRequired'), true); return; }
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

      // ---- 账号列表行:[供应商+端点徽标 | label | 已配置徽标 | 删除] ----
      var listTitle = tmEl('div', 'pv-tm-set-label', tm('accountList'));
      settings.appendChild(listTitle);
      var acctList = tmEl('div', 'pv-tm-acct-list');
      settings.appendChild(acctList);

      // ---- 轮询设置行:开关 + 间隔(钳制 ≥120s;默认关;存 ball.poll) ----
      var pollRow = tmEl('div', 'pv-tm-set-row');
      pollRow.appendChild(tmEl('span', 'pv-tm-set-label', tm('pollLabel')));
      var pollCheck = document.createElement('input');
      pollCheck.type = 'checkbox';
      var pollInput = document.createElement('input');
      pollInput.className = 'input';
      pollInput.type = 'number';
      pollInput.min = String(POLL_MIN_SEC);
      pollInput.step = '30';
      pollInput.title = tm('pollInterval');
      pollRow.appendChild(pollCheck);
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

      root.appendChild(settings);

      // ---- 卡片区:每账号一张卡 + 「全部刷新」(卡片在上、设置区在下,沿用原层级) ----
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
      el.appendChild(cardsHead);
      el.appendChild(cards);
      el.appendChild(root);

      /** 整区重渲染(账号列表 + 卡片;addStatus 保持) */
      function rerender() {
        renderAccountList();
        renderPanelCards();
      }

      /** 账号列表:逐行 [供应商+端点徽标 | label | 已配置徽标 | 删除];
       *  删除 = credentials.delete + 清该账号 cache + 清单移除(球经 kv 同步跟随) */
      function renderAccountList() {
        ensureAccountsMigrated().then(function (accounts) {
          acctList.innerHTML = '';
          if (accounts.length === 0) {
            acctList.appendChild(tmEl('div', 'pv-tm-muted', tm('panelEmpty')));
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
        var badge = tmEl('span', 'pv-tm-badge', meta ? meta.label : account.provider);
        badge.title = meta ? meta.endpoint : account.provider;
        row.appendChild(badge);
        row.appendChild(tmEl('span', 'pv-tm-acct-label', account.label));
        row.appendChild(tmEl('span', 'pv-tm-badge' + (configuredOk ? ' ok' : ''),
          configuredOk ? tm('configured') : tm('notConfigured')));
        var delBtn = tmEl('button', 'btn small', tm('removeAccount'));
        delBtn.addEventListener('click', function () {
          delBtn.disabled = true;
          pv.credentials.delete(scope).then(function () {
            // 清该账号 cache(置 null:kv 无删除命令,读侧 null 即无数据)
            return pv.storage.set(KV_CACHE_PREFIX + scope, null);
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

      /** 渲染卡片区:每账号一张卡(含未配置账号,徽标在列表区);数据渲染该账号 cache */
      function renderPanelCards() {
        ensureAccountsMigrated().then(function (accounts) {
          cards.innerHTML = '';
          if (accounts.length === 0) {
            cards.appendChild(tmEl('div', 'pv-tm-muted', tm('panelEmpty')));
            refreshAllBtn.disabled = true;
            return;
          }
          refreshAllBtn.disabled = false;
          var reads = accounts.map(function (account) { return readCache(account); });
          Promise.all(reads).then(function (results) {
            cards.innerHTML = '';
            for (var i = 0; i < accounts.length; i++) {
              var scope = accountScope(accounts[i]);
              cards.appendChild(buildCard(accounts[i], results[i], panelErrors[scope] || null));
            }
          });
        }).catch(function (err) {
          cards.innerHTML = '';
          cards.appendChild(tmEl('div', 'pv-tm-card-error', (err && err.message) || String(err)));
        });
      }

      /** 单张卡:标题=供应商名+label,副标题=端点;5h(百分比+倒计时)/ 周 /
       *  24h 聚合(GLM 系)/ MCP 月度(GLM 系) */
      function buildCard(account, data, errorText) {
        var meta = PROVIDERS[account.provider];
        var card = tmEl('div', 'pv-tm-card');
        var head = tmEl('div', 'pv-tm-card-head');
        var titlewrap = tmEl('div', 'pv-tm-card-titlewrap');
        titlewrap.appendChild(tmEl('div', 'pv-tm-card-title',
          (meta ? meta.label : account.provider) + ' · ' + account.label));
        titlewrap.appendChild(tmEl('div', 'pv-tm-card-sub', meta ? meta.endpoint : ''));
        head.appendChild(titlewrap);
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
        card.appendChild(statRow(tm('fiveHour'), five));
        card.appendChild(statRow(tm('weekly'), week));
        if (meta && meta.family === 'glm') {
          var tokens = data && typeof data.tokens24h === 'number' ? data.tokens24h : null;
          var row = tmEl('div', 'pv-tm-row');
          row.appendChild(tmEl('span', null, tm('tokens24h')));
          row.appendChild(tmEl('span', 'pv-tm-val', tokens === null ? tm('noData') : String(tokens)));
          card.appendChild(row);
          var mcp = data && data.mcpMonthly;
          var mcpText = mcp ? (String(mcp.usage) + ' / ' + String(mcp.currentValue)) : tm('noData');
          var row2 = tmEl('div', 'pv-tm-row');
          row2.appendChild(tmEl('span', null, tm('mcpMonthly')));
          row2.appendChild(tmEl('span', 'pv-tm-val', mcpText));
          card.appendChild(row2);
        }
        if (errorText) card.appendChild(tmEl('div', 'pv-tm-card-error', errorText));
        return card;
      }

      /** 百分比行:value ≥80% 转 danger 色 */
      function statRow(label, win) {
        var row = tmEl('div', 'pv-tm-row');
        row.appendChild(tmEl('span', null, label));
        var pct = win && win.percent !== null && win.percent !== undefined
          ? win.percent : null;
        var val = pct === null
          ? tm('noData')
          : pct + '%' + (win.resetAt ? ' · ' + formatCountdown(win.resetAt) : '');
        var span = tmEl('span', 'pv-tm-val' + (pct !== null && pct >= 80 ? ' danger' : ''), val);
        row.appendChild(span);
        return row;
      }

      rerender();
    }
  });
