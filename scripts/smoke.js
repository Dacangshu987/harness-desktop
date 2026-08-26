"use strict";

/*
 * smoke.js — standalone (no-Electron) verification that the client's server
 * launch machinery works end-to-end: resolve node + dsh, pick a port, spawn
 * `dsh web`, wait for the DSH index page, then tear down.
 *
 *   node scripts/smoke.js [preferredPort]
 */

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const dsh = require("../lib/dsh-server");

async function main() {
  const preferred = Number(process.argv[2]) || 0; // 0 → let resolvePort pick
  const nodeBin = dsh.resolveNodeBin({ allowSelf: true });
  const dshBin = dsh.resolveDshBin({});

  console.log("[smoke] node:", nodeBin);
  console.log("[smoke] dsh :", dshBin);
  if (!nodeBin || !dshBin) {
    console.error("[smoke] FAIL: could not resolve node and/or dsh");
    process.exit(1);
  }

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-smoke-"));
  const { port, reused } = await dsh.resolvePort(
    preferred,
    { host: "127.0.0.1" },
  );
  console.log(`[smoke] port=${port} reused=${reused} workspace=${workspace}`);

  if (reused) {
    console.log("[smoke] PASS (reused existing DSH server)");
    process.exit(0);
  }

  const child = dsh.spawnServer({
    nodeBin,
    dshBin,
    port,
    host: "127.0.0.1",
    workspace,
    dshHome: process.env.DSH_HOME,
  });
  dsh.attachLogging(child, {
    onLine: (l) => process.stdout.write(l.replace(/\r?\n/g, "\n")),
  });

  const ready = await dsh.waitForDsh(port, { timeoutMs: 120000 });
  child.on("exit", (code, signal) => {
    console.log(`[smoke] server exited code=${code} signal=${signal}`);
  });

  if (!ready.ok) {
    console.error(`[smoke] FAIL: DSH not ready on port ${port} after ${ready.ms}ms`);
    dsh.killProcessTree(child);
    process.exit(1);
  }

  console.log(`[smoke] DSH ready on http://127.0.0.1:${port}/ after ${ready.ms}ms`);
  console.log("[smoke] PASS");
  dsh.killProcessTree(child);
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] FAIL:", err);
  process.exit(1);
});
