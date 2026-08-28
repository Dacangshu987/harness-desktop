"use strict";

/*
 * dsh-server.js — Shared logic for launching (and attaching to) a DeepSeek
 * Harness `dsh web` server. Used by the Electron main process and by the
 * standalone smoke test (scripts/smoke.js), so the spawn/readiness behaviour
 * is exercised exactly the way the packaged client runs it.
 *
 * All paths are resolved on Windows. Native deps that DSH uses (sharp, koffi,
 * node-pty) are prebuilt and load under the *system* Node binary — which is
 * why the server is always spawned as a child of system Node, never in-process.
 */

const { spawn, spawnSync, execFileSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");

/** String that DSH's served index.html always contains. */
const DSH_HTML_MARKER = "@deepseek-ai/dsh-client-modules";
/** Relative path (from a package root) of the dsh CLI entry. */
const DSH_BIN_REL = path.join("@deepseek-ai", "dsh", "lib", "bin.js");

/** Resolve the system `node` binary the dsh server should be spawned under. */
function resolveNodeBin({ allowSelf = true } = {}) {
  // 打包内置的便携 Node（resources/app/node 或开发目录 ./node）。
  const bundled = [
    process.resourcesPath ? path.join(process.resourcesPath, "app", "node", "node.exe") : null,
    path.join(__dirname, "..", "node", "node.exe"),
  ].filter(Boolean);
  const candidates = [
    process.env.DSH_CLIENT_NODE,
    ...bundled,
    resolveWindowsCommand("node"),
  ].filter(Boolean);
  if (allowSelf) candidates.push(process.execPath);
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/** Use `where.exe` to find a command on PATH (Windows). */
function resolveWindowsCommand(command) {
  try {
    const r = spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true });
    if (r.status === 0 && r.stdout) {
      const first = r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first && fs.existsSync(first)) return first;
    }
  } catch {
    /* command not found / not Windows */
  }
  return null;
}

/** Resolve the dsh CLI bin.js for the active project. */
function resolveDshBin(overrides = {}) {
  const candidates = [];
  if (overrides.dshBin) candidates.push(overrides.dshBin);
  if (process.env.DSH_CLIENT_DSH_BIN) candidates.push(process.env.DSH_CLIENT_DSH_BIN);

  // Bundled next to this file (dev) — packaged with asar:false → resources/app.
  candidates.push(path.join(__dirname, "..", "node_modules", DSH_BIN_REL));

  // Packaged layout fallback (resources/app/node_modules/...).
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "app", "node_modules", DSH_BIN_REL));
  }

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }

  // Fallback: scan the npx cache for the most recently installed dsh.
  for (const c of npxCacheCandidates()) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** Find candidate dsh bin.js paths in the npx cache, newest first. */
function npxCacheCandidates() {
  const root = path.join(process.env.LOCALAPPDATA || "", "npm-cache", "_npx");
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const dir of fs.readdirSync(root)) {
    const bin = path.join(root, dir, "node_modules", DSH_BIN_REL);
    if (fs.existsSync(bin)) {
      try {
        found.push({ f: bin, t: fs.statSync(bin).mtimeMs });
      } catch {
        /* ignore unreadable entries */
      }
    }
  }
  return found.sort((a, b) => b.t - a.t).map((x) => x.f);
}

/** True when something is already listening on `port` (host). */
function isPortBusy(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(true));
    srv.once("listening", () => srv.close(() => resolve(false)));
    srv.listen(port, host);
  });
}

