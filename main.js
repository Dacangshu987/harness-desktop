"use strict";

/*
 * main.js — Electron main process for the DeepSeek Harness desktop client.
 *
 * Startup sequence:
 *   1. Resolve a system Node binary and the `dsh` CLI (lib/dsh-server.js).
 *   2. Decide the port: attach to an existing DSH server on the preferred
 *      port when one is present, else spawn our own `dsh web` child.
 *   3. Wait until the DSH index page is served, then open the BrowserWindow.
 *
 * The server always runs as a child of *system node* (never in-process), so the
 * packaged app only needs Node installed — no native modules are rebuilt for
 * Electron (electron-builder is configured with npmRebuild: false / asar: false).
 */

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  shell,
  dialog,
} = require("electron");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const dsh = require("./lib/dsh-server");

const IS_DEV = process.env.DSH_CLIENT_DEV === "1" || process.argv.includes("--dev");

// ---- persistent config + logging -------------------------------------------

function defaultConfig() {
  return {
    port: 3080,
    host: "127.0.0.1",
    workspace: null,
    dshHome: null,
    dshBin: null,
    nodeBin: null,
    minimizeToTray: true,
    installPlugins: null, // null = 未决定（首次运行询问）；true/false = 用户选择
    autoLaunch: false,    // 开机自启（打包环境写入 Windows 登录项）
  };
}

function configPath() {
  // userData 目录由 package.json 的 productName 决定（"DeepSeek Harness
  // Desktop"），且在下文第一次调用 getPath("userData") 时固定。如需改名，
  // 必须在任何 getPath 调用之前设置 app.name —— 见 whenReady 中的注释。
  return path.join(app.getPath("userData"), "config.json");
}

function readConfig() {
  try {
    // Trim a leading BOM (e.g. after editing config.json in Notepad) so JSON.parse doesn't reject it.
    const raw = fs.readFileSync(configPath(), "utf8").replace(/^\uFEFF/, "");
    return { ...defaultConfig(), ...JSON.parse(raw) };
  } catch {
    return defaultConfig();
  }
}

function writeConfig(cfg) {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf8");
  } catch {
    /* best-effort persistence */
  }
}

/**
 * Consume the choice made by the NSIS installer wizard page (written to
 * plugin-choice.json next to the exe, before install completes). Returns
 * true/false, or null when no installer choice exists (portable / dev run).
 * The file is one-shot and is deleted after being consumed.
 */
function consumeInstallerPluginChoice() {
  try {
    const p = path.join(path.dirname(process.execPath), "plugin-choice.json");
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    if (typeof parsed.installPlugins !== "boolean") return null;
    try {
      fs.unlinkSync(p); // per-machine installs may be read-only; tolerated
    } catch {
      /* ignore */
    }
    return parsed.installPlugins;
  } catch {
    return null;
  }
}

let logStream = null;
function log(line) {
  try {
    if (logStream && !logStream.destroyed) logStream.write(`${new Date().toISOString()} ${line}`);
  } catch {
    /* ignore */
  }
  if (IS_DEV) process.stdout.write(line);
}

// ---- session state ----------------------------------------------------------

let mainWindow = null;
let tray = null;
let serverProc = null; // child process when we own the server
let serverPort = null;
let serverReused = false; // true when attaching to an existing DSH server
let shuttingDown = false;
let nodeState = { bin: null, version: null }; // resolved Node runtime
let progressWin = null; // transient install progress window
let updatingCore = false; // true while a dsh core update replaces the bundled runtime
let restartingFirstBoot = false; // true while auto-restarting once to load first-run plugins

function nodeCacheDir() {
  return path.join(app.getPath("userData"), "node");
}

function findCachedNode() {
  const p = path.join(nodeCacheDir(), "node.exe");
  return fs.existsSync(p) ? p : null;
}

function createLogStream() {
  const dir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(dir, { recursive: true });
  logStream = fs.createWriteStream(path.join(dir, "server.log"), { flags: "a" });
}

// ---- server lifecycle -------------------------------------------------------

