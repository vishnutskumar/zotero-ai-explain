#!/usr/bin/env node
/**
 * Smoke + diagnostic probe for the Marionette client against Zotero 8.
 *
 * Launches Zotero, waits for the plugin to load AND for the Marionette
 * listener line, then iterates through several `WebDriver:NewSession`
 * capability shapes. If any shape succeeds, it follows up with
 * `Marionette:SetContext("chrome")` and a `WebDriver:ExecuteScript` that
 * inspects the Tools menu popup.
 *
 * State as of 2026-05-16 against Zotero 140.10.0esr / Firefox 140 ESR
 * embedded: all NewSession shapes hang for 10s with no response. All other
 * Marionette commands reject with "WebDriver session does not exist". This
 * script is kept in tree so future agents can confirm or refute that state.
 *
 * Run via `npm run test:e2e:smoke`. The output is mirrored to
 * `.zotero-e2e/smoke.log` for inspection.
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

  // Probe several WebDriver:NewSession capability shapes; in Firefox 140 ESR
  // (Zotero 8) embedded, the default `{}` request hangs because Marionette
  // waits on a browser window that never opens. We try a few shapes and stop
  // at the first one that returns within 8s.
  const sessionShapes = [
    {
      label: "acceptConn-then-empty",
      preflight: "Marionette:AcceptConnections",
      preflightParams: { value: true },
      params: { capabilities: {} }
    },
    { label: "no-args", params: {} },
    {
      label: "with-args-only",
      params: { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } }
    }
  ];

  let workedClient;
  let workedLabel;
  for (const shape of sessionShapes) {
    const { label, params, preflight, preflightParams } = shape;
    const candidate = new MarionetteClient();
    try {
      const hello = await candidate.connect("127.0.0.1", port, { timeoutMs: 8_000 });
      smokeLog(`[smoke] hello[${label}]: ${JSON.stringify(hello)}`);
      if (preflight) {
        const preRes = await Promise.race([
          candidate.send(preflight, preflightParams).then((v) => ({ ok: true, value: v })),
          new Promise((resolveTimeout) =>
            setTimeout(() => resolveTimeout({ ok: false, error: "timeout 5s" }), 5_000)
          )
        ]);
        smokeLog(
          `[smoke] preflight[${label}] ${preflight} -> ${JSON.stringify(preRes).slice(0, 200)}`
        );
      }
      const res = await Promise.race([
        candidate.send("WebDriver:NewSession", params).then((v) => ({ ok: true, value: v })),
        new Promise((resolveTimeout) =>
          setTimeout(() => resolveTimeout({ ok: false, error: "timeout 10s" }), 10_000)
        )
      ]);
      smokeLog(`[smoke] NewSession[${label}] -> ${JSON.stringify(res).slice(0, 200)}`);
      if (res.ok) {
        workedClient = candidate;
        workedLabel = label;
        break;
      }
      candidate.close();
    } catch (err) {
      smokeLog(`[smoke] NewSession[${label}] threw: ${err?.message ?? err}`);
      candidate.close();
    }
  }

  let result;
  if (!workedClient) {
    smokeLog("[smoke] no NewSession shape succeeded");
    process.exitCode = 1;
  } else {
    smokeLog(`[smoke] proceeding with session shape: ${workedLabel}`);
    try {
      const ctxRes = await Promise.race([
        workedClient
          .send("Marionette:SetContext", { value: "chrome" })
          .then((v) => ({ ok: true, value: v })),
        new Promise((resolveTimeout) =>
          setTimeout(() => resolveTimeout({ ok: false, error: "timeout 5s" }), 5_000)
        )
      ]);
      smokeLog(`[smoke] SetContext(chrome) -> ${JSON.stringify(ctxRes).slice(0, 200)}`);

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
      const execRes = await Promise.race([
        workedClient
          .send("WebDriver:ExecuteScript", { script: scriptBody, args: [], newSandbox: false })
          .then((v) => ({ ok: true, value: v })),
        new Promise((resolveTimeout) =>
          setTimeout(() => resolveTimeout({ ok: false, error: "timeout 10s" }), 10_000)
        )
      ]);
      smokeLog(`[smoke] ExecuteScript -> ${JSON.stringify(execRes).slice(0, 500)}`);
      if (execRes.ok) {
        result = execRes.value;
      }
    } catch (err) {
      smokeLog(`[smoke] error: ${err?.stack ?? String(err)}`);
      process.exitCode = 1;
    } finally {
      try {
        await workedClient.deleteSession();
      } catch {
        /* ignore */
      }
      workedClient.close();
    }
  }

  smokeLog(`[smoke] result: ${JSON.stringify(result)}`);
  await handle.shutdown({ graceMs: 5_000 });
  cleanupProfile(handle.profileDir);
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