/** Ask the OS for a currently-free port. */
function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(null));
    srv.listen(0, host, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** Probe a URL and report DSH-ness. Returns { ok, dsh } or null on failure. */
function probeDsh(port, host = "127.0.0.1", timeout = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/", timeout }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        resolve({ ok: res.statusCode < 500, dsh: body.includes(DSH_HTML_MARKER) });
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}

/**
 * Decide the port the client will serve on and whether an existing DSH server
 * is already there. If an existing DSH server owns `preferred`, we attach to it
 * (`reused: true`) instead of spawning a second instance.
 */
async function resolvePort(preferred = 3080, { host = "127.0.0.1" } = {}) {
  // Probe using 127.0.0.1 regardless of bind host, because that's the
  // loopback address the local client always connects to.
  const probeHost = "127.0.0.1";
  const probe = await probeDsh(preferred, probeHost, 1500);
  if (probe && probe.dsh) return { port: preferred, reused: true };
  if (probe && probe.ok) {
    // Some other HTTP service is on the preferred port — take another.
    const alt = host === "0.0.0.0" ? await findFreePort("127.0.0.1") : await findFreePort(host);
    return { port: alt || preferred, reused: false };
  }
  if (!(await isPortBusy(preferred, host))) return { port: preferred, reused: false };
  const alt = await findFreePort(host);
  return { port: alt || preferred, reused: false };
}

/** Spawn `dsh web` as a child of the given Node binary. */
function spawnServer({
  nodeBin,
  dshBin,
  port,
  host = "127.0.0.1",
  workspace,
  dshHome,
}) {
  const args = [dshBin, "web", "--no-open", "--port", String(port)];
  let patchFile = null;
  // dsh web's --host CLI rejects 0.0.0.0 for safety, and the host config schema
  // only accepts "127.0.0.1" | "0.0.0.0" (LAN IPs are rejected).
  // The webserver row reads host from `ctx.webStartup.host ?? '127.0.0.1'`
  // (set via --host). We bypass the CLI entirely with a valid loader patch
  // that OVERRIDES the webserver row's `config` — applyEntryPatches replaces
  // the whole `config` key, so host AND port must both be restated.
  // IMPORTANT: --patch MUST come BEFORE --no-open / --port (which are unknown
  // to the launcher and trigger passThroughOptions, swallowing later flags).
  if (host && host !== "127.0.0.1") {
    const patchDir = dshHome ? path.join(dshHome, "profiles", "web") : workspace;
    patchFile = path.join(patchDir, `.host-patch-${port}.yml`);
    const patchYaml = [
      "- id: webserver",
      "  config:",
      `    host: "${host}"`,
      "    port: !!js ctx.webStartup.port ?? 3080",
    ].join("\n") + "\n";
    try {
      fs.writeFileSync(patchFile, patchYaml, "utf8");
      // Insert --patch right after "web" so it's parsed by the launcher.
      args.splice(2, 0, "--patch", patchFile);
    } catch { /* fallback */ }
  }
  const env = { ...process.env };
  if (dshHome) env.DSH_HOME = dshHome;
  // 把内置 Node 的目录加入 PATH：node 目录自带 npm/npx/corepack 的 .cmd shim，
  // 这样 dsh 服务内的插件「更新」机制（dsh-remote-web-ui 会依次尝试
  // pnpm → corepack → npx）能解析到 corepack（→ 走缓存的 pnpm），
  // 否则在无系统 Node 的机器上会报 "'pnpm' 不是内部或外部命令"。
  const nodeDir = path.dirname(nodeBin);
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") || "Path";
  const curPath = env[pathKey] || "";
  env[pathKey] = nodeDir + (curPath ? ";" + curPath : "");
  const cwd = workspace && fs.existsSync(workspace) ? workspace : process.cwd();

  const child = spawn(nodeBin, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Distinguish a successful boot from a crash by watching the exit code.
  child._meta = { nodeBin, dshBin, port, host, cwd };
  // Clean up temp patch file on exit.
  if (patchFile) {
    child.on("exit", () => {
      try { fs.unlinkSync(patchFile); } catch { /* ignore */ }
    });
  }
  return child;
}

/** Pipe child stdout/stderr into onLine (and a stream, when provided). */
function attachLogging(child, { onLine, toStream } = {}) {
  const pipe = (chunk) => {
    const text = chunk.toString();
    if (onLine) onLine(text);
    if (toStream) toStream.write(text);
  };
  if (child.stdout) child.stdout.on("data", pipe);
  if (child.stderr) child.stderr.on("data", pipe);
}

/** Poll until the DSH index page (with its marker) is served, or timeout. */
async function waitForDsh(port, { host = "127.0.0.1", timeoutMs = 90000, interval = 800 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await probeDsh(port, host, 2500);
    if (r && r.dsh) return { ok: true, ms: Date.now() - start };
    await new Promise((res) => setTimeout(res, interval));
  }
  return { ok: false, ms: Date.now() - start };
}

/** Recursively kill a child process and its descendants. */
function killProcessTree(child) {
  if (!child || child.pid == null) return;
  try {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
    return;
  } catch {
    /* fall through to SIGTERM */
  }
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

/** Create a directory (recursively) if missing and return it. */
function ensureWorkspace(dir) {
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

// ---- Node.js detection + portable install --------------------------------

/** Run `node --version` and return the version string, or null if unusable. */
function detectNodeVersion(nodeBin) {
  try {
    const out = execFileSync(nodeBin, ["--version"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 15000,
    });
    const v = out.trim();
    return /^v?\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** True when a directory looks like a usable Node runtime (contains node.exe). */
function looksLikeNodeDir(dir) {
  return !!dir && fs.existsSync(path.join(dir, "node.exe"));
}

/** Stream a file over HTTPS to disk; onProgress(receivedBytes, totalBytes). */
function downloadFile(url, destPath, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const redirect = res.statusCode >= 300 && res.statusCode < 400 && res.headers.location;
      if (redirect) {
        res.resume();
        return downloadFile(new URL(redirect, url).href, destPath, { onProgress }).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`下载失败: HTTP ${res.statusCode} (${url})`));
      }
      const file = fs.createWriteStream(destPath);
      const total = Number(res.headers["content-length"]) || 0;
      let received = 0;
      res.on("data", (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve(destPath)));
      file.on("error", (err) => {
        file.destroy();
        reject(err);
      });
    });
    req.on("error", (err) => {
      reject(err);
    });
  });
}

