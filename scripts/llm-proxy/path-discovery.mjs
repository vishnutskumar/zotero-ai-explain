/**
 * Login-shell PATH discovery + binary resolution for the bundled LLM
 * proxy. Solves the canonical macOS bug where Zotero (a GUI app) launches
 * the proxy with `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and `spawn('codex')`
 * fails ENOENT because Homebrew / asdf / mise / nix prefixes are absent.
 *
 * Strategy: at proxy startup we spawn the user's login shell with the
 * appropriate `-lc 'print PATH'` command, parse the result, and merge
 * any new entries into `process.env.PATH`. Subsequent `spawn('codex')`
 * calls then resolve through the enriched PATH without any per-backend
 * knowledge of where the binary lives.
 *
 * The discovery is best-effort and never blocks the server:
 *
 *   - We only enrich PATH; we never replace it. Existing entries are
 *     preserved so a user with a working setup is never regressed.
 *   - The shell call is timeboxed (default 2s). On timeout, broken
 *     `.zshrc`, or unknown shell we fall back to a static prefix list.
 *   - Any non-zero exit, stderr, or empty stdout is treated as failure
 *     and falls back to the static list.
 *   - All errors are swallowed and surfaced via the returned diagnostic
 *     so the host can surface them in the settings UI without crashing
 *     the proxy.
 *
 * Cross-shell support is by `basename($SHELL)`:
 *
 *   - bash / zsh / sh / dash / ksh — POSIX `-lc 'printf "%s" "$PATH"'`
 *   - fish                         — `-lc 'string join : $PATH'`
 *   - nu (nushell)                 — `-lc '$env.PATH | str join ":"'`
 *   - anything else                — POSIX, but fall back on failure
 *
 * Windows users on macOS are rare and Windows GUI apps inherit the
 * user PATH normally; we leave Windows alone (callers can probe via
 * `process.platform === "win32"` if needed).
 */

import { spawn as defaultSpawn } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import nodePath, { delimiter as pathDelimiter, join as pathJoin, basename } from "node:path";
import { homedir } from "node:os";
import process from "node:process";

/**
 * POSIX executable check. Returns true iff `accessSync(path, X_OK)`
 * succeeds — the binary exists AND the user has +x permission. Used as
 * the default `isExecutable` for `findBinary()` so we don't paint a
 * green "found" status for a file the backend will EACCES on at spawn
 * time. Windows treats any present .exe/.cmd/.bat as executable, so the
 * caller falls back to a plain existence check there.
 */
function isExecutablePosix(path) {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hard-coded fallback PATH entries used when the login-shell query fails
 * (timeout, broken rc files, unknown shell, no $SHELL). Covers Homebrew
 * on both Apple Silicon and Intel macs, MacPorts, common user-local bin
 * directories, and the runtime defaults Cargo and Bun install into.
 *
 * Order is "most-specific-first". When we merge into process.env.PATH we
 * append (rather than prepend) so an existing entry the system put first
 * still wins.
 */
export const FALLBACK_PATH_ENTRIES = Object.freeze([
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/opt/local/bin",
  "/opt/local/sbin",
  pathJoin(homedir(), ".bun", "bin"),
  pathJoin(homedir(), ".cargo", "bin"),
  pathJoin(homedir(), ".local", "bin"),
  pathJoin(homedir(), "bin")
]);

/**
 * Resolve the shell command to query and the args to pass for asking it
 * to print the user's PATH. Returns null when the shell is unsupported
 * (caller falls back to FALLBACK_PATH_ENTRIES).
 *
 * @param {string|undefined} shellPath  The user's $SHELL env value.
 * @returns {{ command: string, args: readonly string[] } | null}
 */
export function shellPathQuery(shellPath) {
  if (typeof shellPath !== "string" || shellPath.length === 0) return null;
  const name = basename(shellPath).toLowerCase();
  if (name === "fish") {
    // fish stores PATH as a list; print colon-joined so we can parse it
    // the same way the POSIX shells produce.
    return { command: shellPath, args: ["-lc", "string join : $PATH"] };
  }
  if (name === "nu") {
    // Nushell — `$env.PATH` is a list; `str join` matches the POSIX shape.
    return { command: shellPath, args: ["-lc", '$env.PATH | str join ":"'] };
  }
  // POSIX-ish: bash, zsh, sh, dash, ksh, mksh, ash. `printf` avoids the
  // trailing newline `echo` adds in some implementations.
  return { command: shellPath, args: ["-lc", 'printf "%s" "$PATH"'] };
}

/**
 * Run the login-shell PATH query and resolve to the result string (or
 * null on any failure). Pure-function-style: every dep is injectable so
 * the unit tests don't actually spawn shells.
 *
 * @param {{
 *   shell?: string,
 *   spawn?: typeof defaultSpawn,
 *   timeoutMs?: number,
 *   env?: Readonly<Record<string,string|undefined>>
 * }} [deps]
 * @returns {Promise<string|null>}
 */
export async function discoverLoginShellPath(deps = {}) {
  const env = deps.env ?? process.env;
  const shell = deps.shell ?? env.SHELL;
  const timeoutMs = deps.timeoutMs ?? 2000;
  const spawn = deps.spawn ?? defaultSpawn;
  const query = shellPathQuery(shell);
  if (query === null) return null;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(query.command, query.args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...env }
      });
    } catch {
      resolve(null);
      return;
    }
    let stdout = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore; the child may have already exited.
      }
      finish(null);
    }, timeoutMs);
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }
    child.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        finish(null);
        return;
      }
      const trimmed = stdout.trim();
      finish(trimmed.length > 0 ? trimmed : null);
    });
  });
}

