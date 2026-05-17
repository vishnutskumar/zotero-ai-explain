/**
 * Shared Zotero launcher used by the harness CLI and the vitest e2e suite.
 *
 * Responsibilities:
 *   - Build a clean profile under os.tmpdir() with logging prefs.
 *   - Install the plugin XPI (unpacked, so rootURI is file://).
 *   - Spawn Zotero with marionette enabled and capture stdout/stderr to a log.
 *   - Wait until either (a) the plugin prints "Zotero AI Explain startup" in
 *     the log, or (b) a timeout elapses.
 *   - Provide handles for shutdown and log scanning.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN_ID = "zotero-ai-explain@vishnutskumar.github.io";
export const STARTUP_LINE = "Zotero AI Explain startup";
export const DEFAULT_BINARY = "/Applications/Zotero.app/Contents/MacOS/zotero";
export const DEFAULT_MARIONETTE_PORT = 2828;

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function formatPrefValue(value) {
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  throw new TypeError(`Unsupported pref value type: ${typeof value}`);
}

function buildPrefsJs(marionettePort, extraPrefs = {}) {
  const base = [
    'user_pref("extensions.zotero.debug.log", true);',
    'user_pref("extensions.zotero.debug.store", true);',
    'user_pref("extensions.zotero.debug.level", 5);',
    'user_pref("extensions.zotero.debug.time", true);',
    'user_pref("extensions.zotero.firstRun2", false);',
    'user_pref("extensions.zotero.firstRunGuidance", false);',
    'user_pref("extensions.zotero.firstRunGuidanceShown.z7Banner", true);',
    'user_pref("extensions.lastAppVersion", "999.0.0");',
    'user_pref("extensions.lastAppBuildId", "99999999999999");',
    'user_pref("toolkit.startup.max_resumed_crashes", -1);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("app.update.enabled", false);',
    'user_pref("app.update.auto", false);',
    'user_pref("extensions.update.enabled", false);',
    'user_pref("extensions.update.autoUpdateDefault", false);',
    'user_pref("xpinstall.signatures.required", false);',
    'user_pref("extensions.autoDisableScopes", 0);',
    'user_pref("extensions.enabledScopes", 15);',
    'user_pref("marionette.enabled", true);',
    `user_pref("marionette.port", ${marionettePort});`,
    `user_pref("marionette.defaultPrefs.port", ${marionettePort});`
  ];
  for (const [name, value] of Object.entries(extraPrefs)) {
    base.push(`user_pref(${JSON.stringify(name)}, ${formatPrefValue(value)});`);
  }
  base.push("");
  return base.join("\n");
}

export function createProfile({
  marionettePort = DEFAULT_MARIONETTE_PORT,
  profileDir,
  extraPrefs = {}
} = {}) {
  const dir = profileDir ? resolve(profileDir) : mkdtempSync(join(tmpdir(), "zotero-e2e-"));
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "extensions"), { recursive: true });
  writeFileSync(join(dir, "prefs.js"), buildPrefsJs(marionettePort, extraPrefs), "utf8");
  return dir;
}

export function installPlugin(profileDir, xpiPath, { unpack = true } = {}) {
  if (unpack) {
    const target = join(profileDir, "extensions", PLUGIN_ID);
    mkdirSync(target, { recursive: true });
    execFileSync("unzip", ["-o", "-q", xpiPath, "-d", target], { stdio: "inherit" });
    return target;
  }
  const target = join(profileDir, "extensions", `${PLUGIN_ID}.xpi`);
  copyFileSync(xpiPath, target);
  return target;
}

/**
 * Spawn Zotero. Returns a handle with the child process, log path, and
 * helpers. The caller is responsible for shutdown via handle.shutdown().
 */
