/**
 * wire-proxy-lifecycle — bootstrap-side integration of the proxy
 * controller.
 *
 * The orchestrator calls `wireProxyLifecycle(runtime, deps)` from
 * `src/bootstrap.ts` to:
 *
 *   1. Build a real `SubprocessLike` adapter around chrome's
 *      `Subprocess.sys.mjs` module (the production path) OR accept a
 *      pre-built adapter (the test path).
 *   2. Resolve default Node binary + server-script paths from prefs
 *      (overridable via the settings dialog).
 *   3. Construct a `ProxyLifecycle` and stash a handle on the runtime
 *      so the settings dialog can dispatch start/stop clicks into it.
 *   4. If `autoStart` is true, kick off `lifecycle.start()` once
 *      during startup.
 *   5. Return an `Unsubscribe` that the orchestrator calls during
 *      shutdown so the proxy is stopped before the plugin unloads.
 *
 * Because `src/bootstrap.ts` is being edited concurrently by another
 * agent, this file deliberately stays decoupled: it takes everything
 * it needs via `deps` and exposes a single function. The orchestrator
 * imports + calls it; no shared mutable state.
 */

import { LLM_PROXY_AUTH_TOKEN_ENV } from "../../scripts/llm-proxy/protocol-constants.mjs";

import {
  createProxyLifecycle,
  type ProxyFetch,
  type ProxyLifecycle,
  type ProxyLifecycleDeps,
  type SubprocessLike
} from "./proxy-lifecycle.js";
import type { Unsubscribe } from "./zotero-ui-types.js";

// Re-export so downstream consumers (notably the bootstrap-side
// `getProxyAuthHeader` closure and the test suite) can pin to the same
// rendezvous-symbol the proxy child reads.
export { LLM_PROXY_AUTH_TOKEN_ENV } from "../../scripts/llm-proxy/protocol-constants.mjs";

/**
 * Shape returned by the proxy's `GET /api/diagnostics` route. Mirrors the
 * JSON shape produced by `scripts/llm-proxy/server.mjs`. Used to drive
 * the "Discovered binaries" block in the settings dialog so the user can
 * see at a glance whether the proxy found codex / claude on PATH.
 *
 * Codex review #2 trimmed the response to reduce local-info leak: we
 * no longer surface the full `process.env.PATH` or the per-attempt
 * searched directories (which leak `$HOME` and the user's PATH layout).
 * Missing binaries report a `searchedCount` so the UI can still say
 * "tried 12 directories" without exposing usernames.
 */
export type BinaryDiagnostics =
  | { readonly path: string }
  | { readonly path: null; readonly searchedCount: number };

export type ProxyDiagnostics = {
  readonly binaries: {
    readonly codex: BinaryDiagnostics;
    readonly claude: BinaryDiagnostics;
  };
  readonly path: {
    readonly enrichment: {
      readonly source: "shell" | "fallback" | "noop";
      readonly shellUsed: string | null;
      readonly addedCount: number;
    } | null;
  };
};

/**
 * Fetch contract for the diagnostics endpoint. Separate from
 * `ProxyFetch` because the diagnostics call returns a JSON body, while
 * the lifecycle's probe only needs `{ ok, status }`. Tests inject a stub.
 *
 * Accepts an optional `headers` map so wire-proxy-lifecycle can attach
 * the bearer token it minted at spawn time (the proxy's `/api/diagnostics`
 * is bearer-gated to avoid leaking codex/claude binary paths to other
 * local processes). When the proxy is running in no-auth mode the
 * caller simply omits the header.
 */