async function bootServer(cfg) {
  const host = cfg.host || "127.0.0.1";
  const preferred = Number(cfg.port) || 3080;

  // 1. Resolve tools — make sure we have a usable Node (detect, else prompt to
  //    auto-install a portable runtime or pick node.exe), then the dsh CLI.
  let node = detectNode(cfg);
  if (!node) node = await promptAndInstallNode(cfg);
  if (!node) {
    log(`[boot] no Node.js available — quitting\n`);
    app.quit();
    return null;
  }
  nodeState = node;
  const nodeBin = node.bin;
  const dshBin = dsh.resolveDshBin({ dshBin: cfg.dshBin });
  if (!dshBin) {
    dialog.showErrorBox(
      "未找到 dsh",
      "找不到 @deepseek-ai/dsh 的 bin.js。\n请确认已安装依赖，或设置 DSH_CLIENT_DSH_BIN 环境变量。"
    );
    return null;
  }

  // 2. Bundled plugins are optional. The NSIS installer asks on a wizard page
  //    BEFORE the app is installed and drops the choice into plugin-choice.json
  //    next to the exe; portable/dev builds have no installer, so we fall back
  //    to a one-time first-run dialog. 没有菜单开关（按设计移除）。
  const dshHome = cfg.dshHome || process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  // 记录本次启动前 profile 是否已存在：首次全新启动时 profile 由 dsh web 本次创建，
  // 插件只能在 post-ready 后安装 → 需要自动重启一次才能加载（见下方首次重启逻辑）。
  const profileExisted = fs.existsSync(path.join(dshHome, "profiles", "web", "package.json"));
  let installPlugins = cfg.installPlugins;
  if (installPlugins == null) {
    const installerChoice = consumeInstallerPluginChoice();
    if (installerChoice != null) {
      // 安装向导已在前（正式安装完成之前）替用户决定，直接采纳并固化到配置。
      installPlugins = installerChoice;
      cfg.installPlugins = installPlugins;
      writeConfig(cfg);
      log(`[plugins] installer choice: installPlugins=${installPlugins}\n`);
    } else {
      const opts = {
        type: "question",
        title: "安装内置插件",
        message: "是否安装客户端内置的插件？",
        detail: [
          "包含：Web UI 功能全家桶（@linxin666/dsh-web-all）、插件市场（dshmarket）、插件搜索（dsh-find-plugin）。",
          "安装版客户端在安装向导中勾选；此为便携版 / 开发模式的首次运行询问。跳过不会影响已安装的插件。",
        ].join("\n"),
        buttons: ["安装（推荐）", "跳过"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      };
      const { response } =
        mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showMessageBox(mainWindow, opts)
          : await dialog.showMessageBox(opts);
      installPlugins = response === 0;
      cfg.installPlugins = installPlugins;
      writeConfig(cfg);
    }
  }
  if (installPlugins !== false) {
    try {
      dsh.ensurePlugins({ dshHome, nodeBin, onLine: log });
    } catch (err) {
      log(`[plugins] error: ${err.message}\n`);
    }
  }

  // 3. Decide port / attach.
  const { port, reused } = await dsh.resolvePort(preferred, { host });
  log(`[boot] node=${nodeBin}\n[boot] dsh=${dshBin}\n[boot] port=${port} reused=${reused}\n`);

  if (reused) {
    // Someone already serves DSH on this port — attach, don't spawn.
    serverProc = null;
    serverReused = true;
    return { port, reused: true };
  }

  // 3. Spawn and wait.
  const workspace =
    cfg.workspace || path.join(app.getPath("documents"), "DSH Workspace");
  const ensuredWorkspace = dsh.ensureWorkspace(workspace) || workspace;

  serverProc = dsh.spawnServer({
    nodeBin,
    dshBin,
    port,
    host,
    workspace: ensuredWorkspace,
    dshHome: cfg.dshHome,
  });
  dsh.attachLogging(serverProc, { onLine: log });

  serverProc.on("exit", (code, signal) => {
    log(`[server] exited code=${code} signal=${signal}\n`);
    if (shuttingDown || updatingCore || restartingFirstBoot) {
      serverProc = null;
      return;
    }
    serverProc = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "DSH 服务已退出",
        message: "dsh web 服务意外停止，是否重新启动？",
        buttons: ["重新启动", "关闭窗口"],
        defaultId: 0,
        cancelId: 1,
      }).then(({ response }) => {
        if (response === 0) restartServer(cfg);
        else mainWindow.close();
      });
    }
  });

  const ready = await dsh.waitForDsh(port, { host });
  if (!ready.ok) {
    log(`[boot] server did not become ready in time\n`);
    dialog.showErrorBox(
      "DSH 服务启动失败",
      `无法在 ${port} 端口等到 dsh web 就绪。请查看日志目录。`
    );
    return { port, reused: false, ready: false };
  }
  log(`[boot] ready after ${ready.ms}ms\n`);
  // 重新执行一次插件注入：全新机器上 web profile 是 dsh web 本次启动时才
  // 创建的，此前（spawn 前）的 ensurePlugins 因 profile 不存在而被跳过。
  // 该函数幂等；ensureProfileNodeModules 只在 node_modules 缺失/为空时安装，
  // 服务已运行且目录有内容时不会重装（避免文件占用冲突）。
  if (installPlugins !== false) {
    try {
      dsh.ensurePlugins({ dshHome, nodeBin, onLine: log });
    } catch (err) {
      log(`[plugins] re-check error: ${err.message}\n`);
    }
  }

  // 首次全新启动：本次启动时 profile 才被 dsh 创建，插件刚由上面的
  // ensurePlugins 安装，但当前 dsh 进程不会热加载它们——第一次打开的窗口
  // 会是无插件状态。因此首次装完插件后自动重启服务一次（进程内完成，
  // 第二次启动时 profile/插件已就绪，直接加载插件且不再重启）。
  if (installPlugins !== false && !profileExisted && !serverReused) {
    log("[boot] first run detected – restarting once to load freshly installed plugins\n");
    const oldProc = serverProc;
    restartingFirstBoot = true;
    dsh.killProcessTree(oldProc);
    serverProc = null;
    // 等旧进程的 exit 事件先触发（此时 restartingFirstBoot=true → 不弹"服务已退出"），
    // 再递归重启，避免竞态。
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 3000);
      if (oldProc) oldProc.once("exit", () => { clearTimeout(t); resolve(); });
      else resolve();
    });
    restartingFirstBoot = false;
    return await bootServer(cfg);
  }
  return { port, reused: false, ready: true };
}