/**
 * Merge the given PATH-like string (colon-separated on POSIX) into the
 * current `process.env.PATH`, appending any entries that aren't already
 * present. Existing entries keep their position so a system-managed PATH
 * isn't reordered. Returns the new PATH string.
 *
 * Exported so tests can pin the merge behavior in isolation.
 *
 * @param {string} currentPath
 * @param {Iterable<string>|string} additions
 * @returns {string}
 */
export function mergePathEntries(currentPath, additions) {
  const current = (currentPath ?? "")
    .split(pathDelimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const seen = new Set(current);
  const additionList =
    typeof additions === "string" ? additions.split(pathDelimiter) : [...additions];
  for (const raw of additionList) {
    const entry = (raw ?? "").trim();
    if (entry.length === 0) continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    current.push(entry);
  }
  return current.join(pathDelimiter);
}

/**
 * Diagnostic returned by `enrichEnvironmentPath`. Surfaces enough info
 * for the settings UI to explain what happened: which source (shell vs
 * fallback) provided the entries, and any error message from the shell
 * query.
 *
 * @typedef {Object} PathEnrichmentResult
 * @property {"shell"|"fallback"|"noop"} source
 *   "shell"    — discovered via $SHELL -lc; the user's real shell config
 *                contributed.
 *   "fallback" — shell query produced nothing usable; merged the static
 *                FALLBACK_PATH_ENTRIES that pass `existsSync`.
 *   "noop"     — nothing to merge (current PATH already contained
 *                everything we'd add). The proxy works fine.
 * @property {readonly string[]} added
 *   PATH entries newly inserted into `process.env.PATH`.
 * @property {string} finalPath
 *   The new value of `process.env.PATH` after the merge.
 * @property {string|undefined} shellUsed
 *   The shell command that was queried, or undefined when the platform
 *   skipped discovery (Windows, no $SHELL).
 */

/**
 * Best-effort enrich `process.env.PATH` with login-shell entries so the
 * proxy's downstream `spawn('codex')` / `spawn('claude')` find binaries
 * the GUI-app PATH doesn't include. Idempotent: calling twice in a row
 * adds nothing the second time.
 *
 * Always resolves; never throws. The returned diagnostic is suitable
 * for surfacing through the proxy's /api/diagnostics endpoint.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   discover?: typeof discoverLoginShellPath,
 *   fallbackEntries?: readonly string[],
 *   exists?: (path: string) => boolean,
 *   platform?: NodeJS.Platform
 * }} [deps]
 * @returns {Promise<PathEnrichmentResult>}
 */
export async function enrichEnvironmentPath(deps = {}) {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const platform = deps.platform ?? process.platform;
  const fallback = deps.fallbackEntries ?? FALLBACK_PATH_ENTRIES;
  const discover = deps.discover ?? discoverLoginShellPath;
  const before = env.PATH ?? "";

  // Windows GUI apps inherit the user PATH normally; skip the unix-only
  // login-shell dance and only contribute fallback dirs that exist.
  // Linux desktop launchers usually inherit user PATH too, so the
  // enrichment is mostly a no-op there as well — but the shell-query
  // still catches asdf/mise on Linux when the user uses GNOME launchers
  // that strip the env.
  if (platform === "win32") {
    return {
      source: "noop",
      added: [],
      finalPath: before,
      shellUsed: undefined
    };
  }

  let discovered = null;
  try {
    discovered = await discover({ env });
  } catch {
    discovered = null;
  }

  let source = "fallback";
  let entries = [];
  if (typeof discovered === "string" && discovered.length > 0) {
    source = "shell";
    entries = discovered
      .split(pathDelimiter)
      .map((p) => p.trim())
      .filter(Boolean);
  } else {
    // Use only the fallback entries that actually exist on disk so we
    // don't pollute PATH with ghost prefixes.
    entries = fallback.filter((p) => {
      try {
        return exists(p);
      } catch {
        return false;
      }
    });
  }

  const beforeSet = new Set(
    before
      .split(pathDelimiter)
      .map((p) => p.trim())
      .filter(Boolean)
  );
  const added = entries.filter((entry) => !beforeSet.has(entry));
  if (added.length === 0) {
    return {
      source: "noop",
      added: [],
      finalPath: before,
      shellUsed: source === "shell" ? env.SHELL : undefined
    };
  }
  const finalPath = mergePathEntries(before, added);
  env.PATH = finalPath;
  return {
    source,
    added,
    finalPath,
    shellUsed: source === "shell" ? env.SHELL : undefined
  };
}

/**
 * Resolve the absolute path of a binary on the current PATH. Mirrors
 * `which` but in pure JS so we don't depend on `/usr/bin/which` being
 * present (it is on every Unix we target, but a synchronous JS lookup
 * is cheaper and easier to test).
 *
 * Honors an override (e.g. `PROXY_CODEX_BIN`) first so users can pin a
 * specific binary even if PATH discovery missed it.
 *
 * @param {string} command  bare command name like "codex".
 * @param {{
 *   override?: string|null|undefined,
 *   env?: Readonly<Record<string,string|undefined>>,
 *   exists?: (path: string) => boolean,
 *   isExecutable?: (path: string) => boolean,
 *   platform?: NodeJS.Platform
 * }} [deps]
 * @returns {{ path: string|null, searched: readonly string[] }}
 */
export function findBinary(command, deps = {}) {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const platform = deps.platform ?? process.platform;
  // POSIX uses `accessSync(path, X_OK)` so a non-executable file (the
  // user installed via a tarball but forgot `chmod +x`, or a broken
  // partial install) reports "not found" rather than "found" — the
  // backend would otherwise EACCES at spawn time and the dialog would
  // have painted a green check. Windows treats .exe / .cmd / .bat as
  // executable by virtue of existing, so the plain exists check is
  // correct there. Callers can still inject a stub via `isExecutable`
  // for unit tests.
  const isExec = deps.isExecutable ?? (platform === "win32" ? exists : isExecutablePosix);
  const override = typeof deps.override === "string" ? deps.override.trim() : "";

  if (override.length > 0) {
    // Codex review #1 residual: even when the user explicitly sets
    // PROXY_CODEX_BIN, validate the override is actually executable
    // before reporting "found". A typoed path or a download missing
    // its +x bit would otherwise paint a green status row and then
    // EACCES at spawn time.
    if (isExec(override)) {
      return { path: override, searched: [override] };
    }
    return { path: null, searched: [override] };
  }
  // Windows uses `;` as PATH separator and backslash path joins; the
  // posix `path.delimiter`/`path.join` from this module would give the
  // wrong result on a Windows-shaped input. Switch to `path.win32` when
  // looking up Windows binaries (rare for Zotero AI on macOS, but the
  // codepath has to work for the cross-platform release matrix).
  const join = platform === "win32" ? nodePath.win32.join : pathJoin;
  const delim = platform === "win32" ? ";" : pathDelimiter;
  const path = env.PATH ?? "";
  const dirs = path
    .split(delim)
    .map((p) => p.trim())
    .filter(Boolean);
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase())
      : [""];
  const searched = [];
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, ext.length > 0 ? `${command}${ext}` : command);
      searched.push(candidate);
      try {
        if (isExec(candidate)) {
          return { path: candidate, searched };
        }
      } catch {
        // Skip ENOACCES / ENOENT on individual entries; keep looking.
      }
    }
  }
  return { path: null, searched };
}