/** Fetch the latest LTS version string from the Node.js release index. */
function fetchLatestLtsVersion() {
  return new Promise((resolve) => {
    const req = https.get("https://nodejs.org/dist/index.json", (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          const arr = JSON.parse(body);
          const lts = arr.find((x) => x.lts && x.files && x.files.includes("win-x64-zip"));
          resolve(lts ? lts.version : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
  });
}

/** Extract a .zip with Windows' built-in PowerShell Expand-Archive. */
function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const ps = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
  ];
  const r = spawnSync("powershell.exe", ps, { windowsHide: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`解压失败: ${(r.stderr || r.stdout || "").trim()}`);
}

/**
 * Download + install a portable (no-installer) Node.js into destRoot/node and
 * return the resulting node.exe path. `version` should be like "v22.12.0";
 * when omitted the latest LTS is resolved (with a pinned fallback).
 */
async function installPortableNode({ version, destRoot, onProgress }) {
  const resolvedVersion = version || (await fetchLatestLtsVersion()) || "v22.12.0";
  const zipName = `node-${resolvedVersion}-win-x64.zip`;
  const url = `https://nodejs.org/dist/${resolvedVersion}/${zipName}`;
  const zipPath = path.join(destRoot, zipName);
  fs.mkdirSync(destRoot, { recursive: true });

  if (onProgress) onProgress(0, 0, resolvedVersion, "download");
  await downloadFile(url, zipPath, { onProgress: (got, total) => onProgress(got, total, resolvedVersion, "download") });

  if (onProgress) onProgress(100, 100, resolvedVersion, "extract");
  const extractDir = path.join(destRoot, `.extract-${Date.now()}`);
  extractZip(zipPath, extractDir);

  const nodeDir = path.join(extractDir, `node-${resolvedVersion}-win-x64`);
  const exe = path.join(nodeDir, "node.exe");
  if (!fs.existsSync(exe)) throw new Error("解压后未找到 node.exe");

  const finalDir = path.join(destRoot, "node");
  try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.renameSync(nodeDir, finalDir);
  fs.rmSync(extractDir, { recursive: true, force: true });
  try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }

  return path.join(finalDir, "node.exe");
}

// ---- Plugin management ----------------------------------------------------

const PLUGINS = [
  "@linxin666/dsh-web-all",
  "dshmarket",
  "dsh-find-plugin",
  "dsh-cost-meter",
];
// 上游 0.3.4 起把聚合包从 @linxin666/dsh-web-ui-all 改名为 @linxin666/dsh-web-all
// （新版本只发新名）。新旧名都保留，用于一次性迁移 profile 里的依赖与 patch。
const WEB_UI_AGGREGATE = "@linxin666/dsh-web-all";
// 迁移版本：用于检测旧版本 profile，触发一次「升级重建 node_modules」。
// 旧 profile 的 node_modules 可能是 junction / 残缺 / 旧树，与新版不兼容，
// 升级后首次启动强制重建，避免 dsh 加载旧 profile 崩溃。
const PROFILE_MIGRATION_VERSION = 1;
const LEGACY_WEB_UI = "@linxin666/dsh-web-ui-all";

/**
 * Split a YAML array of loader patch entries into individual entry strings.
 * Each entry starts with a line matching /^- / and continues until the next
 * such line or the end of the document.  Comment-only lines (starting with #)
 * and blank lines before the first entry are discarded.
 */
function splitYamlEntries(raw) {
  const lines = raw.split("\n");
  const entries = [];
  let current = null;
  for (const line of lines) {
    if (/^- /.test(line)) {
      if (current !== null) entries.push(current.join("\n"));
      current = [line];
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) entries.push(current.join("\n"));
  return entries;
}

/**
 * Ensure the three plugins are installed into the web profile.
 * Reads the plugin's cordis.patch.yml from the bundled node_modules and
 * merges it into the profile's cordis.patch.yml, then adds the plugin as a
 * dependency of the profile's package.json – exactly what `dsh plugin add`
 * does. The profile gets its OWN real node_modules (installed via npm), NOT a
 * junction into the app's bundle: a junction makes pnpm writes (plugin-market
 * install/update) physically hit the bundled node_modules and fail the atomic
 * rename (e.g. lightningcss-win32-x64-msvc) — and would corrupt the app.
 */
function ensurePlugins({ dshHome, nodeBin, onLine, allowInstall = true }) {
  const profileDir = path.join(dshHome, "profiles", "web");
  const profilePkgPath = path.join(profileDir, "package.json");
  const profilePatchPath = path.join(profileDir, "cordis.patch.yml");
  if (!fs.existsSync(profilePkgPath)) {
    if (onLine) onLine("[plugin] web profile not found – skipping\n");
    return;
  }

  const bundledNodeModules = path.join(__dirname, "..", "node_modules");
  const profileNodeModules = path.join(profileDir, "node_modules");

  const profilePkg = JSON.parse(fs.readFileSync(profilePkgPath, "utf8"));
  const deps = profilePkg.dependencies || {};

  // Read the profile's current patches as YAML entries.
  let profileEntries = [];
  try {
    if (fs.existsSync(profilePatchPath)) {
      const raw = fs.readFileSync(profilePatchPath, "utf8");
      const trimmed = raw.trim();
      if (trimmed !== "[]" && trimmed !== "") {
        profileEntries = splitYamlEntries(trimmed);
      }
    }
  } catch { /* use empty */ }

  // Extract known `id` values from the profile entries (for duplicate checking).
  const knownIds = new Set();
  for (const entry of profileEntries) {
    const m = entry.match(/^\s*-\s+id:\s*(\S+)/m);
    if (m) knownIds.add(m[1]);
  }

  let changed = false;

  // 内置插件均为 bundle 型（package.json 声明 dsh.bundle.patch）：按 dsh 标准
  // 机制通过 dsh.profile.bundles 加载。插件市场按 bundles 判定启停状态（之前
  // 我们手动写 patch 并把这些插件移出 bundles → 插件市场显示「已停用」），且
  // bundle 层已提供 patch，若 profile patch 再写会重复（duplicate web-ui-compat）。
  // 这里保证 deps 与 dsh.profile.bundles 都包含内置插件。
  {
    const dshField = profilePkg.dsh || (profilePkg.dsh = {});
    const prof = dshField.profile || (dshField.profile = {});
    const bundles = Array.isArray(prof.bundles) ? prof.bundles : (prof.bundles = []);
    for (const pkg of PLUGINS) {
      if (!deps[pkg]) {
        deps[pkg] = "*";
        changed = true;
      }
      if (!bundles.includes(pkg)) {
        bundles.push(pkg);
        changed = true;
        if (onLine) onLine(`[plugin] ${pkg} 加入 dsh.profile.bundles\n`);
      }
    }
  }

  // 防御 2：清理 profile patch 里历史遗留的重复 id（如重复的 web-ui-compat），
  // 否则 cordis 加载器会报 "duplicate loader entry id" 导致 dsh web 启动崩溃。
  // 注意：必须区分「insert 块内的 - id:」与「顶层覆盖条目 - id: xxx + disabled:true」。
  // 0.3.6 的 web-ui-session-rdb 同时有 insert 块与 disabled 覆盖，二者语义不同，
  // 若混在一起按相同 id 去重，会吞掉 disabled 覆盖 → 服务被意外启用 → 崩溃。
  {
    const seen = new Set();       // insert 块的 id
    const coverSeen2 = new Set(); // 顶层覆盖条目的 id
    const deduped = [];
    for (const entry of profileEntries) {
      const firstLine = entry.split("\n")[0];
      if (/^- id:/.test(firstLine)) {
        // 顶层覆盖条目：按 id 单独去重（保留第一个），不与 insert 块混淆。
        const cm = firstLine.match(/^- id:\s*(\S+)/);
        const cid = cm ? cm[1] : firstLine.trim();
        if (coverSeen2.has(cid)) {
          changed = true;
          continue;
        }
        coverSeen2.add(cid);
      } else {
        // insert 块：按 id 去重。
        const m = entry.match(/^\s*-\s+id:\s*(\S+)/m);
        const key = m ? m[1] : entry;
        if (seen.has(key)) {
          changed = true;
          continue;
        }
        seen.add(key);
      }
      deduped.push(entry);
    }
    if (deduped.length !== profileEntries.length) profileEntries = deduped;
  }

  // 一次性迁移：profile 里已有的 web-ui-compat patch 条目仍指向旧聚合包名，
  // 若旧名包随依赖迁移从 node_modules 移除，该条目会解析失败——原位改写为新名
  // （id 不变，knownIds 去重不受影响）。
  let migratedPatch = false;
  profileEntries = profileEntries.map((entry) => {
    const m = entry.match(/^\s*-\s+id:\s*(\S+)/m);
    if (m && m[1] === "web-ui-compat" && entry.includes(`name: '${LEGACY_WEB_UI}'`)) {
      migratedPatch = true;
      return entry.replace(LEGACY_WEB_UI, WEB_UI_AGGREGATE);
    }
    return entry;
  });
  if (migratedPatch) changed = true;

  if (deps[LEGACY_WEB_UI] && !deps[WEB_UI_AGGREGATE]) {
    delete deps[LEGACY_WEB_UI];
    changed = true;
    if (onLine) onLine(`[plugin] migrated ${LEGACY_WEB_UI} → ${WEB_UI_AGGREGATE}\n`);
  }

  // 不要往 profile dependencies 加 @deepseek-ai/cordis：cordis 不是插件（无
  // dsh.bundle），作为直接依赖会被插件市场显示为「已安装未生效」，并且会
  // 阻碍 dsh-web-all 等内置插件的 pnpm update。cordis 由官方 bundles
  // （@deepseek-ai/dsh-base / dsh-web-app）作为依赖自然带入依赖树，插件
  // 运行时从树中解析即可。这里同时迁移移除历史误加的条目。
  if (deps["@deepseek-ai/cordis"]) {
    delete deps["@deepseek-ai/cordis"];
    changed = true;
    if (onLine) onLine("[plugin] removed @deepseek-ai/cordis from profile dependencies\n");
  }

  // 内置插件由 dsh.profile.bundles 加载（bundle 机制），不再写入 profile patch。
  // 这里仅收集它们 patch 的 id 集合（用于清理 profile patch 中的旧手动条目，
  // 避免 bundle 层 + patch 层重复声明导致 duplicate loader entry id）与引用
  // 集合（用于残留判定）。
  const builtinIds = new Set();
  const currentRefs = new Set(); // 内置插件 patch 引用的包名集合
  for (const pkg of PLUGINS) {
    const pluginDir =
      [path.join(profileNodeModules, ...pkg.split("/")), path.join(__dirname, "..", "node_modules", ...pkg.split("/"))]
        .find((p) => fs.existsSync(path.join(p, "cordis.patch.yml")));
    if (!pluginDir) continue;
    const pluginRaw = fs.readFileSync(path.join(pluginDir, "cordis.patch.yml"), "utf8").trim();
    for (const entry of splitYamlEntries(pluginRaw)) {
      const m = entry.match(/^\s*-\s+id:\s*(\S+)/m);
      if (m) builtinIds.add(m[1]);
      const mr = entry.match(/name:\s*['"]([^'"]+)['"]/);
      if (mr) currentRefs.add(mr[1]);
    }
  }

  // 清理 profile patch 中由内置插件产生的旧条目（改由 bundle 层加载，避免重复）。
  {
    const before = profileEntries.length;
    profileEntries = profileEntries.filter((entry) => {
      const m = entry.match(/^\s*-\s+id:\s*(\S+)/m);
      return !(m && builtinIds.has(m[1]));
    });
    if (profileEntries.length !== before) {
      changed = true;
      if (onLine) onLine(`[plugin] 清理 ${before - profileEntries.length} 条内置插件 patch 条目（改由 bundles 加载）\n`);
    }
  }

  // patch 引用清理与补齐：
  //  - 条目引用的包在 node_modules 缺失时：
  //      · 该包在当前插件 patch 里仍被需要 → 保留条目，注入 deps 让 pnpm 装齐；
  //      · 该包已不被任何插件引用（旧版 patch 残留，如 0.3.4 的 chat-recovery）
  //        → 从 profile patch 移除该残留条目（绝不补装无用的旧包）。
  let forceRebuildFromPatch = false;
  if (fs.existsSync(profileNodeModules) && !isJunction(profileNodeModules)) {
    const refs = new Set();
    for (const entry of profileEntries) {
      const m = entry.match(/name:\s*['"]([^'"]+)['"]/);
      if (m) refs.add(m[1]);
    }
    const missing = [];
    for (const name of refs) {
      if (!fs.existsSync(path.join(profileNodeModules, ...name.split("/"), "package.json"))) missing.push(name);
    }
    if (missing.length > 0) {
      let removedRefs = 0;
      for (const name of missing) {
        if (currentRefs.has(name)) {
          // 插件当前需要但 node_modules 缺 → 注入 deps 装齐。
          if (!deps[name]) {
            deps[name] = "*";
            changed = true;
          }
          forceRebuildFromPatch = true;
        } else {
          // 残留引用（插件新版本已移除该包）→ 移除对应 patch 条目。
          const before = profileEntries.length;
          profileEntries = profileEntries.filter((entry) => {
            const m = entry.match(/name:\s*['"]([^'"]+)['"]/);
            return !(m && m[1] === name);
          });
          removedRefs += before - profileEntries.length;
        }
      }
      if (removedRefs > 0) {
        changed = true;
        if (onLine) onLine(`[plugin] 移除 ${removedRefs} 条残留 patch 条目（引用已不再需要的包）\n`);
      }
      if (forceRebuildFromPatch) {
        if (onLine) onLine(`[plugin] patch 需要 ${missing.filter((n) => currentRefs.has(n)).join(", ")}，注入 deps 并重建…\n`);
      }
    }
  }

  if (changed) {
    // Write back profile patches as valid YAML.
    const yaml = profileEntries.length === 0 ? "[]\n" : profileEntries.join("\n") + "\n";
    fs.writeFileSync(profilePatchPath, yaml, "utf8");

    // Write back profile package.json.
    profilePkg.dependencies = deps;
    fs.writeFileSync(profilePkgPath, JSON.stringify(profilePkg, null, 2) + "\n", "utf8");
    if (onLine) onLine("[plugin] profile updated\n");
  }

  // 升级迁移：旧版本（无迁移标记）profile 的 node_modules 可能是 junction/残缺/旧树，
  // 强制重建一次（移除旧树，重新 pnpm 安装），否则新版 dsh 加载旧 profile 会崩溃
  // （如 duplicate web-ui-compat、bundles 误加、commander 被降级等）。
  const migrationMark = path.join(profileDir, ".desktop-migrated");
  const needsMigration = !fs.existsSync(migrationMark);
  if (needsMigration && onLine) onLine("[plugin] 检测到旧 profile，执行升级迁移…\n");
  // 无论 deps/patch 是否变化，都确保 profile 的 node_modules 是真实目录（去掉 junction）；
  // 升级迁移或 patch 引用缺失时强制重建。
  ensureProfileNodeModules({
    nodeBin,
    profileDir,
    bundledNodeModules,
    profileNodeModules,
    onLine,
    allowInstall,
    forceRebuild: needsMigration || forceRebuildFromPatch,
  });
  // 迁移完成标记（避免每次启动都重建）。
  if (fs.existsSync(profileNodeModules)) {
    try {
      fs.writeFileSync(migrationMark, String(PROFILE_MIGRATION_VERSION), "utf8");
    } catch { /* ignore */ }
  }
}

/** 判断路径是否为符号链接 / junction。 */
function isJunction(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 在 profile 目录执行 npm install，生成真实（非 junction）node_modules。 */
function npmInstallProfile(nodeBin, profileDir, onLine) {
  // Windows 上不能直接 spawn .cmd（CreateProcess 只认可执行文件），
  // 这里直接用 node 运行 npm-cli.js，跨 shell、最稳。
  const npmCli = path.join(path.dirname(nodeBin), "node_modules", "npm", "bin", "npm-cli.js");
  if (!fs.existsSync(npmCli)) {
    if (onLine) onLine(`[plugin] npm-cli.js not found next to node: ${npmCli}\n`);
    return false;
  }
  if (onLine) onLine("[plugin] installing profile plugins via npm…\n");
  try {
    const r = spawnSync(nodeBin, [npmCli, "install", "--no-audit", "--no-fund", "--legacy-peer-deps"], {
      cwd: profileDir,
      encoding: "utf8",
      windowsHide: true,
      timeout: 300000,
    });
    if (r.status === 0) {
      if (onLine) onLine("[plugin] profile node_modules installed via npm\n");
      return true;
    }
    if (onLine) onLine(`[plugin] npm install failed (${r.status}): ${(r.stderr || r.stdout || "").slice(0, 600)}\n`);
  } catch (err) {
    if (onLine) onLine(`[plugin] npm install error: ${err.message}\n`);
  }
  return false;
}

/** 在 profile 目录执行 pnpm install（经内置 Node 自带的 corepack）。 */
function pnpmInstallProfile(nodeBin, profileDir, onLine, force = false) {
  const corepackJs = path.join(path.dirname(nodeBin), "node_modules", "corepack", "dist", "corepack.js");
  if (!fs.existsSync(corepackJs)) {
    if (onLine) onLine(`[plugin] corepack.js not found next to node: ${corepackJs}\n`);
    return false;
  }
  if (onLine) onLine(force ? "[plugin] repairing profile plugins via pnpm --force…\n" : "[plugin] installing profile plugins via pnpm (corepack)…\n");
  try {
    // --ignore-scripts：pnpm 11 默认把 native 包的构建脚本作为错误
    // （ERR_PNPM_IGNORED_BUILDS，如 cloudflared/node-pty/ssh2），而这些包都带
    // 预编译二进制，跳过脚本即可使用。
    // --force：patch 引用缺失时强制重链整棵依赖树（从 store 硬链接，补齐被删的包）。
    const args = ["pnpm", "install", "--no-frozen-lockfile", "--ignore-scripts"];
    if (force) args.push("--force");
    const r = spawnSync(nodeBin, [corepackJs, ...args], {
      cwd: profileDir,
      encoding: "utf8",
      windowsHide: true,
      timeout: 420000,
    });
    if (r.status === 0) {
      if (onLine) onLine("[plugin] profile node_modules installed via pnpm\n");
      return true;
    }
    if (onLine) onLine(`[plugin] pnpm install failed (${r.status}): ${(r.stderr || r.stdout || "").slice(0, 600)}\n`);
  } catch (err) {
    if (onLine) onLine(`[plugin] pnpm install error: ${err.message}\n`);
  }
  return false;
}

/** 安装 profile 依赖：在线模式优先 pnpm（profile 是 pnpm 生态，插件市场用 pnpm 管树），
 *  失败回退 npm；offline 模式（allowInstall=false）不联网，直接用应用内置复制；
 *  都走不通再复制闭包兜底。绝不用 junction。 */
function installProfileDeps(nodeBin, profileDir, bundledNodeModules, profileNodeModules, onLine, allowInstall, repair = false) {
  let installed = false;
  if (allowInstall && nodeBin) {
    if (pnpmInstallProfile(nodeBin, profileDir, onLine, repair)) installed = true;
    else if (npmInstallProfile(nodeBin, profileDir, onLine)) installed = true;
  }
  if (!installed) {
    // 本地离线复制（offline 模式 / 包管理器不可用）：从应用捆绑目录复制插件闭包，
    // 生成独立真实目录，保证内置插件可用（插件市场受限但可跑）。
    try {
      if (fs.existsSync(profileNodeModules)) fs.rmSync(profileNodeModules, { recursive: true, force: true });
    } catch { /* ignore */ }
    if (!fs.existsSync(profileNodeModules)) copyPluginClosure(bundledNodeModules, profileNodeModules, onLine);
  }
  return fs.existsSync(profileNodeModules);
}

/**
 * 确保 profile 的 node_modules 是真实目录而非 junction。
 * junction 会让 pnpm（插件市场安装/更新）把写入落到桌面应用捆绑 node_modules，
 * 破坏应用自身依赖（例如把 commander 从 15 降级导致 dsh 启动崩溃）。因此一律
 * 使用真实目录：优先 pnpm（corepack）安装（pnpm 管理的树才能让插件市场的
 * pnpm 操作无冲突），失败回退 npm / 复制闭包。
 */
function ensureProfileNodeModules({ nodeBin, profileDir, bundledNodeModules, profileNodeModules, onLine, allowInstall = true, forceRebuild = false }) {
  let repair = false;
  if (isJunction(profileNodeModules)) {
    try {
      fs.rmSync(profileNodeModules, { recursive: true, force: true });
    } catch (err) {
      if (onLine) onLine(`[plugin] remove junction error: ${err.message}\n`);
    }
    if (onLine) onLine("[plugin] removed legacy node_modules junction\n");
  }
  if (fs.existsSync(profileNodeModules) && !isJunction(profileNodeModules)) {
    if (forceRebuild) {
      // 升级迁移：旧树可能是 junction 时代的残缺/copy/旧 pnpm 树，整体移除后重建。
      try {
        fs.rmSync(profileNodeModules, { recursive: true, force: true });
      } catch (err) {
        if (onLine) onLine(`[plugin] remove old node_modules error: ${err.message}\n`);
      }
      if (onLine) onLine("[plugin] 升级迁移：重建 node_modules\n");
    } else {
      try {
        if (fs.readdirSync(profileNodeModules).length > 0) {
          // 已有树：校验 patch 引用完整性。插件（如 dsh-web-all）更新会改变
          // cordis.patch.yml 并新增子包引用，但 node_modules 未必同步。
          // 注意：不能只复制单个缺失子包——client 端 bundle（client.js）依赖
          // dsh-web-all 更新后的完整 client 构建，单包复制无法匹配，必须整树
          // 重建让 pnpm 正确安装 dsh-web-all 及全部子依赖与 client。
          const missing = missingPatchRefs(profileDir, profileNodeModules);
          if (missing.length === 0) return;
          repair = true;
          if (onLine) onLine(`[plugin] patch 引用缺失 ${missing.length} 个：${missing.join(", ")}，重建 node_modules…\n`);
          try {
            fs.rmSync(profileNodeModules, { recursive: true, force: true });
          } catch (err) {
            if (onLine) onLine(`[plugin] remove incomplete node_modules error: ${err.message}\n`);
          }
        }
      } catch {
        return;
      }
    }
  }
  installProfileDeps(nodeBin, profileDir, bundledNodeModules, profileNodeModules, onLine, allowInstall, repair);
}

/**
 * 返回 profile 的 cordis.patch.yml 引用但在 node_modules 中缺失的包名列表。
 */
function missingPatchRefs(profileDir, profileNodeModules) {
  const missing = [];
  try {
    const patchPath = path.join(profileDir, "cordis.patch.yml");
    if (!fs.existsSync(patchPath)) return missing;
    const raw = fs.readFileSync(patchPath, "utf8");
    const refs = new Set();
    const re = /name:\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(raw)) !== null) refs.add(m[1]);
    for (const name of refs) {
      if (!fs.existsSync(path.join(profileNodeModules, ...name.split("/"), "package.json"))) missing.push(name);
    }
  } catch { /* ignore */ }
  return missing;
}

/**
 * 从应用捆绑目录复制内置插件及其依赖闭包到 profile 的真实 node_modules。
 * 用于 npm 安装不可用/失败时的离线兜底 —— 生成独立可写的 node_modules，
 * 避免 junction 导致的 pnpm 写穿破坏应用自身依赖。
 */
function copyPluginClosure(bundledNodeModules, profileNodeModules, onLine) {
  try {
    const queue = [...PLUGINS];
    const seen = new Set();
    fs.mkdirSync(profileNodeModules, { recursive: true });
    while (queue.length > 0) {
      const name = queue.shift();
      if (seen.has(name)) continue;
      seen.add(name);
      const src = path.join(bundledNodeModules, ...name.split("/"));
      const pkgJson = path.join(src, "package.json");
      if (!fs.existsSync(pkgJson)) {
        if (onLine) onLine(`[plugin] copy: missing ${name}\n`);
        continue;
      }
      let deps = {};
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
        // 必须包含 optionalDependencies：原生二进制（如 lightningcss-win32-x64-msvc
        // 的 .node 文件）通过 optional 依赖声明，漏掉会导致加载失败。
        deps = {
          ...(pkg.dependencies || {}),
          ...(pkg.peerDependencies || {}),
          ...(pkg.optionalDependencies || {}),
        };
      } catch { /* ignore */ }
      for (const d of Object.keys(deps)) {
        if (!seen.has(d)) queue.push(d);
      }
      const dst = path.join(profileNodeModules, ...name.split("/"));
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.cpSync(src, dst, { recursive: true });
    }
    if (onLine) onLine(`[plugin] copied ${seen.size} plugin packages to profile node_modules\n`);
    return true;
  } catch (err) {
    if (onLine) onLine(`[plugin] copy plugin closure failed: ${err.message}\n`);
    return false;
  }
}

