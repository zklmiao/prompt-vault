/**
 * Coding 套餐用量监控 —— 数据层 + UI 层(批次 3)
 *
 * 数据层:GLM(智谱)/ 火山方舟 / OpenCode 三家套餐用量的取数与解析,
 * 统一输出 { provider, fiveHour:{percent, resetAt}, weekly:{...}, tokens24h?, mcpMonthly? }。
 *   - percent:0-100 数值(非法/缺失为 null;火山限流语义见 parseOpencodeUsage);
 *   - resetAt:ISO 8601 UTC 字符串或 null(各家的毫秒/秒时间戳在此统一归一);
 *   - tokens24h 仅 GLM;mcpMonthly 仅 GLM(MCP 月度,字段原样透传)。
 *
 * UI 层(消费 window.pvTokenMonitor):
 *   - 球体:pv.window.setup({ size:{84,84}, onMount }) —— SVG 圆环(当前供应商 5h
 *     百分比),左键轮换已配置供应商,右键菜单(直选/立即刷新/打开详情面板/隐藏),
 *     悬停 tooltip;位置不感知不落盘(Rust Moved 防抖独占写 kv,见设计 §5.1);
 *   - 详情面板:pv.panel.register —— 每家一张卡(5h/周/24h/MCP 月度)+ 设置区
 *     (Key 录入走凭据桥,轮询开关存 ball.poll);
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
 *     registry 每窗口独立,事件总线不跨窗口;cache:<provider>(kv)是两实例唯一
 *     共享数据面(球实例写、面板实例读,last-wins)。两个实例都注册 panel 与
 *     window.setup:panel 只会在主窗被渲染,setup 的 onMount 只会在球窗被调用。
 *
 * 存储键契约(§5.1):
 *   window:visible(bool)—— 插件写(隐藏前落盘 false),宿主启动读(缺省视为 true);
 *   window:x / window:y(int,物理像素)—— 仅 Rust 拖动防抖独占写,插件不感知;
 *   ball.provider —— 当前供应商;ball.poll = {enabled, intervalSec}(钳制 ≥120s,默认关);
 *   cache:<provider> —— 最近一次成功数据 + fetchedAt,失败不覆盖。
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

  /* ==================== UI 层(批次 3) ==================== */

  // ---------- 常量与存储键(契约见文件头) ----------

  var KV_VISIBLE = 'window:visible';
  var KV_X = 'window:x';          // 仅 Rust 写,插件不读写
  var KV_Y = 'window:y';          // 仅 Rust 写,插件不读写
  var KV_PROVIDER = 'ball.provider';
  var KV_POLL = 'ball.poll';
  var KV_CACHE_PREFIX = 'cache:';
  var BALL_SIZE = 84;             // 球窗边长(与设计 §5.1 一致)
  var MENU_WIDTH = 172;           // 右键菜单宽度
  var POLL_MIN_SEC = 120;         // 轮询间隔下限(参照社区 statusline 120s 缓存实践)
  var POLL_DEFAULT_SEC = 300;     // 开启轮询且未指定间隔时的默认值

  // ---------- 微型 i18n:zh 默认 + en;窗口语言创建时定格(批次 2 已知限制) ----------

  var TM_I18N = {
    zh: {
      panelTitle: '用量监控',
      ballEmpty: '尚未配置供应商:请在详情面板录入 Key',
      ballIdle: '左键轮换 · 右键菜单 · 边缘拖动',
      refreshNow: '立即刷新',
      openPanel: '打开详情面板',
      hideBall: '隐藏圆球',
      fiveHour: '5h',
      weekly: '周',
      tokens24h: '24h Token',
      mcpMonthly: 'MCP 月度',
      noData: '暂无数据',
      keyPlaceholder: '粘贴 API Key',
      configured: '已配置 · 可更换',
      notConfigured: '未配置',
      saveKey: '录入',
      removeKey: '删除',
      keySaved: 'Key 已录入',
      keyDeleted: 'Key 已删除',
      pollLabel: '自动轮询(球窗常驻刷新)',
      pollInterval: '间隔(秒,≥120)',
      credSavedToast: 'Key 已录入(仅存凭据管理器)',
      credDeletedToast: 'Key 已删除',
      credFail: '凭据操作失败:',
      errPrefix: '取数失败:'
    },
    en: {
      panelTitle: 'Usage Monitor',
      ballEmpty: 'No provider configured: add a key in the details panel',
      ballIdle: 'Click to rotate · Right-click menu · Drag edges',
      refreshNow: 'Refresh now',
      openPanel: 'Open details panel',
      hideBall: 'Hide ball',
      fiveHour: '5h',
      weekly: 'Week',
      tokens24h: '24h Tokens',
      mcpMonthly: 'MCP monthly',
      noData: 'No data yet',
      keyPlaceholder: 'Paste API key',
      configured: 'Configured · replaceable',
      notConfigured: 'Not configured',
      saveKey: 'Save',
      removeKey: 'Remove',
      keySaved: 'Key saved',
      keyDeleted: 'Key removed',
      pollLabel: 'Auto poll (ball refresh)',
      pollInterval: 'Interval (sec, ≥120)',
      credSavedToast: 'Key saved (credential manager only)',
      credDeletedToast: 'Key removed',
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

  /** 拉取并写缓存:成功刷新缓存(带 fetchedAt),失败不覆盖上次成功 cache */
  function fetchAndCache(provider) {
    return window.pvTokenMonitor.refreshProvider(provider).then(function (data) {
      data.fetchedAt = Date.now();
      return pv.storage.set(KV_CACHE_PREFIX + provider, data)
        .then(function () { return data; })
        .catch(function () { return data; }); // 缓存写失败不影响本次数据展示
    });
  }

  /** 读取上次成功 cache:<provider>(无数据返回 null) */
  function readCache(provider) {
    return pv.storage.get(KV_CACHE_PREFIX + provider).then(function (data) {
      return data && typeof data === 'object' ? data : null;
    }).catch(function () { return null; });
  }

  function tmEl(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
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
      '.pv-tm-pct{font-size:11px;fill:var(--text);}',
      '.pv-tm-pct.err{fill:var(--danger);font-weight:700;}',
      '.pv-tm-pct.empty{fill:var(--muted);}',
      '.pv-tm-ring{transition:stroke-dashoffset .4s ease,stroke .4s ease;}',
      '.pv-tm-menu{position:absolute;left:4px;top:84px;width:172px;z-index:10;',
        'background:var(--panel);border:1px solid var(--border);border-radius:8px;',
        'padding:4px;box-shadow:var(--shadow-lg);}',
      '.pv-tm-menu-item{display:flex;justify-content:space-between;align-items:center;gap:12px;',
        'padding:5px 10px;border-radius:5px;font-size:12px;color:var(--text);cursor:pointer;',
        'white-space:nowrap;}',
      '.pv-tm-menu-item:hover{background:var(--panel-hover);}',
      '.pv-tm-menu-item .pv-tm-check{color:var(--accent);font-weight:700;}',
      '.pv-tm-menu-sep{height:1px;background:var(--border);margin:4px 6px;}',
      '.pv-tm-panel{display:flex;flex-direction:column;gap:12px;max-width:560px;}',
      '.pv-tm-cards{display:flex;flex-direction:column;gap:8px;}',
      '.pv-tm-card{border:1px solid var(--border);border-radius:8px;padding:10px 12px;',
        'display:flex;flex-direction:column;gap:6px;background:var(--panel);}',
      '.pv-tm-card-head{display:flex;align-items:center;justify-content:space-between;}',
      '.pv-tm-card-title{font-size:13px;font-weight:600;color:var(--text);}',
      '.pv-tm-row{display:flex;justify-content:space-between;gap:12px;font-size:12px;color:var(--muted);}',
      '.pv-tm-row .pv-tm-val{color:var(--text);}',
      '.pv-tm-val.danger{color:var(--danger);font-weight:600;}',
      '.pv-tm-card-error{color:var(--danger);font-size:12px;}',
      '.pv-tm-muted{color:var(--muted);font-size:12px;}',
      '.pv-tm-settings{border-top:1px solid var(--border);padding-top:10px;',
        'display:flex;flex-direction:column;gap:8px;}',
      '.pv-tm-set-row{display:flex;align-items:center;gap:8px;font-size:12px;}',
      '.pv-tm-set-label{min-width:72px;color:var(--muted);white-space:nowrap;}'
    ].join('');
    document.head.appendChild(style);
  }

  // ---------- 球体(pv.window.setup;仅球窗实例的 onMount 会执行) ----------

  var ballProvider = null;   // 当前供应商
  var ballData = null;       // 当前供应商最近一次成功数据(cache 或本次拉取)
  var ballError = null;      // 最近一次取数错误摘要
  var ballNoConfigured = false; // 无已配置供应商的灰态
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
    wrap.setAttribute('data-tauri-drag-region', '');
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
      if (wasClick) rotateProvider();
    });
    wrap.appendChild(ball);
    var menu = tmEl('div', 'pv-tm-menu');
    menu.hidden = true;
    wrap.appendChild(menu);
    el.appendChild(wrap);

    // 失焦即收起(球窗右键菜单;§9)
    window.addEventListener('blur', function () { closeTmMenu(wrap); });

    renderBall();
    // 启动序列:读当前供应商 → 渲染上次成功 cache → 拉一次新数据 → 轮询
    pv.storage.get(KV_PROVIDER).then(function (saved) {
      return pv.credentials.configured().then(function (list) {
        var configuredList = Array.isArray(list) ? list : [];
        if (configuredList.length === 0) {
          ballNoConfigured = true;
          renderBall();
          return;
        }
        ballNoConfigured = false;
        ballProvider = configuredList.indexOf(saved) >= 0 ? saved : configuredList[0];
        renderBall();
        return readCache(ballProvider).then(function (cached) {
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

  /** 球体渲染:圆环 = 5h 百分比;环底 --border、进度 --accent(≥80% --danger)、
   *  中心 abbr + 百分比;失败态环保留最近缓存值 + 中心「!」,tooltip 错误摘要 */
  function renderBall() {
    var wrap = document.querySelector('.pv-tm-wrap');
    if (!wrap) return;
    var ball = wrap.querySelector('.pv-tm-ball');
    if (!ball) return;
    var meta = ballProvider ? window.pvTokenMonitor.meta[ballProvider] : null;
    var pct = ballData && ballData.fiveHour ? ballData.fiveHour.percent : null;
    var ring = 201.06; // 2πr(r=32)
    var offset = pct === null ? ring : ring * (1 - Math.min(100, Math.max(0, pct)) / 100);
    var stroke = pct !== null && pct >= 80 ? 'var(--danger)' : 'var(--accent)';
    var abbr = meta ? meta.abbr : '—';
    var pctClass = ballError ? 'pv-tm-pct err' : (pct === null ? 'pv-tm-pct empty' : 'pv-tm-pct');
    var center2 = ballError ? '!' : (pct === null ? '–' : (Math.round(pct * 100) / 100) + '%');
    ball.innerHTML =
      '<svg viewBox="0 0 76 76" width="76" height="76" aria-hidden="true">' +
      '<circle cx="38" cy="38" r="32" fill="none" stroke="var(--border)" stroke-width="6"/>' +
      '<circle class="pv-tm-ring" cx="38" cy="38" r="32" fill="none" stroke="' + stroke + '" stroke-width="6" ' +
      'stroke-linecap="round" stroke-dasharray="' + ring + '" stroke-dashoffset="' + offset + '" transform="rotate(-90 38 38)"/>' +
      '<text class="pv-tm-abbr" x="38" y="36" text-anchor="middle">' + abbr + '</text>' +
      '<text class="' + pctClass + '" x="38" y="51" text-anchor="middle">' + center2 + '</text>' +
      '</svg>';
    ball.title = buildBallTooltip();
  }

  /** tooltip:5h% / 周% / 距重置倒计时;失败附错误摘要;空态提示录入 Key */
  function buildBallTooltip() {
    if (ballNoConfigured) return tm('ballEmpty');
    if (!ballProvider) return tm('ballEmpty');
    var meta = window.pvTokenMonitor.meta[ballProvider];
    var lines = [meta ? meta.label : ballProvider];
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

  /** 左键:在已配置供应商间轮换并立即取数(每次现读 configured,保持新鲜) */
  function rotateProvider() {
    pv.credentials.configured().then(function (list) {
      var configuredList = Array.isArray(list) ? list : [];
      if (configuredList.length === 0) {
        ballNoConfigured = true;
        ballProvider = null;
        ballData = null;
        ballError = null;
        renderBall();
        return;
      }
      var idx = configuredList.indexOf(ballProvider);
      setProvider(configuredList[(idx + 1) % configuredList.length]);
    }).catch(function (err) {
      ballError = (err && err.message) || String(err);
      renderBall();
    });
  }

  /** 切换供应商:复位状态 → 持久化 → 渲染缓存 → 拉新数据 */
  function setProvider(provider) {
    ballNoConfigured = false;
    ballProvider = provider;
    ballData = null;
    ballError = null;
    renderBall();
    pv.storage.set(KV_PROVIDER, provider).catch(function () {});
    var proceed = readCache(provider).then(function (cached) {
      if (cached) {
        ballData = cached;
        renderBall();
      }
      return refreshBallData();
    });
    void proceed;
  }

  /** 拉当前供应商数据并渲染;失败:环保留缓存值 + 中心「!」+ tooltip 错误 */
  function refreshBallData() {
    if (!ballProvider) return Promise.resolve();
    return fetchAndCache(ballProvider).then(function (data) {
      ballData = data;
      ballError = null;
      renderBall();
    }).catch(function (err) {
      ballError = (err && err.message) || String(err);
      renderBall();
    });
  }

  /** 轮询生命周期(§5.2):球实例持有 —— mount 且 ball.poll.enabled 即启;
   *  每 tick 重读配置(面板改配置无需重开窗口),停用即自停,间隔变更重启 */
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
          refreshBallData();
        }).catch(function () { stopPoll(); });
      }, pollPeriodMs);
    }).catch(function () { /* 配置读取失败:保持手动模式 */ });
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      pollPeriodMs = 0;
    }
  }

  // ---------- 右键菜单(自注入样式见 ensureTmStyles;失焦即收起) ----------

  /** 菜单展开需扩窗:84×84 窗口装不下 6 项菜单(webview 内容裁剪),
   *  经 pv.window.resize 临时扩窗,收起恢复 84×84(实现决策,见开工卡偏差)。
   *  注意:菜单项经 configured() 异步填充,必须等填充完成再测高,
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

  /** 菜单内容:直选供应商(✓ 当前)+ 立即刷新 + 打开详情面板 + 隐藏;
   *  返回填充完成 Promise(供扩窗前测量) */
  function buildTmMenu(menu) {
    menu.innerHTML = '';
    return pv.credentials.configured().then(function (list) {
      var configuredList = Array.isArray(list) ? list : [];
      for (var i = 0; i < configuredList.length; i++) {
        (function (p) {
          var meta = window.pvTokenMonitor.meta[p];
          var item = tmEl('div', 'pv-tm-menu-item');
          item.appendChild(tmEl('span', null, meta ? meta.label : p));
          if (p === ballProvider) item.appendChild(tmEl('span', 'pv-tm-check', '✓'));
          item.addEventListener('click', function () {
            closeTmMenu();
            setProvider(p);
          });
          menu.appendChild(item);
        })(configuredList[i]);
      }
      if (configuredList.length > 0) menu.appendChild(tmEl('div', 'pv-tm-menu-sep'));
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

      // 卡片区(每家已配置供应商一张卡)
      var cards = tmEl('div', 'pv-tm-cards');
      root.appendChild(cards);

      // 设置区:Key 录入(3 家固定)+ 轮询设置
      var settings = tmEl('div', 'pv-tm-settings');
      var panelErrors = {}; // provider → 最近一次取数错误(不覆盖 cache)

      var PROVIDER_ORDER = ['glm', 'volcengine', 'opencode'];
      for (var i = 0; i < PROVIDER_ORDER.length; i++) {
        (function (p) {
          var meta = window.pvTokenMonitor.meta[p];
          var row = tmEl('div', 'pv-tm-set-row');
          row.appendChild(tmEl('span', 'pv-tm-set-label', meta ? meta.label : p));
          var input = document.createElement('input');
          input.className = 'input';
          input.type = 'password';
          input.placeholder = tm('keyPlaceholder');
          input.autocomplete = 'off';
          var saveBtn = tmEl('button', 'btn small', tm('saveKey'));
          var delBtn = tmEl('button', 'btn small', tm('removeKey'));
          var status = tmEl('span', 'pv-tm-muted');
          row.appendChild(input);
          row.appendChild(saveBtn);
          row.appendChild(delBtn);
          row.appendChild(status);
          settings.appendChild(row);

          var refreshStatus = function (configuredList) {
            var has = configuredList.indexOf(p) >= 0;
            status.textContent = has ? tm('configured') : tm('notConfigured');
            input.disabled = false;
            delBtn.disabled = !has;
            delBtn.style.visibility = has ? 'visible' : 'hidden';
          };

          saveBtn.addEventListener('click', function () {
            var secret = input.value;
            if (secret === '') return;
            pv.credentials.set(p, secret).then(function () {
              input.value = '';
              return pv.credentials.configured().then(function (list) {
                refreshStatus(list);
                renderPanelCards();
              });
            }).catch(function (err) {
              status.textContent = tm('credFail') + ((err && err.message) || String(err));
            });
          });
          delBtn.addEventListener('click', function () {
            pv.credentials.delete(p).then(function () {
              return pv.credentials.configured().then(function (list) {
                refreshStatus(list);
                renderPanelCards();
              });
            }).catch(function (err) {
              status.textContent = tm('credFail') + ((err && err.message) || String(err));
            });
          });

          // 初始状态经 configured() 现读(面板实例与球实例的 kv/凭据共享)
          pv.credentials.configured().then(refreshStatus).catch(function () {
            status.textContent = tm('notConfigured');
          });
        })(PROVIDER_ORDER[i]);
      }

      // 轮询设置行:开关 + 间隔(钳制 ≥120s;默认关;存 ball.poll)
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
      el.appendChild(root);

      /** 渲染卡片区:每家已配置供应商一张卡;数据渲染 cache:<provider> */
      function renderPanelCards() {
        pv.credentials.configured().then(function (list) {
          cards.innerHTML = '';
          var configuredList = Array.isArray(list) ? list : [];
          if (configuredList.length === 0) {
            cards.appendChild(tmEl('div', 'pv-tm-muted', tm('ballEmpty')));
            return;
          }
          var reads = configuredList.map(function (p) { return readCache(p); });
          Promise.all(reads).then(function (results) {
            for (var i = 0; i < configuredList.length; i++) {
              cards.appendChild(buildCard(configuredList[i], results[i], panelErrors[configuredList[i]] || null));
            }
          });
        }).catch(function (err) {
          cards.innerHTML = '';
          cards.appendChild(tmEl('div', 'pv-tm-card-error', (err && err.message) || String(err)));
        });
      }

      /** 单张卡:5h(百分比+倒计时)/ 周 / 24h 聚合(GLM)/ MCP 月度(GLM) */
      function buildCard(provider, data, errorText) {
        var meta = window.pvTokenMonitor.meta[provider];
        var card = tmEl('div', 'pv-tm-card');
        var head = tmEl('div', 'pv-tm-card-head');
        head.appendChild(tmEl('div', 'pv-tm-card-title', meta ? meta.label : provider));
        var refreshBtn = tmEl('button', 'btn small', tm('refreshNow'));
        refreshBtn.addEventListener('click', function () {
          refreshBtn.disabled = true;
          fetchAndCache(provider).then(function () {
            panelErrors[provider] = null;
            renderPanelCards();
          }).catch(function (err) {
            panelErrors[provider] = (err && err.message) || String(err);
            renderPanelCards();
          });
        });
        head.appendChild(refreshBtn);
        card.appendChild(head);

        var five = (data && data.fiveHour) || {};
        var week = (data && data.weekly) || {};
        card.appendChild(statRow(tm('fiveHour'), five));
        card.appendChild(statRow(tm('weekly'), week));
        if (provider === 'glm') {
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

      renderPanelCards();
    }
  });