async function restartServer(cfg) {
  if (serverProc) dsh.killProcessTree(serverProc);
  serverProc = null;
  serverReused = false;
  const result = await bootServer(cfg);
  if (result && mainWindow && !mainWindow.isDestroyed() && result.port) {
    loadUrl(mainWindow, result.port);
  }
}

/** 配置变更后的引导：询问是否立即重启服务使其生效。 */
async function promptRestartService(reason) {
  const opts = {
    type: "info",
    title: "配置已更改",
    message: reason,
    detail: "重启 DSH 服务后生效。",
    buttons: ["立即重启", "稍后"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const { response } =
    mainWindow && !mainWindow.isDestroyed()
      ? await dialog.showMessageBox(mainWindow, opts)
      : await dialog.showMessageBox(opts);
  if (response === 0) await restartServer(readConfig());
}

function loadUrl(win, port) {
  const url = `http://127.0.0.1:${port}/`;
  win.loadURL(url).catch((err) => log(`[window] load error: ${err}\n`));
}

// ---- Node.js detection + install/selection --------------------------------

/**
 * Resolve the portable Node bundled with the app (resources/app/node), or the
 * dev-checkout copy (./node) — so the app can run dsh without a system Node.
 */
function bundledNodeBin() {
  try {
    if (process.resourcesPath) {
      const p = path.join(process.resourcesPath, "app", "node", "node.exe");
      if (fs.existsSync(p)) return p;
    }
    const dev = path.join(__dirname, "..", "node", "node.exe");
    return fs.existsSync(dev) ? dev : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a usable Node runtime. Priority:
 *   config.nodeBin → DSH_CLIENT_NODE → bundled (app-shipped) Node → portable
 *   cache → system PATH.
 * Returns { bin, version } or null when nothing usable is found.
 */
function detectNode(cfg) {
  const candidates = [cfg.nodeBin, process.env.DSH_CLIENT_NODE, bundledNodeBin(), findCachedNode()].filter(Boolean);
  for (const c of candidates) {
    if (c && fs.existsSync(c)) {
      const v = dsh.detectNodeVersion(c);
      if (v) return { bin: c, version: v };
    }
  }
  const sys = dsh.resolveNodeBin({ allowSelf: false });
  if (sys && fs.existsSync(sys)) {
    const v = dsh.detectNodeVersion(sys);
    if (v) return { bin: sys, version: v };
  }
  return null;
}

function openProgressWindow(title) {
  progressWin = new BrowserWindow({
    width: 470,
    height: 150,
    resizable: false,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: "#0f1720",
    webPreferences: {
      preload: path.join(__dirname, "progress-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const html = `<!doctype html><html><body style="margin:16px;font-family:'Segoe UI',sans-serif;background:#0f1720;color:#e2e8f0">
    <div style="font-size:13px;margin-bottom:10px">${title}</div>
    <div style="height:8px;background:#1e293b;border-radius:4px;overflow:hidden"><div id="bar" style="height:100%;width:0;background:#3b82f6;transition:width .2s"></div></div>
    <div style="font-size:12px;color:#94a3b8;margin-top:8px" id="pct">准备中…</div>
  </body></html>`;
  progressWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

function setProgress(status) {
  if (!progressWin || progressWin.isDestroyed()) return;
  progressWin.webContents.send("prog", { pct: status.percent ?? 0, status: status.text || "" });
}

function closeProgress() {
  if (progressWin && !progressWin.isDestroyed()) progressWin.close();
  progressWin = null;
}

/** Auto-download a portable Node.js into userData/node and return {bin}. */
async function autoInstallNode() {
  openProgressWindow("正在下载并安装 Node.js（便携版，无需管理员权限）…");
  try {
    const nodeBin = await dsh.installPortableNode({
      destRoot: nodeCacheDir(),
      onProgress: (got, total, ver, phase) => {
        if (phase === "download") {
          const percent = total ? Math.min(100, Math.round((got / total) * 100)) : 0;
          setProgress({ percent, text: `下载中 ${ver} … ${percent}%` });
        } else {
          setProgress({ percent: 100, text: "解压中…" });
        }
      },
    });
    closeProgress();
    return { bin: nodeBin, version: dsh.detectNodeVersion(nodeBin) };
  } catch (err) {
    closeProgress();
    dialog.showErrorBox("Node.js 安装失败", `自动下载安装失败：\n${err.message}`);
    return null;
  }
}

/** Ask the user how to obtain a Node runtime (auto-install / pick / quit). */
async function promptAndInstallNode(cfg) {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "需要 Node.js",
    message: "本客户端需要 Node.js 才能运行 dsh 服务。",
    detail: "你的系统未检测到可用的 Node.js。请选择如何提供：",
    buttons: ["自动下载安装（推荐）", "选择已有的 node.exe", "退出"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });

  if (response === 0) {
    const res = await autoInstallNode();
    if (res && res.bin) {
      cfg.nodeBin = res.bin;
      writeConfig(cfg);
    }
    return res;
  }
  if (response === 1) {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: "选择 node.exe",
      filters: [{ name: "node.exe", extensions: ["exe"] }],
      properties: ["openFile"],
    });
    const p = filePaths && filePaths[0];
    if (!canceled && p && /node\.exe$/i.test(p)) {
      const v = dsh.detectNodeVersion(p);
      if (!v) {
        dialog.showErrorBox("无效的 node.exe", "所选文件无法作为 Node.js 运行时使用。");
        return null;
      }
      cfg.nodeBin = p;
      writeConfig(cfg);
      return { bin: p, version: v };
    }
    return null;
  }
  return null; // cancelled / quit
}

/** Re-run detection; report version or offer install. Used by menu/tray. */
async function checkNode(_cfg) {
  const cfg = _cfg || readConfig();
  const node = detectNode(cfg);
  if (node) {
    await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Node.js 检测",
      message: "已检测到 Node.js",
      detail: `路径：${node.bin}\n版本：${node.version}`,
    });
    return node;
  }
  return promptAndInstallNode(cfg);
}

// ---- DSH 核心更新 ---------------------------------------------------------

/** Check npm registry for a newer @deepseek-ai/dsh version. */
async function checkDshUpdate() {
  const current = dsh.currentDshVersion();
  const latest = await dsh.fetchLatestDshVersion();
  if (!current || !latest) {
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "检查 dsh 更新",
      message: "无法获取版本信息。请检查网络连接。",
    });
    return null;
  }
  if (current === latest) {
    dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "检查 dsh 更新",
      message: "当前已是最新版本",
      detail: `当前版本：${current}`,
    });
    return null;
  }
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "question",
    title: "dsh 更新可用",
    message: `发现新版本 ${latest}`,
    detail: `当前版本：${current}\n是否下载并更新？更新后需重启 DSH 服务。`,
    buttons: ["下载更新", "稍后再说"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return null;
  return { current, latest };
}

/**
 * Perform the actual dsh core update.
 *
 * 先停掉托管中的服务再替换 node_modules：Windows 会把已加载的 .node 原生
 * 模块锁定，服务存续时删除/替换必然 EPERM。随后从 registry 取该版本的
 * sha512 完整性值做下载校验，替换成功后自动把服务拉回来。
 */
async function performDshUpdate(version) {
  const hadServer = !!serverProc;
  updatingCore = true;
  if (hadServer) {
    dsh.killProcessTree(serverProc);
    serverProc = null;
    serverReused = false;
  }

  openProgressWindow("正在下载并更新 dsh 核心…");
  try {
    const dist = await dsh.fetchDshDist(version);
    if (!dist || !dist.integrity) {
      throw new Error(`无法获取 ${version} 的完整性校验信息`);
    }

    const destRoot = path.join(app.getPath("userData"), "update-cache");
    const newVersion = await dsh.updateDshCore({
      version: dist.version,
      integrity: dist.integrity,
      destRoot,
      onProgress: (got, total, ver, phase) => {
        if (phase === "download") {
          const pct = total ? Math.min(100, Math.round((got / total) * 100)) : 0;
          setProgress({ percent: pct, text: `下载中 ${ver} … ${pct}%` });
        } else if (phase === "verify") {
          setProgress({ percent: 100, text: "校验中…" });
        } else {
          setProgress({ percent: 100, text: "安装中…" });
        }
      },
    });
    closeProgress();

    // 自动恢复服务（端口上有 DSH 则挂接，否则重新拉起）。
    const result = await bootServer(readConfig());
    let restarted = false;
    if (result && result.port) {
      serverPort = result.port;
      serverReused = result.reused === true;
      if (mainWindow && !mainWindow.isDestroyed()) loadUrl(mainWindow, result.port);
      restarted = result.reused === true || result.ready !== false;
    }
    const opts = {
      type: "info",
      title: "更新完成",
      message: `dsh 已更新到 ${newVersion}`,
      detail: restarted
        ? "DSH 服务已自动重启，新版本已生效。"
        : "注意：DSH 服务未能自动重启，请从托盘菜单「重启 DSH 服务」恢复。",
    };
    if (mainWindow && !mainWindow.isDestroyed()) await dialog.showMessageBox(mainWindow, opts);
    else await dialog.showMessageBox(opts);
    return newVersion;
  } catch (err) {
    closeProgress();
    dialog.showErrorBox("dsh 更新失败", `更新失败：\n${err.message}`);
    // 我们停掉了服务，尽量把它恢复回来。
    if (hadServer) {
      try {
        await restartServer(readConfig());
      } catch {
        /* best-effort */
      }
    }
    return null;
  } finally {
    updatingCore = false;
  }
}

/** Menu/tray handler: check and optionally update dsh core. */
async function checkAndUpdateDsh() {
  const info = await checkDshUpdate();
  if (info) await performDshUpdate(info.latest);
}

// ---- 强制刷新 -------------------------------------------------------------

function forceRefresh() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reloadIgnoringCache();
  }
}

// ---- 托盘运行设置 ---------------------------------------------------------

function toggleMinimizeToTray() {
  const cfg = readConfig();
  cfg.minimizeToTray = cfg.minimizeToTray === false ? true : false;
  writeConfig(cfg);
  return cfg.minimizeToTray;
}

// ---- 开机自启 -------------------------------------------------------------

function isAutoLaunchOn() {
  return readConfig().autoLaunch === true;
}

async function toggleAutoLaunch() {
  const cfg = readConfig();
  const next = cfg.autoLaunch !== true;
  cfg.autoLaunch = next;
  writeConfig(cfg);
  try {
    if (app.isPackaged) {
      // 打包环境写入 Windows 登录项（注册表 Run 键），下次登录生效。
      app.setLoginItemSettings({ openAtLogin: next, path: process.execPath });
    } else {
      log(`[autolaunch] dev 环境仅记录配置：autoLaunch=${next}\n`);
    }
  } catch (err) {
    log(`[autolaunch] error: ${err.message}\n`);
  }
  return next;
}

// ---- 远程访问 -------------------------------------------------------------

/**
 * Get the first non-internal IPv4 address (LAN IP), e.g. 192.168.1.x.
 * Falls back to "127.0.0.1" if none found.
 */
function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

async function toggleRemoteAccess() {
  const cfg = readConfig();
  const turningOn = cfg.host === "127.0.0.1";
  if (turningOn) {
    const opts = {
      type: "warning",
      title: "开启远程访问",
      message: "开启后，同一局域网内的任意设备都能访问 DSH 界面与全部 API。",
      detail: [
        "风险提示：监听地址改为 0.0.0.0 后，未配对客户端可触达完整的宿主 API",
        "（含文件读写与命令执行能力），运行中的 dsh 会对此给出 CRITICAL 警告。",
        "",
        "建议：",
        "1. 仅在可信网络（家庭 / 办公内网）中开启；",
        "2. 优先使用 dsh 的配对机制，而不是直接开放无鉴权访问；",
        "3. 如需长期对外开放，请在防火墙层面限制来源 IP；",
        "4. 变更需在「应用 → 重启 DSH 服务」之后才生效。",
      ].join("\n"),
      buttons: ["仍然开启", "取消"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const { response } =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, opts)
        : await dialog.showMessageBox(opts);
    if (response !== 0) return cfg.host;
  }
  cfg.host = turningOn ? "0.0.0.0" : "127.0.0.1";
  writeConfig(cfg);
  await promptRestartService("远程访问设置已更改。");
  return cfg.host;
}

function isRemoteAccessOn() {
  return readConfig().host !== "127.0.0.1";
}

// ---- window -----------------------------------------------------------------

function createWindow(port) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: "#0f1720",
    autoHideMenuBar: true,
    title: "DeepSeek Harness 客户端",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Intercept close: hide to tray instead of destroying when minimizeToTray is on.
  win.on("close", (event) => {
    if (!shuttingDown && readConfig().minimizeToTray !== false) {
      event.preventDefault();
      win.hide();
      if (!app._trayNotified) {
        app._trayNotified = true;
        if (tray) {
          tray.displayBalloon({
            title: "DeepSeek Harness 客户端",
            content: "已最小化到托盘，双击托盘图标恢复窗口。\n可在「应用」菜单中关闭托盘运行。",
          });
        }
      }
      return;
    }
    // Normal close (from quit) — allow destroy.
  });

  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Open external links in the OS browser instead of a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  loadUrl(win, port);
  return win;
}

// ---- tray -------------------------------------------------------------------

function createTray(workspace) {
  const iconPath = path.join(__dirname, "assets", "tray.png");
  let image = null;
  try {
    image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) image = null;
  } catch {
    image = null;
  }
  tray = new Tray(image || nativeImage.createEmpty());
  tray.setToolTip(
    nodeState.version
      ? `DeepSeek Harness 客户端\nNode.js ${nodeState.version} | dsh ${dsh.currentDshVersion() || "?"}`
      : "DeepSeek Harness 客户端"
  );
  refreshTrayMenu(workspace);
  tray.on("click", () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
    }
  });
}

function refreshTrayMenu(workspace) {
  if (!tray) return;
  const cfg = readConfig();
  const menu = Menu.buildFromTemplate([
    { label: "打开主界面", click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } else app.emit("open-window"); } },
    { label: "强制刷新", accelerator: "CmdOrCtrl+Shift+R", click: forceRefresh },
    { type: "separator" },
    { label: "重启 DSH 服务", click: () => restartServer(readConfig()) },
    { label: `远程访问: ${isRemoteAccessOn() ? "✓ 开启" : " 关闭"}`, click: async () => { await toggleRemoteAccess(); refreshTrayMenu(workspace); buildApplicationMenu(readConfig()); } },
    { label: `开机自启: ${isAutoLaunchOn() ? "✓ 开启" : " 关闭"}`, click: async () => { await toggleAutoLaunch(); refreshTrayMenu(workspace); buildApplicationMenu(readConfig()); } },
    { label: "检查 dsh 更新", click: () => { checkAndUpdateDsh(); } },
    { label: "检查 / 安装 Node.js", click: () => { checkNode(readConfig()); } },
    { label: "打开工作区文件夹", enabled: !!workspace, click: () => { if (workspace) shell.openPath(workspace); } },
    { label: "打开日志目录", click: () => shell.openPath(path.join(app.getPath("userData"), "logs")) },
    { type: "separator" },
    { label: `托盘运行: ${cfg.minimizeToTray !== false ? "✓ 开启" : " 关闭"}`, click: () => { toggleMinimizeToTray(); refreshTrayMenu(workspace); buildApplicationMenu(readConfig()); } },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function buildApplicationMenu(cfg) {
  const isTrayOn = cfg.minimizeToTray !== false;
  const dshVer = dsh.currentDshVersion();
  const menu = Menu.buildFromTemplate([
    {
      label: "应用",
      submenu: [
        { label: "显示主界面", click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
        { label: "强制刷新", accelerator: "CmdOrCtrl+Shift+R", click: forceRefresh },
        { type: "separator" },
        { label: "重启 DSH 服务", click: () => restartServer(cfg) },
        { label: "检查 dsh 更新", click: () => { checkAndUpdateDsh(); } },
        { label: "远程访问", type: "checkbox", checked: isRemoteAccessOn(), click: async () => { await toggleRemoteAccess(); buildApplicationMenu(readConfig()); refreshTrayMenu(cfg.workspace); } },
        { label: "开机自启", type: "checkbox", checked: isAutoLaunchOn(), click: async () => { await toggleAutoLaunch(); buildApplicationMenu(readConfig()); refreshTrayMenu(cfg.workspace); } },
        { label: "检查 / 安装 Node.js", click: () => { checkNode(cfg); } },
        { type: "separator" },
        { label: `托盘运行 ${isTrayOn ? "✓" : ""}`, type: "checkbox", checked: isTrayOn, click: () => { const nv = toggleMinimizeToTray(); buildApplicationMenu(readConfig()); refreshTrayMenu(cfg.workspace); } },
        { type: "separator" },
        { label: "退出", accelerator: "CmdOrCtrl+Q", click: () => { shuttingDown = true; app.quit(); } },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        { label: "打开日志目录", click: () => shell.openPath(path.join(app.getPath("userData"), "logs")) },
        { label: "关于", click: () =>
          dialog.showMessageBox({
            type: "info",
            title: "关于",
            message: "DeepSeek Harness 客户端",
            detail: `版本 ${app.getVersion()}\nNode.js ${nodeState.version || "(未检测到)"}\ndsh ${dshVer || "(未知)"}\nDSH web 由本客户端自动托管。`,
          }) },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

// ---- lifecycle --------------------------------------------------------------

// Single-instance lock: avoid two clients fighting over the same server.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    createLogStream();
    const cfg = readConfig();
    // 注意：不要在此之后调用 app.setName() —— userData 目录取 productName，
    // 且在上面第一次 getPath("userData") 时已固定（见 configPath 注释）。
    buildApplicationMenu(cfg);

    // 开机自启：以配置为准同步系统登录项（打包环境写入注册表 Run 键）。
    try {
      if (app.isPackaged) {
        app.setLoginItemSettings({ openAtLogin: cfg.autoLaunch === true, path: process.execPath });
      }
    } catch {
      /* best-effort */
    }

    const result = await bootServer(cfg);
    if (!result || !result.port) {
      app.quit();
      return;
    }
    serverPort = result.port;
    serverReused = result.reused;

    mainWindow = createWindow(result.port);
    createTray(cfg.workspace || path.join(app.getPath("documents"), "DSH Workspace"));
    app.on("open-window", () => {
      if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
      else mainWindow = createWindow(serverPort);
    });
  });
}

app.on("activate", () => {
  if (mainWindow) mainWindow.show();
  else if (serverPort) mainWindow = createWindow(serverPort);
});

app.on("window-all-closed", () => {
  // All windows are genuinely destroyed (only happens during quit).
  app.quit();
});

app.on("before-quit", () => {
  shuttingDown = true;
  if (serverProc) dsh.killProcessTree(serverProc);
  serverProc = null;
});