// ---- DSH core update -----------------------------------------------------

/** Current dsh version bundled in the app. */
function currentDshVersion() {
  const pkgPath = path.join(__dirname, "..", "node_modules", "@deepseek-ai", "dsh", "package.json");
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
  } catch { return null; }
}

/** Check npm registry for the latest version of @deepseek-ai/dsh. */
function fetchLatestDshVersion() {
  return new Promise((resolve) => {
    const req = https.get("https://registry.npmjs.org/@deepseek-ai/dsh/latest", (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body).version);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
  });
}

/**
 * Fetch a specific dsh version's dist metadata (tarball URL + sha512 integrity)
 * from the npm registry. Returns null when the version is missing/unreachable.
 */
function fetchDshDist(version) {
  return new Promise((resolve) => {
    const url = `https://registry.npmjs.org/@deepseek-ai/dsh/${encodeURIComponent(version)}`;
    const req = https.get(url, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const json = JSON.parse(body);
          const dist = (json && json.dist) || {};
          resolve({
            version: json.version || version,
            tarball: dist.tarball || null,
            integrity: dist.integrity || null,
            shasum: dist.shasum || null,
          });
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
  });
}

/**
 * Verify a downloaded file against an npm-style "sha512-<base64>" integrity
 * value. Returns true only on an exact match.
 */
function verifySha512(filePath, integrity) {
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity || "");
  if (!m) return false;
  try {
    const actual = crypto.createHash("sha512").update(fs.readFileSync(filePath)).digest("base64");
    return actual === m[1];
  } catch {
    return false;
  }
}

