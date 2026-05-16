#!/usr/bin/env node
/**
 * Smoke test for the marionette client. Launches Zotero, waits for the
 * plugin to load AND for the Marionette listener line, then performs a
 * single executeAsyncScript and prints the result.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_MARIONETTE_PORT,
  REPO_ROOT,
  cleanupProfile,
  startZoteroWithPlugin
} from "./launch.mjs";
import { MarionetteClient } from "./marionette.mjs";

const SMOKE_LOG_DIR = join(REPO_ROOT, ".zotero-e2e");
mkdirSync(SMOKE_LOG_DIR, { recursive: true });
const SMOKE_LOG = join(SMOKE_LOG_DIR, "smoke.log");

function smokeLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(SMOKE_LOG, line, "utf8");
  } catch {
    /* ignore */
  }
}

async function main() {
  const xpiPath = process.env.ZOTERO_XPI ?? join(REPO_ROOT, "zotero-ai-explain.xpi");
  const port = Number(process.env.ZOTERO_MARIONETTE_PORT ?? DEFAULT_MARIONETTE_PORT);

  smokeLog(`[smoke] starting Zotero with ${xpiPath}`);
  const handle = await startZoteroWithPlugin({
    xpiPath,
    marionettePort: port,
    startupTimeoutMs: 60_000,
    quiet: false
  });

  smokeLog("[smoke] plugin loaded; waiting for Marionette listener");
  await handle.waitForLogLine(/Marionette\s+INFO\s+Listening on port/u, { timeoutMs: 30_000 });
  smokeLog("[smoke] connecting marionette");

  const client = new MarionetteClient();
  let result;
  try {
    const hello = await client.connect("127.0.0.1", port, { timeoutMs: 30_000 });
    smokeLog(`[smoke] hello: ${JSON.stringify(hello)}`);

    // Try several command names in sequence. WebDriver:NewSession often
    // hangs in Zotero because there's no tabbed browser; Marionette: legacy
    // commands work in chrome context without a webdriver session.
    const probeCommands = [
      ["Marionette:GetContext", {}],
      ["Marionette:SetContext", { value: "chrome" }],
      ["getContext", {}],
      ["setContext", { value: "chrome" }]
    ];
    for (const [name, params] of probeCommands) {
      try {
        const res = await Promise.race([
          client.send(name, params).then((value) => ({ ok: true, value })),
          new Promise((resolveTimeout) =>
            setTimeout(() => resolveTimeout({ ok: false, error: "timeout 5s" }), 5_000)
          )
        ]);
        smokeLog(`[smoke] ${name} -> ${JSON.stringify(res).slice(0, 200)}`);
      } catch (err) {
        smokeLog(`[smoke] ${name} threw: ${err?.message ?? err}`);
      }
    }
    smokeLog(`[smoke] context=chrome`);
    const scriptCommands = ["Marionette:ExecuteScript", "WebDriver:ExecuteScript", "executeScript"];
    const scriptBody = `
      try {
        const win = Zotero.getMainWindow();
        const popup = win?.document?.getElementById("menu_ToolsPopup");
        const items = popup ? popup.querySelectorAll('menuitem') : [];
        const labels = Array.from(items).map((i) => i.getAttribute('label'));
        return { ok: true, popupExists: !!popup, labels };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    `;
    for (const cmd of scriptCommands) {
      const res = await Promise.race([
        client
          .send(cmd, { script: scriptBody, args: [], newSandbox: false })
          .then((value) => ({ ok: true, value })),
        new Promise((resolveTimeout) =>
          setTimeout(() => resolveTimeout({ ok: false, error: "timeout 10s" }), 10_000)
        )
      ]);
      smokeLog(`[smoke] ${cmd} -> ${JSON.stringify(res).slice(0, 500)}`);
      if (res.ok) {
        result = res.value;
        break;
      }
    }
    smokeLog(`[smoke] result: ${JSON.stringify(result)}`);
  } catch (err) {
    smokeLog(`[smoke] error: ${err?.stack ?? String(err)}`);
    process.exitCode = 1;
  } finally {
    try {
      await client.deleteSession();
    } catch {
      /* ignore */
    }
    client.close();
    await handle.shutdown({ graceMs: 5_000 });
    cleanupProfile(handle.profileDir);
  }
}

const overallDeadline = setTimeout(() => {
  smokeLog("[smoke] OVERALL DEADLINE 120s reached, force-exiting");
  process.exit(2);
}, 120_000);
overallDeadline.unref();

main()
  .catch((err) => {
    smokeLog(`[smoke] fatal: ${err?.stack ?? String(err)}`);
    process.exit(1);
  })
  .finally(() => {
    clearTimeout(overallDeadline);
  });
