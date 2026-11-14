#!/usr/bin/env node
// 插件源本地静态服务:把本目录当作一个「插件源仓库」提供 HTTP 访问,用于本地试用
// 「插件源 → 市场 → 安装」全链路(应用侧 SSRF 只放行全局地址,环回/私网被拒)。
//
// 用法:node serve.mjs [端口]      # 缺省 8899,监听 ::(双栈)
// 输出:探测到的全局 IPv6 与可直接粘贴到「插件源」的主页地址。
//
// 重写规则(模拟 gitea raw 形态):GET /{owner}/{repo}/raw/{ref}/<path> → 服务 <path>;
// 其余路径按普通静态文件处理。安全:归一化后必须仍落在本目录内(防穿越)。
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const root = fileURLToPath(new URL(".", import.meta.url));
const port = Number(process.argv[2] || 8899);

const MIME = {
  ".json": "application/json",
  ".zip": "application/zip",
  ".js": "application/javascript",
  ".md": "text/markdown",
  ".txt": "text/plain",
};

function globalV6Candidates() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const ni of ifaces || []) {
      if (ni.family === "IPv6" && !ni.internal && /^[23][0-9a-f]/i.test(ni.address)) {
        out.push(ni.address);
      }
    }
  }
  return out;
}

/** 从 URL 路径解析要服务的相对文件;穿越/非法一律 null */
function resolveFile(pathname) {
  // gitea raw 形态:/owner/repo/raw/ref/<path> → <path>
  const raw = pathname.match(/^\/[^/]+\/[^/]+\/raw\/[^/]+\/(.+)$/);
  const rel = raw ? raw[1] : pathname.replace(/^\//, "");
  const cleaned = normalize(decodeURIComponent(rel)).replace(/^([A-Za-z]:)?[\\/]+/, "");
  if (!cleaned || cleaned.includes("..")) return null;
  const abs = join(root, cleaned);
  if (!abs.startsWith(root) || !existsSync(abs) || !statSync(abs).isFile()) return null;
  return abs;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://x`);
  const file = resolveFile(url.pathname);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 not found");
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, {
    "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": body.length,
  });
  res.end(body);
});

server.listen(port, "::", () => {
  console.log(`插件源目录:${root}`);
  console.log(`服务已启动(http://[::]:${port},双栈)。粘贴到「插件源」的主页地址:`);
  for (const addr of globalV6Candidates()) {
    console.log(`  http://[${addr}]:${port}/pv/plugins`);
  }
  console.log(`(IPv6 变化后:重启本服务,并重跑 node build-source.mjs 重新生成 pv-plugins.json)`);
});
