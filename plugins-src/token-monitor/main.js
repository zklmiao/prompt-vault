/**
 * Coding 套餐用量监控 —— 数据层(v1 骨架,不含 UI)
 *
 * 职责:GLM(智谱)/ 火山方舟 / OpenCode 三家套餐用量的取数与解析,
 * 统一输出 { provider, fiveHour:{percent, resetAt}, weekly:{...}, tokens24h?, mcpMonthly? }。
 *   - percent:0-100 数值(非法/缺失为 null;火山限流语义见 parseOpencodeUsage);
 *   - resetAt:ISO 8601 UTC 字符串或 null(各家的毫秒/秒时间戳在此统一归一);
 *   - tokens24h 仅 GLM;mcpMonthly 仅 GLM(MCP 月度,字段原样透传)。
 *
 * 约定:
 *   - pv-1 书写形态:本文件只写 IIFE 函数体,由宿主包进
 *     (function(pv){ "use strict"; … })(window.__pvSlot) 内联执行;
 *     桥随闭包参数 pv 封闭,本文件不引用 window.pv;
 *   - 所有网络请求一律经宿主桥 pv.net.fetch(url, { authFrom, mode }) 走 Rust 代理,
 *     host 白名单 / SSRF 校验 / 认证注入(含火山 V4 签名)都在 Rust 内完成,
 *     Key 明文不出 Rust 进程,本文件接触不到任何凭据;
 *   - 解析函数全部为无副作用的纯函数,便于主线接 UI 后用假响应单测;
 *   - 圆球 UI(圆环进度 / 左键轮换 / 右键菜单,见设计文档 §5.1)由主线接手,
 *     届时调 pv.window.setup({ size, onMount }) 并消费 window.pvTokenMonitor。
 */

  // ============ 常量:三家供应商的取数契约(端点事实见设计文档附录 A,2026-11 核实) ============

  var GLM_BASE = 'https://open.bigmodel.cn';
  var VOLC_URL = 'https://ark.cn-beijing.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01';
  var OPENCODE_URL = 'https://opencode.ai/zen/go/v1/usage';

  /** 供应商元信息:label 供详情面板,abbr 供圆球中心缩写(设计 §5.1:GLM / ARK / OC) */
  var PROVIDERS = {
    glm: { label: 'GLM Coding', abbr: 'GLM' },
    volcengine: { label: '火山方舟', abbr: 'ARK' },
    opencode: { label: 'OpenCode', abbr: 'OC' }
  };

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

  /** GLM:quota/limit(套餐窗口 + MCP 月度)+ model-usage(近 24h 聚合),mode raw */
  function fetchGlm() {
    var quotaPromise = callNet(GLM_BASE + '/api/monitor/usage/quota/limit', {
      authFrom: 'credential:glm',
      mode: 'raw'
    }).then(parseJson).then(parseGlmQuota);
    // 时间参数格式 yyyy-MM-dd HH:mm:ss,URL 编码后拼 query
    var range = glmDayRange(new Date());
    var usageQuery =
      '?startTime=' + encodeURIComponent(range.startTime) +
      '&endTime=' + encodeURIComponent(range.endTime);
    var usagePromise = callNet(GLM_BASE + '/api/monitor/usage/model-usage' + usageQuery, {
      authFrom: 'credential:glm',
      mode: 'raw'
    }).then(parseJson).then(parseGlmModelUsage);
    return Promise.all([quotaPromise, usagePromise]).then(function (results) {
      var quota = results[0];
      var tokens = results[1];
      return {
        provider: 'glm',
        fiveHour: quota.fiveHour,
        weekly: quota.weekly,
        mcpMonthly: quota.mcpMonthly,
        tokens24h: tokens.tokens24h
      };
    });
  }

  /** 火山:GetAFPUsage,mode volcengine(V4 签名双头 X-Date/Authorization 在 Rust 内完成) */
  function fetchVolcengine() {
    return callNet(VOLC_URL, {
      authFrom: 'credential:volcengine',
      mode: 'volcengine'
    })
      .then(parseJson)
      .then(function (payload) {
        var usage = parseVolcUsage(payload);
        return { provider: 'volcengine', fiveHour: usage.fiveHour, weekly: usage.weekly };
      });
  }

  /** OpenCode:zen/go/v1/usage,mode bearer */
  function fetchOpencode() {
    return callNet(OPENCODE_URL, {
      authFrom: 'credential:opencode',
      mode: 'bearer'
    })
      .then(parseJson)
      .then(function (payload) {
        var usage = parseOpencodeUsage(payload);
        return { provider: 'opencode', fiveHour: usage.fiveHour, weekly: usage.weekly };
      });
  }

  // ============ 对外入口 ============

  var FETCHERS = {
    glm: fetchGlm,
    volcengine: fetchVolcengine,
    opencode: fetchOpencode
  };

  /**
   * 刷新指定供应商,resolve 统一结构:
   * { provider, fiveHour:{percent, resetAt}, weekly:{percent, resetAt}, tokens24h?, mcpMonthly? }
   * 失败 reject Error(桥未就绪 / HTTP 非 2xx / 响应非 JSON / 解析异常),由 UI 层 toast。
   */
  function refreshProvider(provider) {
    var fetcher = FETCHERS[provider];
    if (!fetcher) return Promise.reject(new Error('未知的供应商:' + provider));
    return fetcher();
  }

  // 暴露给宿主 UI 与后续单测(假响应直喂各 parse 纯函数)
  window.pvTokenMonitor = {
    providers: Object.keys(FETCHERS),
    meta: PROVIDERS,
    refreshProvider: refreshProvider,
    parseGlmQuota: parseGlmQuota,
    parseGlmModelUsage: parseGlmModelUsage,
    parseVolcUsage: parseVolcUsage,
    parseOpencodeUsage: parseOpencodeUsage,
    glmDayRange: glmDayRange
  };