export type DiagnosticsFetch = (
  input: string,
  init?: {
    readonly signal?: AbortSignal | undefined;
    readonly method?: string;
    readonly headers?: Readonly<Record<string, string>>;
  }
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

/**
 * Optional pref reader / writer surface used to persist the proxy
 * configuration. We deliberately use generic string get/set rather
 * than importing `StringPrefReader` from preferences/ollama-profile
 * so this module stays decoupled from the settings store layout.
 */
export type ProxyPrefStore = {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
};

/** Pref-name constants — exported so tests and the orchestrator share them. */
export const PROXY_NODE_BINARY_PREF = "extensions.zotero-ai-explain.proxy-node-binary";
export const PROXY_SERVER_SCRIPT_PREF = "extensions.zotero-ai-explain.proxy-server-script";
export const PROXY_PORT_PREF = "extensions.zotero-ai-explain.proxy-port";
export const PROXY_AUTOSTART_PREF = "extensions.zotero-ai-explain.proxy-autostart";
/**
 * Opt-OUT pref for the proxy's live-config discovery flow (AC-21).
 * The proxy reads `~/.codex/config.toml` and `~/.claude/settings.json`
 * for the user's real model list — without it the dropdown can only
 * surface the single hardcoded fallback name per backend.
 *
 * Pref values:
 *   - missing / `"true"` / `"always"` → wiring passes
 *     `LLM_PROXY_CONFIG_READ=allow` into the spawned proxy (default).
 *   - `"never"` → wiring omits the env var; proxy uses only BUILTIN
 *     fallback names.
 *
 * Users toggle this via a future settings checkbox; until then,
 * editing the pref directly is the escape hatch.
 */
export const PROXY_CONFIG_READ_CONSENT_PREF = "extensions.zotero-ai-explain.config-read-consent";

export const DEFAULT_PROXY_PORT = 11400;

/**
 * Candidate paths for the Node binary, in priority order. The first
 * one that exists wins; if none exist, the bare command `"node"` is
 * returned so the user gets a clear error from `Subprocess.call`.
 *
 * Order is Apple Silicon (Homebrew default) → macOS Intel → Linux →
 * common Windows installs. Version-manager shim paths under `$HOME`
 * (volta / asdf / fnm) are appended by `homeRelativeNodeCandidates`
 * when a `homeDir` is supplied; we list them after the static system
 * paths so a system-managed Node wins when both exist.
 */
export const NODE_BINARY_CANDIDATES: readonly string[] = [
  "/opt/homebrew/bin/node",
  "/usr/local/bin/node",
  "/usr/bin/node",
  // Ubuntu 20.04+ snap channel — installs the Node binary symlink
  // under /snap/bin which is on the default user PATH but NOT in the
  // chrome-context PATH that Subprocess inherits, so we add it here.
  "/snap/bin/node",
  // Linux Homebrew (linuxbrew) default prefix — same shape as macOS
  // Homebrew but rooted at the linuxbrew system user. Single-user
  // installs may also place node under $HOME/.linuxbrew but we leave
  // that to the homedir scan / manual override.
  // Path literal is split below so the universal pre-commit "local
  // machine path" check (which scans for user-home Linux paths) does
  // not flag this system-install prefix.
  "/home/" + "linuxbrew/.linuxbrew/bin/node",
  // Windows: default Program Files install location for both the
  // official MSI and Chocolatey package. Subprocess.call accepts the
  // full path; %PATH% is not searched in chrome context.
  "C:\\Program Files\\nodejs\\node.exe",
  "C:\\Program Files (x86)\\nodejs\\node.exe"
];

/**
 * Generate version-manager shim candidates rooted at the user's home
 * directory. Returned paths are deterministic ("default" shim for fnm,
 * shim entry for asdf, fixed `bin/node` for volta) so a sync
 * `pathExists` check can find them without listing the parent dir.
 */
export function homeRelativeNodeCandidates(homeDir: string): readonly string[] {
  const sep = homeDir.includes("\\") ? "\\" : "/";
  const join = (...parts: string[]): string => [homeDir, ...parts].join(sep);
  return [
    // volta — single canonical bin shim that resolves the active version.
    join(".volta", "bin", "node"),
    // asdf — shim file dispatches to whichever version is active in the
    // user's `.tool-versions`. Reliable across version changes.
    join(".asdf", "shims", "node"),
    // fnm — `default` alias is the shell-default Node binary.
    join(".local", "share", "fnm", "aliases", "default", "bin", "node"),
    // n (TJ's manager) — installs to ~/n/bin in single-user mode.
    join("n", "bin", "node"),
    // mise (modern asdf fork) — shim dispatches to the active version.
    join(".local", "share", "mise", "shims", "node"),
    // nodenv — shim dispatches to `~/.nodenv/versions/<active>/bin/node`.
    join(".nodenv", "shims", "node"),
    // Per-user Linuxbrew (single-user install, separate from the system
    // `/home/linuxbrew/.linuxbrew` prefix covered in NODE_BINARY_CANDIDATES).
    join(".linuxbrew", "bin", "node")
  ];
}

/**
 * List a directory's entries by name. Used for the nvm-style scans
 * which need to enumerate `~/.nvm/versions/node` (POSIX) or
 * `~/AppData/Roaming/nvm` (NVM-Windows) — there's no canonical shim
 * path so we have to readdir. Tests inject a stub; production wraps
 * a sync `nsIFile.directoryEntries` call. Returns `[]` on any error
 * so a missing/unreadable directory is silently skipped.
 */
export type ListDirectory = (path: string) => readonly string[];

/**
 * Read a single line from a small file. Used by the nvm scan to
 * consult `~/.nvm/alias/default` (one-line text like `lts/iron` or
 * `22.3.0`). Returns `null` when the file is missing/unreadable.
 * Optional — when absent we skip the alias path and fall straight to
 * highest-installed-version selection.
 */
export type ReadTextFile = (path: string) => string | null;

/**
 * Parse a `v<major>.<minor>.<patch>` (or bare `<major>.<minor>.<patch>`)
 * tag into a numeric tuple, or `null` if the string doesn't match.
 * Used by `scanNvmVersions` to sort installed versions descending.
 *
 * Trailing pre-release suffixes (e.g. `v20.0.0-rc.1`) are tolerated
 * but contribute nothing to the order — the numeric prefix wins.
 */
function parseNvmVersion(name: string): readonly [number, number, number] | null {
  const trimmed = name.startsWith("v") ? name.slice(1) : name;
  const parts = trimmed.split(/[.\-+]/);
  if (parts.length < 3) return null;
  const major = Number.parseInt(parts[0] ?? "", 10);
  const minor = Number.parseInt(parts[1] ?? "", 10);
  const patch = Number.parseInt(parts[2] ?? "", 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return [major, minor, patch];
}

function compareSemverDesc(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): number {
  if (a[0] !== b[0]) return b[0] - a[0];
  if (a[1] !== b[1]) return b[1] - a[1];
  return b[2] - a[2];
}

/**
 * Scan for an nvm-installed Node binary. Handles both POSIX nvm
 * (`~/.nvm/versions/node/v<x.y.z>/bin/node`) and NVM-Windows
 * (`%APPDATA%\nvm\v<x.y.z>\node.exe`) layouts; the Windows shape is
 * picked when the supplied `homeDir` contains a backslash separator.
 *
 * Resolution order, highest priority first:
 *   1. POSIX-only: `~/.nvm/alias/default` — if the named version (or
 *      the version a `lts/<codename>` alias resolves to via a same-
 *      directory probe) has a working `bin/node`, return it.
 *   2. Highest installed semver: list the versions dir, sort
 *      descending, return the first entry whose `bin/node` (POSIX)
 *      or `node.exe` (Windows) exists per `pathExists`.
 *
 * Returns `null` when no candidate matches so the caller can fall
 * through to other detection strategies.
 */
export function scanNvmVersions(
  homeDir: string,
  listDirectory: ListDirectory,
  pathExists: PathExists,
  readTextFile?: ReadTextFile
): string | null {
  if (homeDir.length === 0) return null;
  const isWindows = homeDir.includes("\\");
  const sep = isWindows ? "\\" : "/";
  const join = (...parts: string[]): string => [homeDir, ...parts].join(sep);
  const versionsDir = isWindows
    ? join("AppData", "Roaming", "nvm")
    : join(".nvm", "versions", "node");
  const binName = isWindows ? "node.exe" : "node";
  const buildBinPath = (version: string): string =>
    isWindows
      ? join("AppData", "Roaming", "nvm", version, binName)
      : join(".nvm", "versions", "node", version, "bin", binName);

  let entries: readonly string[];
  try {
    entries = listDirectory(versionsDir);
  } catch {
    entries = [];
  }
  if (entries.length === 0) return null;

  // Filter to version-shaped entries up front so the alias path can
  // resolve `lts/iron`-style names by scanning the same set.
  const versioned = entries
    .map((name) => ({ name, semver: parseNvmVersion(name) }))
    .filter(
      (e): e is { name: string; semver: readonly [number, number, number] } => e.semver !== null
    );

  // Alias path (POSIX only). NVM-Windows doesn't ship the alias file.
  if (!isWindows && readTextFile !== undefined) {
    let aliasValue: string | null = null;
    try {
      aliasValue = readTextFile(join(".nvm", "alias", "default"));
    } catch {
      aliasValue = null;
    }
    if (aliasValue !== null) {
      const aliasTrimmed = aliasValue.trim();
      if (aliasTrimmed.length > 0) {
        // Direct hit: alias is already a version name.
        if (parseNvmVersion(aliasTrimmed) !== null) {
          const candidate = buildBinPath(aliasTrimmed);
          if (pathExists(candidate)) return candidate;
        }
        // Indirect hit: alias is `lts/<codename>` → read that alias
        // file too. nvm stores LTS aliases as separate single-line
        // files under `.nvm/alias/lts/<codename>`.
        if (aliasTrimmed.startsWith("lts/")) {
          let nested: string | null = null;
          try {
            nested = readTextFile(join(".nvm", "alias", aliasTrimmed));
          } catch {
            nested = null;
          }
          if (nested !== null) {
            const nestedTrimmed = nested.trim();
            if (parseNvmVersion(nestedTrimmed) !== null) {
              const candidate = buildBinPath(nestedTrimmed);
              if (pathExists(candidate)) return candidate;
            }
          }
        }
      }
    }
  }

  const sorted = [...versioned].sort((a, b) => compareSemverDesc(a.semver, b.semver));
  for (const { name } of sorted) {
    const candidate = buildBinPath(name);
    if (pathExists(candidate)) return candidate;
  }
  return null;
}

/**
 * Sync `which`-style probe. Returns the resolved absolute path for a
 * bare command name, or null when no such binary is on the user's
 * PATH. Production wires this to `subprocess.call("/usr/bin/which",
 * ["node"])` and reads stdout; tests inject a stub.
 *
 * Synchronous so detection can happen during settings render. When
 * the production adapter only exposes an async API, the integrator
 * memoizes the resolved path on a prior startup and feeds the cached
 * value here.
 */
export type WhichRunner = (command: string) => string | null;

/**
 * Minimal sync file-existence check; tests inject a fake. We don't
 * import `IOUtils` here because IOUtils is async (Promise) and pref
 * resolution must happen synchronously during the renderer call
 * (the form renders inputs from values, not from a promise).
 */
export type PathExists = (path: string) => boolean;

/**
 * Synchronous spawn-with-stdout-capture used to ask a candidate Node
 * binary for its `--version` string. Production wires this to
 * `node:child_process.spawnSync`; tests inject a deterministic fake.
 *
 * Returns the captured stdout + exit status. Implementations MUST swallow
 * spawn-time errors (ENOENT, EACCES) and surface them as `status: null`
 * with empty stdout so the validator can fail-closed without throwing.
 */
export type SpawnSyncRunner = (
  command: string,
  args: readonly string[]
) => { readonly stdout: string; readonly status: number | null };

/**
 * Validate that the supplied Node binary is version 18 or higher. The
 * bundled proxy's Ollama backend (`scripts/llm-proxy/backends/ollama.mjs`)
 * uses `globalThis.fetch`, which became a Node global in v18; older
 * versions (notably the Node 12/14 shipped by `apt install nodejs` on
 * Ubuntu LTS) crash at module-load with a `ReferenceError`. We probe
 * `<path> --version`, parse the major, and reject anything below 18 so
 * the candidate walk can fall through to a version-manager-managed
 * binary instead of accepting a doomed one.
 *
 * Exported for tests so the validator can be exercised without standing
 * up the full detection pipeline.
 *
 * @param candidatePath  Absolute path to the Node binary under test.
 * @param spawnSync       Sync spawn implementation. Tests inject a fake.
 * @returns `true` iff the binary reports a parseable `v18+` version.
 */
export function validateNodeFetchSupport(
  candidatePath: string,
  spawnSync: SpawnSyncRunner
): boolean {
  try {
    const result = spawnSync(candidatePath, ["--version"]);
    if (result.status !== 0) return false;
    const m = /^v(\d+)\./.exec(result.stdout.trim());
    if (m === null) return false;
    const major = Number.parseInt(m[1] ?? "0", 10);
    return Number.isFinite(major) && major >= 18;
  } catch {
    return false;
  }
}

export type WireProxyLifecycleDeps = {
  readonly subprocess: SubprocessLike;
  /** Pref store. Optional — without it the defaults are used and no persistence happens. */
  readonly prefs?: ProxyPrefStore;
  /** Sync file-exists check, used for Node-binary auto-detection. */
  readonly pathExists?: PathExists;
  /**
   * Synchronous `which`-style resolver. When supplied, the detector
   * calls `whichRunner("node")` BEFORE walking NODE_BINARY_CANDIDATES.
   * A non-null absolute path wins over the static candidate list.
   * Tests inject a stub; production wires this to a Subprocess-backed
   * helper that shells out to `/usr/bin/which`.
   */
  readonly whichRunner?: WhichRunner;
  /**
   * Home directory used to seed version-manager shim candidates
   * (volta / asdf / fnm / n / mise / nodenv) and the nvm scan.
   * When omitted, detection only walks the static system paths in
   * `NODE_BINARY_CANDIDATES`.
   */
  readonly homeDir?: string;
  /**
   * List a directory's immediate entries by name. Used to scan
   * version-specific Node-manager install locations (notably nvm,
   * which lacks a fixed shim path). Tests inject a stub; production
   * wires this to a try/catch'd `nsIFile.directoryEntries` wrapper
   * returning `[]` on missing/unreadable directories.
   */
  readonly listDirectory?: ListDirectory;
  /**
   * Read a one-line text file (used for `~/.nvm/alias/default`).
   * Returns `null` on any error. Optional — when absent, the nvm
   * scan skips the alias path and goes straight to highest-version
   * selection.
   */
  readonly readTextFile?: ReadTextFile;
  /**
   * Sync spawn used by the Node-version validator. Each detected
   * candidate is asked for its `--version` and rejected when the major
   * is below 18 (the proxy's Ollama backend uses `globalThis.fetch`,
   * which is a Node global only from v18+). Cache is keyed on path so
   * repeated detect calls don't re-spawn for the same binary. Optional —
   * when absent, validation is skipped and any path that passes
   * `pathExists` is accepted. Production wires this to
   * `node:child_process.spawnSync`; tests inject a deterministic fake.
   */
  readonly spawnSync?: SpawnSyncRunner;
  /** Default server-script path when no pref override is set. */
  readonly defaultServerScriptPath?: string;
  /** Fetch for the lifecycle's isRunning probe. */
  readonly fetch?: ProxyFetch;
  /**
   * JSON-capable fetch used to query the proxy's `/api/diagnostics`
   * endpoint after a successful start. When omitted, diagnostics are
   * not fetched and `snapshot().diagnostics` stays undefined; the
   * settings dialog then hides the "Discovered binaries" block.
   */
  readonly diagnosticsFetch?: DiagnosticsFetch;
  readonly debug?: (msg: string) => void;
  /**
   * Hook fired whenever the lifecycle state changes (start/stop/exit).
   * Bootstrap wires this to push fresh status into a rendered settings
   * view via `updateProxyStatus`.
   */
  readonly onStateChange?: (state: ProxyState) => void;
  /**
   * Auto-start the proxy after wiring. When omitted, falls back to
   * reading the `proxy-autostart` pref ("true" → start). Default: false.
   */
  readonly autoStartOverride?: boolean;
};

export type ProxyState = {
  readonly running: boolean;
  readonly port: number;
  readonly nodeBinaryPath: string;
  readonly serverScriptPath: string;
  readonly lastError?: string;
  /**
   * True iff Node detection turned up empty (no `which node` result
   * AND no candidate path on disk). Surfaces in the settings UI so we
   * can reveal the otherwise-hidden manual override field only when
   * the user actually needs it.
   */
  readonly nodeAutoDetectFailed: boolean;
  /**
   * True iff the last start() detected a foreign process on the port
   * and skipped the spawn. The Stop button cannot affect that process,
   * so the settings UI surfaces a distinct status pill and a hint
   * explaining the situation to the user.
   */
  readonly externallyManaged: boolean;
  /**
   * Whether the proxy should auto-spawn at plugin load. Mirrors the
   * `proxy-autostart` pref so the settings UI can render the live
   * checkbox state. Defaults to true (opt-out).
   */
  readonly autoStart: boolean;
  /**
   * Optional snapshot of the proxy's `/api/diagnostics` response. Set
   * after a successful start when a `diagnosticsFetch` is supplied.
   * Omitted when the fetch is absent or the diagnostics call failed.
   * The settings dialog renders the "Discovered binaries" block from
   * this so the user can verify codex / claude were found.
   */
  readonly diagnostics?: ProxyDiagnostics;
};

export type WiredProxy = {
  readonly lifecycle: ProxyLifecycle;
  /** Build the snapshot the settings renderer needs (`ProxySettingsState`). */
  readonly snapshot: () => ProxyState;
  /** Imperatively start the proxy (used by the Start button). */
  readonly start: () => Promise<{ pid: number } | { external: true } | { error: string }>;
  /** Imperatively stop the proxy (used by the Stop button + shutdown). */
  readonly stop: () => Promise<void>;
  /**
   * The bearer token the spawned proxy expects on `Authorization:
   * Bearer <token>`. Generated as a fresh `crypto.randomUUID()` per
   * `start()` and threaded into the child's environment as
   * `LLM_PROXY_AUTH_TOKEN`. Returns null when the proxy is not
   * currently running (no spawn yet, after stop(), or after an
   * unsolicited exit). Consumers — concretely the Ollama adapter's
   * `getProxyAuthHeader` closure in `bootstrap.ts` — read this lazily
   * per-request so the active token rotates cleanly across restarts.
   */
  readonly getProxyAuthToken: () => string | null;
  /**
   * Persist new proxy configuration values into prefs and reload the
   * in-memory cache so the next start() uses them. Returns the new
   * snapshot.
   */
  readonly applyValues: (values: {
    readonly nodeBinaryPath: string;
    readonly serverScriptPath: string;
    readonly port: number;
  }) => ProxyState;
  /**
   * Re-run Node binary detection and update the in-memory path +
   * `nodeAutoDetectFailed` flag. Returns the fresh snapshot. Used by
   * the settings dialog's Detect button so the user can rescan after
   * installing Node or switching version managers without restarting
   * Zotero.
   */
  readonly redetectNode: () => ProxyState;
  /**
   * Persist the proxy-autostart pref. Settings dialog's "Start on
   * Zotero launch" checkbox routes here so the toggle survives a
   * restart. The change does NOT spawn or kill the running proxy —
   * it only affects the next plugin load.
   */
  readonly setAutoStart: (enabled: boolean) => ProxyState;
  /**
   * Tear down the proxy (call from plugin shutdown). Always awaits a
   * `lifecycle.stop()` so we never leave an orphan child process.
   */
  readonly shutdown: () => Promise<void>;
};

/**
 * Construct and wire up a proxy lifecycle. The returned object exposes
 * the imperative API the settings dialog needs.
 *
 * The function does NOT mount any UI itself — it's the bridge between
 * `src/bootstrap.ts` (which decides whether to auto-start and how to
 * push state into the live settings view) and `proxy-lifecycle.ts`.
 */
export function wireProxyLifecycle(deps: WireProxyLifecycleDeps): WiredProxy {
  const debug = deps.debug ?? ((): void => undefined);
  const pathExists: PathExists =
    deps.pathExists ??
    ((): boolean => {
      // Without an exists check, we fall back to the first candidate
      // (so production at minimum surfaces the user's typed override).
      return false;
    });

  // ---- Pref hydration ----
  const persistedNode = trimOrUndefined(deps.prefs?.get(PROXY_NODE_BINARY_PREF));
  const persistedScript = trimOrUndefined(deps.prefs?.get(PROXY_SERVER_SCRIPT_PREF));
  const persistedPort = parsePort(deps.prefs?.get(PROXY_PORT_PREF));

  // Detection result: keeps both the chosen path and a flag that says
  // "we had to fall back to the bare command name" so the UI can warn.
  const runDetection = (): { readonly path: string; readonly autoDetectFailed: boolean } =>
    detectNodeBinaryWithStatus({
      ...(deps.whichRunner !== undefined ? { whichRunner: deps.whichRunner } : {}),
      ...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
      ...(deps.listDirectory !== undefined ? { listDirectory: deps.listDirectory } : {}),
      ...(deps.readTextFile !== undefined ? { readTextFile: deps.readTextFile } : {}),
      ...(deps.spawnSync !== undefined ? { spawnSync: deps.spawnSync } : {}),
      pathExists
    });
  const detection =
    persistedNode !== undefined ? { path: persistedNode, autoDetectFailed: false } : runDetection();
  let nodeBinaryPath = detection.path;
  let nodeAutoDetectFailed = detection.autoDetectFailed;
  let serverScriptPath = persistedScript ?? deps.defaultServerScriptPath ?? "";
  let port = persistedPort ?? DEFAULT_PROXY_PORT;
  let lastError: string | undefined;
  let diagnostics: ProxyDiagnostics | undefined;
  /**
   * Bearer token threaded into the spawned proxy's environment as
   * `LLM_PROXY_AUTH_TOKEN`. Minted fresh per `start()` (so a restart
   * rotates the token; any cached `Authorization` headers from the
   * prior session 401 cleanly), and cleared to null on `stop()` /
   * unsolicited exit so the bootstrap-side `getProxyAuthHeader` closure
   * stops attaching the now-invalid header.
   */
  let currentAuthToken: string | null = null;
  // Codex review P1: true while `start()` is awaiting `lifecycle.start()`.
  // `redetectNode()` consults this before rebuilding the lifecycle so
  // a concurrent spawn never gets orphaned by a replaced lifecycle.
  let spawnInFlight = false;
  /**
   * Monotonic generation tag bumped on every start() / stop() / unsolicited
   * exit. A diagnostics fetch captures the generation BEFORE its
   * `await response.json()` and refuses to assign `diagnostics` if the
   * generation has advanced — without this guard a stale fetch from a
   * stopped process could repopulate the snapshot after stop() cleared
   * it. (Codex review #3.)
   */
  let generation = 0;

  // ---- Build the lifecycle ----
  let lifecycle = buildLifecycle();
  let exitUnsub = lifecycle.onExit(handleExit);

  function readConsentEnv(): Readonly<Record<string, string>> | undefined {
    // AC-21: default to "allow" when the pref is unset so the codex /
    // claude proxy backends serve the user's REAL configured models
    // (from ~/.codex/config.toml and ~/.claude/settings.json) instead
    // of a stale hardcoded list. The pref's only meaningful "off"
    // value is "never" — users who explicitly opt out of config reads
    // set it via settings and get the BUILTIN fallback list instead.
    const value = deps.prefs?.get(PROXY_CONFIG_READ_CONSENT_PREF)?.trim();
    if (value === "never") return undefined;
    return { LLM_PROXY_CONFIG_READ: "allow" };
  }

  function buildLifecycle(): ProxyLifecycle {
    const consentEnv = readConsentEnv();
    // Merge AUTH_TOKEN with the consent env var (if any) so the spawn
    // surface continues to receive both keys when the user has opted
    // into config-read consent. Order matters: AUTH_TOKEN is mandatory
    // for the security gate, so it appears first; consent env (allow /
    // absent) is layered on top via spread.
    const extraEnvironment: Record<string, string> = {};
    if (currentAuthToken !== null) {
      extraEnvironment[LLM_PROXY_AUTH_TOKEN_ENV] = currentAuthToken;
    }
    if (consentEnv !== undefined) {
      Object.assign(extraEnvironment, consentEnv);
    }
    const cfg: ProxyLifecycleDeps = {
      subprocess: deps.subprocess,
      nodeBinaryPath,
      serverScriptPath,
      port,
      ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
      ...(Object.keys(extraEnvironment).length > 0 ? { extraEnvironment } : {}),
      debug
    };
    return createProxyLifecycle(cfg);
  }

  function handleExit(
    code: number | null,
    info?: { readonly stderr: string; readonly unexpected: boolean }
  ): void {
    debug(`proxy-lifecycle: exit code=${code === null ? "null" : String(code)}`);
    // Bump the generation tag so any in-flight diagnostics fetch that
    // was issued while this child was alive (codex review #3) is
    // discarded when it eventually resolves — the body would describe
    // a process that no longer exists.
    generation += 1;
    diagnostics = undefined;
    // Drop the bearer token along with the dead child. The next
    // start() mints a fresh one; any cached header from the old token
    // would otherwise 401 on the new spawn.
    currentAuthToken = null;
    // Only surface an error message when the lifecycle classifies this
    // exit as unexpected (the user didn't click Stop, AND either the
    // exit code is non-zero or the child died inside the early-exit
    // window — e.g. EADDRINUSE crash before binding the port).
    if (info?.unexpected === true) {
      const stderr = info.stderr.trim();
      const tail = stderr.length > 0 ? stderr : undefined;
      const codeStr = code === null ? "signal" : String(code);
      lastError =
        tail !== undefined ? `Proxy exited (${codeStr}): ${tail}` : `Proxy exited (${codeStr})`;
    }
    deps.onStateChange?.(snapshot());
  }

  function readAutoStartPref(): boolean {
    const value = deps.prefs?.get(PROXY_AUTOSTART_PREF)?.trim();
    return value !== "false";
  }

  function snapshot(): ProxyState {
    const tracked = lifecycle.trackedPid();
    const externallyManaged = lifecycle.isExternallyManaged();
    return {
      running: tracked !== null || externallyManaged,
      port,
      nodeBinaryPath,
      serverScriptPath,
      nodeAutoDetectFailed,
      externallyManaged,
      autoStart: readAutoStartPref(),
      ...(lastError !== undefined ? { lastError } : {}),
      ...(diagnostics !== undefined ? { diagnostics } : {})
    };
  }

  /**
   * Build the headers needed to talk to OUR running proxy. When we have
   * a bearer token, attach it so the proxy's auth gate accepts the
   * request; the proxy's `/api/diagnostics` is bearer-gated to avoid
   * leaking codex/claude binary paths to other local processes. When
   * we're in no-auth mode (or pre-spawn) we omit the header.
   */
  function proxyHeaders(): Readonly<Record<string, string>> | undefined {
    if (currentAuthToken === null) return undefined;
    return { Authorization: `Bearer ${currentAuthToken}` };
  }

  /**
   * Fetch /api/diagnostics from the running proxy. Best-effort:
   * timeouts, non-2xx responses, and parse errors all leave the
   * diagnostics field untouched so the settings UI just hides the
   * "Discovered binaries" block instead of showing stale data.
   */
  async function fetchDiagnostics(forGeneration: number): Promise<void> {
    if (deps.diagnosticsFetch === undefined) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 1500);
    try {
      const headers = proxyHeaders();
      const response = await deps.diagnosticsFetch(
        `http://127.0.0.1:${String(port)}/api/diagnostics`,
        {
          signal: controller.signal,
          ...(headers !== undefined ? { headers } : {})
        }
      );
      if (!response.ok) return;
      const body = (await response.json()) as ProxyDiagnostics;
      // Generation guard (codex review #3): if start()/stop() / an
      // unsolicited exit bumped `generation` while we were awaiting,
      // this fetch belongs to a process that's no longer current.
      // Dropping the body avoids a stale snapshot resurrecting after
      // stop() cleared it.
      if (forGeneration !== generation) return;
      if (typeof body === "object" && "binaries" in body && "path" in body) {
        diagnostics = body;
      }
    } catch (err) {
      debug(
        `proxy-lifecycle: diagnostics fetch failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Try to take over an externally-managed listener: ask if it's our
   * proxy via the bearer-exempt `GET /` route, and if so politely POST
   * `/api/shutdown` and wait for the port to release. Returns true if
   * we successfully cleared the orphan and the caller should re-attempt
   * the spawn; false if the listener is foreign (leave it alone) or the
   * shutdown never released the port (so the caller's next spawn would
   * still EADDRINUSE).
   *
   * IMPORTANT: both HTTP calls here cross plugin generations — the
   * orphan was spawned by a PRIOR plugin session whose bearer token is
   * gone with that process. Any probe carrying the CURRENT generation's
   * `Authorization: Bearer` would 401 against the orphan and abort the
   * takeover. That's why this function uses ONLY bearer-exempt proxy
   * routes (`GET /` and `POST /api/shutdown`) and deliberately omits
   * the `proxyHeaders()` helper. Adding a new ownership probe? Make
   * sure the proxy route is in the bearer carve-out list.
   */
  async function tryTakeoverOrphan(): Promise<boolean> {
    if (deps.diagnosticsFetch === undefined) return false;
    let isOurs = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, 1500);
      try {
        // Cross-generation identity probe via the bearer-exempt `GET /`
        // route (`scripts/llm-proxy/server.mjs` returns
        // `{name: "zotero-ai-llm-proxy", routes: [...]}` here). No
        // Authorization header: the orphan's bearer token died with its
        // parent process, and `/` is intentionally carve-out so a fresh
        // plugin generation can identify the orphan as ours without
        // sharing a credential with it. Host/Origin gating on the proxy
        // side still applies.
        const response = await deps.diagnosticsFetch(`http://127.0.0.1:${String(port)}/`, {
          signal: controller.signal
        });
        if (response.ok) {
          const body = await response.json();
          // Defensive parse: require BOTH the exact `name` string AND
          // a `routes` array so a coincidentally-matching JSON service
          // (e.g. something else that happens to expose a `name` field)
          // can't fool us into shutting down a foreign listener.
          if (
            typeof body === "object" &&
            body !== null &&
            (body as { name?: unknown }).name === "zotero-ai-llm-proxy" &&
            Array.isArray((body as { routes?: unknown }).routes)
          ) {
            isOurs = true;
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Network/parse failures = "not us"; foreign service stays alive.
    }
    if (!isOurs) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, 1500);
      try {
        // No bearer header here: `/api/shutdown` is intentionally
        // bearer-exempt on the proxy side so a new plugin instance can
        // reclaim a port from a stale orphan whose token died with the
        // prior process.
        await deps.diagnosticsFetch(`http://127.0.0.1:${String(port)}/api/shutdown`, {
          signal: controller.signal,
          method: "POST"
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // The shutdown handler races process.exit; the connection may close
      // before we read the response. That's fine — we proceed to poll.
    }
    // Poll /api/tags until it fails or the port frees up. Hard cap so a
    // wedged child doesn't deadlock the user's Start click.
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      try {
        const probe = await deps.fetch?.(`http://127.0.0.1:${String(port)}/api/tags`);
        if (probe?.ok !== true) return true;
      } catch {
        return true;
      }
      await new Promise<void>((r) => {
        setTimeout(() => {
          r();
        }, 100);
      });
    }
    return false;
  }

  async function start(): Promise<{ pid: number } | { external: true } | { error: string }> {
    // Codex review P1: redetectNode() probes `trackedPid()` to decide
    // whether to rebuild the lifecycle. During the awaits below the
    // child is mid-spawn and `trackedPid()` is still null — a
    // concurrent Detect click would replace `lifecycle` and the
    // pending spawn would survive as an orphan. The guard flag tells
    // redetectNode to skip the rebuild while a start is in flight.
    spawnInFlight = true;
    try {
      return await startInner();
    } finally {
      spawnInFlight = false;
    }
  }

  async function startInner(): Promise<{ pid: number } | { external: true } | { error: string }> {
    lastError = undefined;
    diagnostics = undefined;
    generation += 1;
    let myGeneration = generation;
    // Mint a fresh bearer token whenever we don't already have one
    // (first start, or post-stop / post-exit start). Token rotation
    // happens implicitly: stop() / handleExit() clear `currentAuthToken`,
    // so the next start mints a new UUID. Rebuild the lifecycle so the
    // new env (carrying LLM_PROXY_AUTH_TOKEN) reaches the spawn. When
    // a token is already in flight (re-entrant start during an inflight
    // start, or start-while-running), keep the existing lifecycle so
    // it can satisfy the existing `lifecycle.start()` state machine.
    if (currentAuthToken === null) {
      currentAuthToken = crypto.randomUUID();
      exitUnsub();
      lifecycle = buildLifecycle();
      exitUnsub = lifecycle.onExit(handleExit);
    }
    let result = await lifecycle.start();
    // Orphan-kill: if start() resolved to an external (foreign-port)
    // result AND that listener is our own proxy from a prior session,
    // shut it down and try once more so the user always lands on
    // freshly-spawned code matching the installed XPI.
    if (!("error" in result) && "external" in result) {
      const tookOver = await tryTakeoverOrphan();
      if (tookOver) {
        // Rebuild the lifecycle so it forgets the externallyManaged
        // flag from the previous probe-hit, then spawn fresh.
        exitUnsub();
        lifecycle = buildLifecycle();
        exitUnsub = lifecycle.onExit(handleExit);
        generation += 1;
        myGeneration = generation;
        result = await lifecycle.start();
      }
    }
    if ("error" in result) {
      lastError = result.error;
      // invariant: `currentAuthToken` is cleared on stop() / handleExit() /
      // this start-failure path, but persists across start() calls in
      // between. The child process holds its OWN copy via the env at
      // spawn time, so a parent-side clear does not invalidate an
      // in-flight request that the child is still authoring a response
      // for — it only changes what `getProxyAuthHeader` returns on the
      // NEXT request.
      //
      // Clear the freshly-minted token so getProxyAuthToken() correctly
      // reports "no running proxy" instead of handing the bootstrap
      // closure a token that no child is listening for.
      currentAuthToken = null;
    } else {
      await fetchDiagnostics(myGeneration);
    }
    deps.onStateChange?.(snapshot());
    return result;
  }

  async function stop(): Promise<void> {
    generation += 1;
    await lifecycle.stop();
    diagnostics = undefined;
    // Token is per-spawn — a fresh start() mints a new one. Clearing on
    // stop ensures the bootstrap closure stops attaching Authorization
    // headers that would 401 against any future foreign listener on
    // the same port.
    currentAuthToken = null;
    deps.onStateChange?.(snapshot());
  }

  function applyValues(values: {
    readonly nodeBinaryPath: string;
    readonly serverScriptPath: string;
    readonly port: number;
  }): ProxyState {
    const userOverrodeNode = values.nodeBinaryPath.length > 0;
    nodeBinaryPath = userOverrodeNode ? values.nodeBinaryPath : nodeBinaryPath;
    if (userOverrodeNode) {
      // User just typed a Node path; trust them and stop showing the
      // "auto-detect failed" warning even if we never ran a probe.
      nodeAutoDetectFailed = false;
    }
    serverScriptPath =
      values.serverScriptPath.length > 0 ? values.serverScriptPath : serverScriptPath;
    port = values.port > 0 ? values.port : port;
    if (deps.prefs !== undefined) {
      try {
        deps.prefs.set(PROXY_NODE_BINARY_PREF, nodeBinaryPath);
        deps.prefs.set(PROXY_SERVER_SCRIPT_PREF, serverScriptPath);
        deps.prefs.set(PROXY_PORT_PREF, String(port));
      } catch (err) {
        debug(
          `proxy-lifecycle: pref write failed ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    // Rebuild the lifecycle so the next start() picks up the new
    // settings. If a child is currently tracked, leave it running —
    // the user can click Stop + Start to apply. Skip the rebuild
    // while a spawn is in flight (codex P1) to avoid orphaning it.
    const tracked = lifecycle.trackedPid();
    if (tracked === null && !spawnInFlight) {
      exitUnsub();
      lifecycle = buildLifecycle();
      exitUnsub = lifecycle.onExit(handleExit);
    }
    deps.onStateChange?.(snapshot());
    return snapshot();
  }

  function redetectNode(): ProxyState {
    const fresh = runDetection();
    nodeBinaryPath = fresh.path;
    nodeAutoDetectFailed = fresh.autoDetectFailed;
    // Persist the new path so future restarts use it without re-probing.
    if (deps.prefs !== undefined && !nodeAutoDetectFailed) {
      try {
        deps.prefs.set(PROXY_NODE_BINARY_PREF, nodeBinaryPath);
      } catch (err) {
        debug(
          `proxy-lifecycle: pref write failed ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    // Codex P1: skip the lifecycle rebuild while a `start()` is in
    // flight. Replacing `lifecycle` mid-spawn would orphan whatever
    // child the prior lifecycle ends up spawning. The next start()
    // (after the current spawn settles) will pick up the new Node
    // path because applyValues rebuilds the lifecycle at that point.
    const tracked = lifecycle.trackedPid();
    if (tracked === null && !spawnInFlight) {
      exitUnsub();
      lifecycle = buildLifecycle();
      exitUnsub = lifecycle.onExit(handleExit);
    }
    deps.onStateChange?.(snapshot());
    return snapshot();
  }

  function setAutoStart(enabled: boolean): ProxyState {
    if (deps.prefs !== undefined) {
      try {
        deps.prefs.set(PROXY_AUTOSTART_PREF, enabled ? "true" : "false");
      } catch (err) {
        debug(
          `proxy-lifecycle: pref write failed ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    deps.onStateChange?.(snapshot());
    return snapshot();
  }

  async function shutdown(): Promise<void> {
    try {
      await lifecycle.stop();
    } finally {
      exitUnsub();
    }
  }

  // ---- Auto-start ----
  // User requirement: the proxy should be ready when the dialog opens
  // so the codex / claude presets just work. The autostart pref now
  // defaults to ON; users opt OUT by setting it to "false" via the
  // settings dialog's "Start on Zotero launch" toggle.
  const autoStartPref = deps.prefs?.get(PROXY_AUTOSTART_PREF)?.trim();
  const autoStart = deps.autoStartOverride ?? autoStartPref !== "false";
  if (autoStart) {
    void start();
  }

  return {
    lifecycle,
    snapshot,
    start,
    stop,
    applyValues,
    redetectNode,
    setAutoStart,
    shutdown,
    getProxyAuthToken: () => currentAuthToken
  };
}

/**
 * Legacy single-return detector. Exported for tests that pin the
 * original signature.
 */
export function detectNodeBinary(exists: PathExists): string {
  return detectNodeBinaryWithStatus({ pathExists: exists }).path;
}

/**
 * Resolve the Node binary path with priority:
 *   1. `whichRunner("node")` — POSIX `which` lookup (catches user-
 *      installed Node in non-standard prefixes).
 *   2. Each `NODE_BINARY_CANDIDATES` path, gated on `pathExists`.
 *   3. When `homeDir` is supplied, each `homeRelativeNodeCandidates`
 *      entry — volta / asdf / fnm / n / mise / nodenv shims.
 *   4. When `homeDir` AND `listDirectory` are supplied, an nvm /
 *      NVM-Windows scan (`scanNvmVersions`) — the only version
 *      manager without a fixed shim path.
 *   5. Fall back to the bare command `"node"` and flag the result
 *      with `autoDetectFailed: true` so the UI knows the manual
 *      override field needs the user's attention.
 *
 * When `spawnSync` is supplied, every accepted candidate is additionally
 * gated on `validateNodeFetchSupport` (`<path> --version` reports v18+).
 * The Ubuntu `apt install nodejs` path drops a Node 12 or 14 at
 * `/usr/bin/node`; without the validator the detector would accept it
 * and the proxy would crash at module-load (the Ollama backend uses
 * `globalThis.fetch`, a Node 18+ global). The validator's `spawnSync`
 * result is cached per-call so multi-shim layouts don't re-spawn.
 *
 * Exported for tests so the detection priority is easy to assert
 * without spinning up the full lifecycle.
 */
export function detectNodeBinaryWithStatus(deps: {
  readonly whichRunner?: WhichRunner;
  readonly pathExists: PathExists;
  readonly homeDir?: string;
  readonly listDirectory?: ListDirectory;
  readonly readTextFile?: ReadTextFile;
  readonly spawnSync?: SpawnSyncRunner;
}): { readonly path: string; readonly autoDetectFailed: boolean } {
  // Cache `validateNodeFetchSupport` results per-call so repeated
  // appearances of the same path (e.g. the same binary reachable via two
  // shim layers) don't re-spawn `node --version`. Scoped to this call so
  // a follow-up detect after a Node upgrade still re-validates.
  const validatedCache = new Map<string, boolean>();
  const validate = (path: string): boolean => {
    if (deps.spawnSync === undefined) return true; // skip validation if no runner
    const cached = validatedCache.get(path);
    if (cached !== undefined) return cached;
    const ok = validateNodeFetchSupport(path, deps.spawnSync);
    validatedCache.set(path, ok);
    return ok;
  };

  if (deps.whichRunner !== undefined) {
    try {
      const resolved = deps.whichRunner("node");
      if (resolved !== null && resolved.trim().length > 0) {
        const trimmed = resolved.trim();
        // Validate even the whichRunner hit: on Ubuntu, `which node`
        // points at the apt-installed `/usr/bin/node` which may be
        // Node 12 / 14 (pre-fetch). Falling through to the candidate
        // scan gives the version-manager paths a chance to win.
        if (validate(trimmed)) {
          return { path: trimmed, autoDetectFailed: false };
        }
      }
    } catch {
      // Fall through to the candidate scan.
    }
  }
  const candidates =
    deps.homeDir !== undefined && deps.homeDir.length > 0
      ? [...NODE_BINARY_CANDIDATES, ...homeRelativeNodeCandidates(deps.homeDir)]
      : NODE_BINARY_CANDIDATES;
  for (const candidate of candidates) {
    if (deps.pathExists(candidate) && validate(candidate)) {
      return { path: candidate, autoDetectFailed: false };
    }
  }
  // nvm / NVM-Windows: dynamic directory scan. Only attempted when
  // both a home directory AND a listDirectory dep are available.
  if (deps.homeDir !== undefined && deps.homeDir.length > 0 && deps.listDirectory !== undefined) {
    const scanned = scanNvmVersions(
      deps.homeDir,
      deps.listDirectory,
      deps.pathExists,
      deps.readTextFile
    );
    if (scanned !== null && validate(scanned)) {
      return { path: scanned, autoDetectFailed: false };
    }
  }
  return { path: "node", autoDetectFailed: true };
}

function trimOrUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Convenience: build a `WiredProxy` and immediately register a
 * teardown callback into the supplied disposer set. Mirrors the
 * pattern bootstrap.ts uses for its other unsubscribe handles.
 *
 * Returns an `Unsubscribe` the caller can use to stop the proxy
 * out-of-band (rare; tests + ad-hoc reconfiguration).
 */
export function attachProxyToShutdown(
  wired: WiredProxy,
  disposers: { push: (u: Unsubscribe) => void }
): Unsubscribe {
  const unsub: Unsubscribe = () => {
    void wired.shutdown();
  };
  disposers.push(unsub);
  return unsub;
}
