// 手写最小 semver 比较(与 Rust 侧 plugins.rs 同一套排序规则):
// 核心三元组逐位比较;pre-release 优先级低于正式版;pre 标识符 数字 < 字母数字,
// 同类按数值/字典序;前缀相同则少标识符更低。构建元数据不参与比较。

interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: Array<{ kind: "num"; value: number } | { kind: "text"; value: string }>;
}

export function parseSemver(input: string): SemVer | null {
  const s = input.trim();
  const dash = s.indexOf("-");
  const core = dash === -1 ? s : s.slice(0, dash);
  const preRaw = dash === -1 ? null : s.slice(dash + 1);
  const plusCore = core.indexOf("+");
  const coreClean = plusCore === -1 ? core : core.slice(0, plusCore);
  const parts = coreClean.split(".");
  if (parts.length !== 3) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n))) return null;
  const pre: SemVer["pre"] = [];
  if (preRaw !== null) {
    const preClean = (() => {
      const plus = preRaw.indexOf("+");
      return plus === -1 ? preRaw : preRaw.slice(0, plus);
    })();
    if (preClean === "") return null;
    for (const ident of preClean.split(".")) {
      if (ident === "") return null;
      if (/^\d+$/.test(ident)) {
        pre.push({ kind: "num", value: Number(ident) });
      } else if (/^[0-9A-Za-z-]+$/.test(ident)) {
        pre.push({ kind: "text", value: ident });
      } else {
        return null;
      }
    }
  }
  return { major: nums[0], minor: nums[1], patch: nums[2], pre };
}

function comparePre(
  a: SemVer["pre"],
  b: SemVer["pre"],
): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // 无 pre-release 优先级更高
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x.kind === "num" && y.kind === "num") {
      if (x.value !== y.value) return x.value - y.value;
    } else if (x.kind === "num") {
      return -1; // 数字标识符 < 字母数字
    } else if (y.kind === "num") {
      return 1;
    } else if (x.value !== y.value) {
      return x.value < y.value ? -1 : 1;
    }
  }
  return a.length - b.length;
}

export function compareSemver(a: string, b: string): number {
  const va = parseSemver(a);
  const vb = parseSemver(b);
  if (!va || !vb) return 0; // 无法解析视为相等(不触发误报的新版提示)
  if (va.major !== vb.major) return va.major - vb.major;
  if (va.minor !== vb.minor) return va.minor - vb.minor;
  if (va.patch !== vb.patch) return va.patch - vb.patch;
  return comparePre(va.pre, vb.pre);
}

/** a 是否严格新于 b */
export function isNewerVersion(a: string, b: string): boolean {
  return compareSemver(a, b) > 0;
}