/**
 * Download a newer @deepseek-ai/dsh tarball, verify its integrity against the
 * registry-provided sha512, then replace the bundled copy.
 * Returns the new version string on success.
 */
async function updateDshCore({ version, destRoot, onProgress, integrity }) {
  const tarballUrl = `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz`;
  const tgzPath = path.join(destRoot, "dsh.tgz");
  fs.mkdirSync(destRoot, { recursive: true });

  if (onProgress) onProgress(0, 0, version, "download");
  await downloadFile(tarballUrl, tgzPath, { onProgress: (got, total) => onProgress(got, total, version, "download") });

  // 完整性闸门：sha512 与 registry 发布值不一致时绝不解包/替换。
  if (onProgress) onProgress(100, 100, version, "verify");
  if (!integrity) {
    fs.rmSync(tgzPath, { force: true });
    throw new Error("缺少完整性校验信息（registry 未返回 sha512），已中止更新");
  }
  if (!verifySha512(tgzPath, integrity)) {
    fs.rmSync(tgzPath, { force: true });
    throw new Error("完整性校验失败（sha512 不匹配），已中止更新");
  }

  if (onProgress) onProgress(100, 100, version, "extract");
  const extractDir = path.join(destRoot, `dsh-${Date.now()}`);
  fs.mkdirSync(extractDir, { recursive: true });

  // Extract the tgz with tar (Windows 10+ has built-in tar).
  const r = spawnSync("tar.exe", ["-xzf", tgzPath, "-C", extractDir], { windowsHide: true, encoding: "utf8" });
  if (r.status !== 0) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(tgzPath, { force: true });
    throw new Error(`解压失败: ${(r.stderr || r.stdout || "").trim()}`);
  }

  // npm tarball extracts to package/ directory.
  const extractedPkg = path.join(extractDir, "package");
  if (!fs.existsSync(path.join(extractedPkg, "package.json"))) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(tgzPath, { force: true });
    throw new Error("解压后未找到 package.json");
  }

  // Replace the bundled node_modules/@deepseek-ai/dsh.
  const targetDir = path.join(__dirname, "..", "node_modules", "@deepseek-ai", "dsh");
  try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.renameSync(extractedPkg, targetDir);

  // Cleanup.
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.rmSync(tgzPath, { force: true });

  const newVersion = JSON.parse(fs.readFileSync(path.join(targetDir, "package.json"), "utf8")).version;
  return newVersion;
}

module.exports = {
  DSH_HTML_MARKER,
  resolveNodeBin,
  resolveDshBin,
  npxCacheCandidates,
  isPortBusy,
  findFreePort,
  probeDsh,
  resolvePort,
  spawnServer,
  attachLogging,
  waitForDsh,
  killProcessTree,
  ensureWorkspace,
  detectNodeVersion,
  looksLikeNodeDir,
  installPortableNode,
  ensurePlugins,
  currentDshVersion,
  fetchLatestDshVersion,
  fetchDshDist,
  verifySha512,
  updateDshCore,
};
