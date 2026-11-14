#!/usr/bin/env node
// 插件源打包器:扫描 plugins-src/*/manifest.json → 逐插件生成 zip(STORED+CRC32,
// 与应用安装管线兼容:根级 manifest.json 布局)→ 计算 sha256 → 生成 pv-plugins.json。
//
// 用法:
//   node build-source.mjs [--base <源主页地址>]
//     --base  用户在「插件源」里填的仓库主页地址(gitea 形态:protocol://host[:port]/owner/repo)。
//             缺省自动探测本机全局 IPv6 + 8899 端口(与 serve.mjs 配套)。
//   产物写在脚本所在目录(pv-plugins.json 与 <id>-<version>.zip)。
//
// 注意:zip `url` 必须是绝对 http(s) 地址(安装管线拒绝相对路径);IPv6 变化后重跑本脚本。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginsSrcDir = join(scriptDir, "..", "plugins-src");
const DEFAULT_PORT = 8899;

/* ---------- 参数 ---------- */
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--base") out.base = argv[++i];
    else throw new Error(`未知参数:${argv[i]}`);
  }
  return out;
}

/* ---------- 全局 IPv6 探测(SSRF 只放行全局单播 2000::/3,环回/ULA/链路本地被拒) ---------- */
function detectGlobalV6() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const ni of ifaces || []) {
      if (
        ni.family === "IPv6" &&
        !ni.internal &&
        /^[23][0-9a-f]/i.test(ni.address)
      ) {
        return ni.address;
      }
    }
  }
  return null;
}

/* ---------- 零依赖 zip(STORED + CRC32) ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

const u16 = (v) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
};
const u32 = (v) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
};

/** files: [{ name(正斜杠路径), data(Buffer) }] → zip Buffer(STORED,根级布局) */
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(time), u16(date),
      u32(crc), u32(f.data.length), u32(f.data.length), u16(name.length), u16(0), name,
    ]);
    chunks.push(local, f.data);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(time), u16(date),
      u32(crc), u32(f.data.length), u32(f.data.length), u16(name.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    offset += local.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...chunks, cd, eocd]);
}

/* ---------- 收集插件目录文件(正斜杠相对路径) ---------- */
function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      for (const sub of collectFiles(p)) out.push({ name: `${entry}/${sub.name}`, data: sub.data });
    } else {
      out.push({ name: entry, data: readFileSync(p) });
    }
  }
  return out;
}

/* ---------- 主流程 ---------- */
const args = parseArgs(process.argv);

const v6 = detectGlobalV6();
const base =
  args.base ??
  (v6
    ? `http://[${v6}]:${DEFAULT_PORT}/pv/plugins`
    : null);
if (!base) {
  console.error(
    "未探测到全局 IPv6 且未提供 --base。SSRF 防护拒绝环回/私网地址,\n" +
      "请用本机公网地址执行:node build-source.mjs --base http://<host>[:port]/owner/repo",
  );
  process.exit(1);
}
console.log(`源主页地址(base): ${base}`);

const entries = readdirSync(pluginsSrcDir).filter((name) =>
  statSync(join(pluginsSrcDir, name)).isDirectory(),
);
if (entries.length === 0) {
  console.error(`plugins-src/ 下没有插件目录:${pluginsSrcDir}`);
  process.exit(1);
}

const plugins = [];
for (const dirName of entries) {
  const dir = join(pluginsSrcDir, dirName);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (manifest.id !== dirName) {
    throw new Error(`manifest.id(${manifest.id}) 与目录名(${dirName})不一致`);
  }
  let desc = "";
  try {
    desc = readFileSync(join(dir, "desc.txt"), "utf8").trim();
  } catch {
    desc = manifest.desc ?? "";
  }
  const zipName = `${manifest.id}-${manifest.version}.zip`;
  const zip = buildZip(collectFiles(dir));
  const zipPath = join(scriptDir, zipName);
  writeFileSync(zipPath, zip);
  const sha256 = createHash("sha256").update(zip).digest("hex");
  plugins.push({
    id: manifest.id,
    name: manifest.name,
    desc,
    channels: {
      // zip URL 与 pv-plugins.json 自身获取路径同形状(gitea/gitee 的 raw 形态),
      // 本地 serve.mjs 与真实 gitee/gitea 托管均按此重写生效
      release: {
        version: manifest.version,
        url: `${base}/raw/main/${zipName}`,
        sha256,
      },
    },
    minAppVersion: manifest.minAppVersion,
    permissions: manifest.permissions,
  });
  console.log(`打包 ${zipName}(zip ${zip.length} B,sha256 ${sha256.slice(0, 12)}…)`);
}

// 清理旧版本 zip(不再被引用的)
const used = new Set(plugins.map((p) => `${p.id}-${p.channels.release.version}.zip`));
for (const f of readdirSync(scriptDir)) {
  if (f.endsWith(".zip") && !used.has(f)) {
    rmSync(join(scriptDir, f));
    console.log(`清理旧包 ${f}`);
  }
}

const source = {
  name: "Prompt Vault 官方插件源",
  plugins,
};
writeFileSync(join(scriptDir, "pv-plugins.json"), JSON.stringify(source, null, 2) + "\n");
console.log(`生成 pv-plugins.json(${plugins.length} 个插件)`);