export function spawnZotero({
  binaryPath = process.env.ZOTERO_BINARY ?? DEFAULT_BINARY,
  profileDir,
  logPath,
  marionettePort = DEFAULT_MARIONETTE_PORT,
  quiet = false
}) {
  if (!existsSync(binaryPath)) {
    throw new Error(`Zotero binary not found: ${binaryPath}`);
  }
  const dataDir = join(profileDir, "data");
  mkdirSync(dataDir, { recursive: true });

  const cmdArgs = [
    "--profile",
    profileDir,
    "--no-remote",
    "--marionette",
    "--marionette-port",
    String(marionettePort),
    "--datadir",
    dataDir,
    "--ZoteroDebugText"
  ];

  const env = {
    ...process.env,
    MOZ_MARIONETTE_PORT: String(marionettePort),
    MOZ_DISABLE_GMP_SANDBOX: "1",
    MOZ_CRASHREPORTER_DISABLE: "1",
    MOZ_DISABLE_CONTENT_SANDBOX: "1",
    MOZ_DISABLE_RDD_SANDBOX: "1",
    XPCOM_DEBUG_BREAK: "warn"
  };

  if (!quiet) {
    process.stderr.write(`[harness] launching: ${binaryPath} ${cmdArgs.join(" ")}\n`);
  }

  const child = spawn(binaryPath, cmdArgs, {
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const logStream = createWriteStream(logPath, { flags: "w" });
  let logBuffer = "";
  const consumers = new Set();

  const handleChunk = (chunk) => {
    const text = chunk.toString("utf8");
    logBuffer += text;
    // After child exit, the WriteStream is end()ed but late stdout chunks
    // can still arrive (kernel buffer drainage). Writing to an ended
    // stream throws ERR_STREAM_WRITE_AFTER_END — guard it.
    if (!logStream.writableEnded && !logStream.destroyed) {
      logStream.write(chunk);
    }
    for (const consumer of consumers) {
      try {
        consumer(text);
      } catch {
        /* ignore */
      }
    }
    if (!quiet) {
      process.stdout.write(chunk);
    }
  };

  child.stdout.on("data", handleChunk);
  child.stderr.on("data", handleChunk);

  const exitPromise = new Promise((resolveExit) => {
    child.on("exit", (code, signal) => {
      logStream.end();
      resolveExit({ code, signal });
    });
  });

  function onLogChunk(consumer) {
    consumers.add(consumer);
    return () => consumers.delete(consumer);
  }

  function waitForLogLine(pattern, { timeoutMs = 30000 } = {}) {
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    if (regex.test(logBuffer)) {
      return Promise.resolve(true);
    }
    return new Promise((resolveMatch, rejectMatch) => {
      const timer = setTimeout(() => {
        unsubscribe();
        rejectMatch(new Error(`Timed out waiting for /${regex.source}/`));
      }, timeoutMs);
      const unsubscribe = onLogChunk(() => {
        if (regex.test(logBuffer)) {
          clearTimeout(timer);
          unsubscribe();
          resolveMatch(true);
        }
      });
    });
  }

  async function shutdown({ graceMs = 5000 } = {}) {
    if (child.exitCode !== null) {
      return exitPromise;
    }
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, graceMs);
    const result = await exitPromise;
    clearTimeout(killTimer);
    return result;
  }

  return {
    child,
    logPath,
    profileDir,
    marionettePort,
    exitPromise,
    waitForLogLine,
    onLogChunk,
    shutdown,
    getLog: () => logBuffer
  };
}

export async function readLogFile(logPath) {
  return readFile(logPath, "utf8").catch(() => "");
}

/**
 * Convenience: provision a clean profile + spawn Zotero + wait for our
 * plugin's startup line. Returns the handle ready for marionette use.
 */
async function isPortFree(port) {
  return new Promise((resolveCheck) => {
    const server = createServer();
    server.once("error", () => {
      resolveCheck(false);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveCheck(true));
    });
  });
}

export async function startZoteroWithPlugin({
  binaryPath,
  xpiPath = process.env.ZOTERO_XPI ?? join(REPO_ROOT, "zotero-ai-explain.xpi"),
  marionettePort = DEFAULT_MARIONETTE_PORT,
  startupTimeoutMs = 60000,
  quiet = false,
  extraPrefs = {}
} = {}) {
  if (!existsSync(xpiPath)) {
    throw new Error(`XPI not found: ${xpiPath}`);
  }
  let effectivePort = marionettePort;
  if (!(await isPortFree(effectivePort))) {
    effectivePort = await findFreePort();
    if (!quiet) {
      process.stderr.write(
        `[harness] port ${marionettePort} busy; using ephemeral ${effectivePort}\n`
      );
    }
  }
  const profileDir = createProfile({ marionettePort: effectivePort, extraPrefs });
  installPlugin(profileDir, xpiPath, { unpack: true });
  const logPath = join(profileDir, "zotero.log");
  const handle = spawnZotero({
    binaryPath,
    profileDir,
    logPath,
    marionettePort: effectivePort,
    quiet
  });
  try {
    // Wait for the LAST expected init line — the reader command registration
    // — not just the first. Otherwise tests racing the log buffer can see
    // only the early "startup" line and miss the menu/reader registrations
    // that complete a few ms later.
    await handle.waitForLogLine(STARTUP_LINE, { timeoutMs: startupTimeoutMs });
    await handle.waitForLogLine(/registered reader command: Explain with AI/u, {
      timeoutMs: 30_000
    });
  } catch (err) {
    await handle.shutdown({ graceMs: 2000 });
    throw err;
  }
  return handle;
}

export function cleanupProfile(profileDir) {
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Ask the kernel for a free TCP port; return as a number. Used when the
 * default Marionette port (2828) is already taken by a previous run.
 */
export function findFreePort() {
  return new Promise((resolveFree, rejectFree) => {
    const server = createServer();
    server.once("error", rejectFree);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close(() => {
        if (typeof port === "number") {
          resolveFree(port);
        } else {
          rejectFree(new Error("Could not determine ephemeral port"));
        }
      });
    });
  });
}
