/**
 * Codex CLI backend for the Ollama-compatible LLM proxy.
 *
 * Translates an Ollama `/api/chat` request into a `codex exec --json` (first
 * turn) or `codex exec resume <SESSION_ID>` (subsequent turn) invocation, then
 * streams Codex's stdout back to the caller as Ollama-format NDJSON delta
 * objects.
 *
 * Multi-turn correlation
 * ----------------------
 * Codex sessions are file-backed. Each session has a `session_id` that the CLI
 * emits in its `--json` event stream. The proxy keeps an in-memory
 * `Map<conversationKey, sessionId>` where `conversationKey` is derived from
 * the SHA-256 of the first user message in the incoming `messages[]` array
 * (truncated to 16 hex chars). This is stable for the duration of the proxy
 * process — a restart drops resume state, which is acceptable because the
 * plugin can always start a fresh conversation.
 *
 * Session ID discovery (defensive)
 * --------------------------------
 * The exact JSON event shape from `codex exec --json` evolves between
 * releases. To stay robust we:
 *
 * 1. Parse every stdout line as JSON; for each object we recursively walk all
 *    keys looking for `session_id` and accept the first hit (covers both
 *    top-level `{"type":"session_configured","session_id":"..."}` and nested
 *    shapes like `{"msg":{"session_id":"..."}}`).
 * 2. If stdout does not expose a session_id by the time the child exits, we
 *    fall back to scanning `~/.codex/sessions/**` for the newest `.jsonl`
 *    file modified after the spawn began, and extract the session_id from
 *    its filename (codex's documented rollout filename is
 *    `rollout-<TIMESTAMP>-<SESSION_ID>.jsonl`) or first JSONL line.
 *
 * The result record documents the actual mechanism observed on the user's
 * machine; this module supports either.
 */

import { spawn as defaultSpawn } from "node:child_process";
import { promises as fs, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_HARD_TIMEOUT_MS = 300_000;

/**
 * Build the user-facing error string for a non-zero exit. Distinguishes:
 *
 *   - ENOENT (binary missing) — most common Mac failure mode: the GUI-
 *     app PATH doesn't include /opt/homebrew/bin so spawn('codex')
 *     errors out before the child even runs.
 *   - EACCES (binary not executable) — typically a permissions glitch
 *     from an interrupted install.
 *   - Any other spawn error — reported verbatim from the OS.
 *   - Non-spawn exit with stderr — surface the stderr tail as-is.
 *   - Non-zero exit with no stderr — surface "exited with code N" with
 *     the resolved command so the user knows which binary it was.
 *
 * Exported for unit tests; not part of the backend's runtime API.
 */
export function describeCodexFailure({ spawnError, stderr, exitCode, codexCommand }) {
  if (spawnError !== null && spawnError !== undefined) {
    const code = typeof spawnError.code === "string" ? spawnError.code : null;
    if (code === "ENOENT") {
      return (
        `codex CLI not found at "${codexCommand}". ` +
        `Install with \`brew install codex-cli\` or \`npm i -g @openai/codex\`, ` +
        `or set the PROXY_CODEX_BIN environment variable to its absolute path.`
      );
    }
    if (code === "EACCES") {
      return (
        `codex CLI at "${codexCommand}" is not executable (EACCES). ` +
        `Run \`chmod +x ${codexCommand}\` or reinstall.`
      );
    }
    const detail = typeof spawnError.message === "string" ? spawnError.message : String(spawnError);
    return `codex CLI failed to spawn (${code ?? "unknown"}): ${detail}`;
  }
  if (stderr.length > 0) return stderr;
  return `codex exited with code ${String(exitCode)} (command: ${codexCommand}).`;
}

/**
 * Tags returned for /codex/api/tags. Kept identifier-only — Zotero only reads
 * `name`. Codex CLI accepts any model name via `--model`, so this list is just
 * the dropdown's discovery hint. The user's actual model is whatever's in
 * `~/.codex/config.toml`; a future iteration will read it with user consent.
 * Order matters: the first entry is the dropdown's default.
 *
 * Extend at proxy startup via env: `CODEX_TAGS_EXTRA=gpt-5.5,gpt-6.0`.
 */
const BUILTIN_CODEX_TAGS = [
  "gpt-5.5",
  "gpt-5.5-codex",
  "gpt-5.4",
  "gpt-5.2-codex",
  "gpt-5.2",
  "o4",
  "o4-mini"
];
function readEnvExtraTags() {
  const raw = process.env.CODEX_TAGS_EXTRA;
  if (typeof raw !== "string" || raw.length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Minimal TOML key/table scanner — we only need to surface model names,
 * so we deliberately avoid pulling in a full TOML parser (Node built-ins
 * only; the proxy ships inside the XPI). The scanner walks line-by-line,
 * tracks the current `[section]` header, and picks out:
 *
 *   - `model = "name"` (any string-quoted assignment) at the top level
 *   - every key in the `[tui.model_availability_nux]` table (the keys
 *     ARE the model names per codex's docs)
 *   - every source key in `[notice.model_migrations]` (codex publishes
 *     deprecated → new mappings keyed by old model name)
 *
 * Returns an array of unique trimmed names in encounter order.
 * Exported so tests can assert against a fixture without spinning up the
 * full backend.
 */
export function parseCodexConfigTomlForModels(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  let currentSection = "";
  const lines = text.split(/\r?\n/u);
  for (const rawLine of lines) {
    // Strip inline comments (TOML uses `#`; ignore `#` inside quotes by
    // simple split — we only need correct-enough behaviour for model
    // identifiers, which never contain `#`).
    let line = rawLine;
    const hash = line.indexOf("#");
    if (hash >= 0) line = line.slice(0, hash);
    line = line.trim();
    if (line.length === 0) continue;
    // Section header.
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line);
    if (sectionMatch && sectionMatch[1] !== undefined) {
      currentSection = sectionMatch[1].trim();
      continue;
    }
    // Assignment: <key> = <value>. Value may be quoted (string) or bare.
    const assignMatch = /^([^=\s]+)\s*=\s*(.+)$/u.exec(line);
    if (assignMatch === null) continue;
    const key = assignMatch[1]?.trim() ?? "";
    const valueRaw = assignMatch[2]?.trim() ?? "";
    // Strip wrapping quotes.
    const stringMatch = /^"([^"]*)"$/u.exec(valueRaw);
    const stringValue = stringMatch ? stringMatch[1] : null;
    // Rule 1: top-level `model = "..."`.
    if (currentSection === "" && key === "model" && stringValue !== null) {
      push(stringValue);
      continue;
    }
    // Rule 2: every key inside `tui.model_availability_nux` is a model
    // name (the value is a metadata blob we don't care about).
    if (currentSection === "tui.model_availability_nux") {
      // Strip surrounding quotes from keys in case they're quoted.
      const k = key.replace(/^"|"$/gu, "");
      push(k);
      continue;
    }
    // Rule 3: source keys in `notice.model_migrations`. The value is
    // the replacement; we surface both so the dropdown can offer
    // either name during the deprecation window.
    if (currentSection === "notice.model_migrations") {
      const k = key.replace(/^"|"$/gu, "");
      push(k);
      if (stringValue !== null) push(stringValue);
      continue;
    }
  }
  return out;
}

/**
 * Read `~/.codex/config.toml` (or the path the caller supplies) and
 * return the model names referenced inside it. Returns `[]` when:
 *   - the file is absent
 *   - the file is unreadable (permission denied, etc.)
 *   - parsing finds no model strings
 *
 * Gated behind `LLM_PROXY_CONFIG_READ=allow` at the call site (the
 * `tags()` helper checks the env var); pass `force: true` from a test
 * to bypass the env gate.
 *
 * The argument is an options bag so the test suite can inject a fake
 * fs / config path without monkey-patching the module globals.
 */
export function readDiscoveredCodexModels(opts = {}) {
  const allow = opts.force === true || process.env.LLM_PROXY_CONFIG_READ === "allow";
  if (!allow) return [];
  const configPath = opts.configPath ?? join(homedir(), ".codex", "config.toml");
  const exists = opts.existsSync ?? existsSync;
  const read = opts.readFileSync ?? readFileSync;
  try {
    if (!exists(configPath)) return [];
    const raw = read(configPath, "utf8");
    return parseCodexConfigTomlForModels(raw);
  } catch {
    // Missing file, parse error, permission denied — silently return
    // the empty list so the dropdown still shows the builtin defaults.
    return [];
  }
}

/**
 * Build the merged tag list. Order:
 *   1. Discovered (live `~/.codex/config.toml` reads, gated by env)
 *   2. Env-supplied extras (`CODEX_TAGS_EXTRA=foo,bar`)
 *   3. Hardcoded `BUILTIN_CODEX_TAGS` defaults
 * Deduplication preserves first-occurrence ordering so the user's
 * configured `model = "..."` appears at the top of the dropdown.
 */
function buildMergedTags(opts = {}) {
  const seen = new Set();
  const merged = [];
  const sources = [readDiscoveredCodexModels(opts), readEnvExtraTags(), BUILTIN_CODEX_TAGS];
  for (const list of sources) {
    for (const name of list) {
      if (typeof name !== "string") continue;
      const trimmed = name.trim();
      if (trimmed.length === 0 || seen.has(trimmed)) continue;
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }
  return merged;
}

const DEFAULT_CODEX_TAGS = buildMergedTags();

function conversationKeyFromMessages(messages) {
  const firstUser = Array.isArray(messages)
    ? messages.find((m) => m && m.role === "user" && typeof m.content === "string")
    : null;
  const seed = firstUser ? firstUser.content : "";
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

function latestUserContent(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user" && typeof m.content === "string") return m.content;
  }
  // Fallback: concatenate everything if no user role is present.
  return messages
    .map((m) => (m && typeof m.content === "string" ? m.content : ""))
    .filter((s) => s.length > 0)
    .join("\n");
}

/**
 * Recursively search a parsed JSON object for the codex CLI conversation
 * id. Codex's event schema named this `session_id` in earlier releases
 * and `thread_id` in the current release (the in-process artefact is a
 * "thread" — `codex exec resume` accepts the same UUID per its help
 * text: "Conversation/session id (UUID) or thread name"). We accept
 * either field name so the proxy survives the rename without losing
 * multi-turn resume.
 */
function findSessionId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const hit = findSessionId(entry);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, val] of Object.entries(value)) {
    if (
      (key === "session_id" || key === "thread_id") &&
      typeof val === "string" &&
      val.length > 0
    ) {
      return val;
    }
    const hit = findSessionId(val);
    if (hit) return hit;
  }
  return null;
}

/**
 * Event types whose payload is internal to codex's reasoning loop and
 * must never surface as assistant content. Centralised so every text-
 * extracting branch consults the same denylist — preventing the
 * "command_execution event with a top-level `delta` field" bypass that
 * an earlier per-branch denylist missed.
 */
const NON_ASSISTANT_EVENT_TYPES = new Set([
  "command_execution",
  "reasoning",
  "user_message",
  "system_message",
  "user_input",
  "thread.started",
  "turn.started",
  "turn.completed"
]);

/** Extract an assistant text fragment from a codex JSON event, if any. */
export function extractDeltaText(event) {
  if (!event || typeof event !== "object") return null;
  // Shapes observed across codex CLI versions:
  //   legacy: {type:"agent_message_delta",delta:"..."} | {type:"agent_message",message:"..."} | nested under `msg` | {content:[{type:"text",text}]}
  //   current: {type:"item.completed",item:{type:"agent_message",text:"..."}} (or item.delta with item.delta)
  // Tool-call and framing events carry text fields that are internal —
  // any of those reaching the popup would dump shell output / reasoning
  // into the user's explanation.
  const msg = event.msg && typeof event.msg === "object" ? event.msg : event;
  const t = typeof msg.type === "string" ? msg.type : null;
  if (t !== null && NON_ASSISTANT_EVENT_TYPES.has(t)) return null;

  if ((t === "item.completed" || t === "item.delta") && msg.item && typeof msg.item === "object") {
    const item = msg.item;
    if (item.type !== "agent_message") return null;
    if (typeof item.text === "string" && item.text.length > 0) return item.text;
    if (typeof item.delta === "string" && item.delta.length > 0) return item.delta;
    return null;
  }

  if (typeof msg.delta === "string" && msg.delta.length > 0) return msg.delta;
  if (typeof msg.message === "string" && msg.message.length > 0) return msg.message;
  if (typeof msg.text === "string" && msg.text.length > 0) return msg.text;
  if (Array.isArray(msg.content)) {
    const parts = msg.content
      .filter((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text);
    if (parts.length > 0) return parts.join("");
  }
  return null;
}

async function readSessionIdFromDisk(spawnStartedAtMs, fsImpl, sessionsDir) {
  try {
    const newest = await findNewestJsonlSince(sessionsDir, spawnStartedAtMs, fsImpl);
    if (!newest) return null;
    // Filename convention: rollout-<TS>-<UUID>.jsonl. Strip prefix/extension.
    const base = newest.path.split("/").pop() ?? "";
    const match = /^rollout-[^-]+(?:-[^-]+)*-([0-9a-fA-F-]{8,})\.jsonl$/.exec(base);
    if (match && match[1]) return match[1];
    // Fallback: parse first line for a session_id field.
    try {
      const raw = await fsImpl.readFile(newest.path, "utf8");
      const firstLine = raw.split("\n").find((l) => l.trim().length > 0);
      if (firstLine) {
        try {
          const parsed = JSON.parse(firstLine);
          const id = findSessionId(parsed);
          if (id) return id;
        } catch {
          // not JSON; ignore
        }
      }
    } catch {
      // unreadable; ignore
    }
    return null;
  } catch {
    return null;
  }
}

async function findNewestJsonlSince(root, sinceMs, fsImpl) {
  let newest = null;
  async function walk(dir) {
    let entries;
    try {
      entries = await fsImpl.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = await fsImpl.stat(full);
          const mtime = stat.mtimeMs;
          if (mtime >= sinceMs && (newest === null || mtime > newest.mtime)) {
            newest = { path: full, mtime };
          }
        } catch {
          // ignore
        }
      }
    }
  }
  await walk(root);
  return newest;
}

/**
 * Build the argv passed to `codex exec`.
 * - First turn:  ["exec", "--json", "--skip-git-repo-check", "-"]   (prompt via stdin)
 * - Resume:      ["exec", "resume", <SESSION_ID>, "--json", "--skip-git-repo-check", "-"]
 */
export function buildCodexArgs({ sessionId, model }) {
  const base = ["exec"];
  if (sessionId) base.push("resume", sessionId);
  base.push("--json", "--skip-git-repo-check");
  if (model) base.push("--model", model);
  base.push("-");
  return base;
}

/**
 * Create a codex backend handler.
 *
 * @param {object} [deps]
 * @param {(cmd: string, args: string[], opts?: object) => any} [deps.spawn]
 * @param {typeof import("node:fs").promises} [deps.fs]
 * @param {string} [deps.codexCommand]      default "codex"
 * @param {string} [deps.sessionsDir]       default `${HOME}/.codex/sessions`
 * @param {string} [deps.defaultModel]
 * @param {number} [deps.idleTimeoutMs]
 * @param {number} [deps.hardTimeoutMs]
 * @param {number} [deps.sigkillGraceMs]  default 3000; ms after SIGTERM before SIGKILL escalation
 * @param {() => number} [deps.now]
 * @param {Map<string,string>} [deps.sessionMap]  inject for tests
 */
export function createCodexBackend(deps = {}) {
  const spawn = deps.spawn ?? defaultSpawn;
  const fsImpl = deps.fs ?? fs;
  const codexCommand = deps.codexCommand ?? "codex";
  const sessionsDir = deps.sessionsDir ?? join(homedir(), ".codex", "sessions");
  const defaultModel = deps.defaultModel ?? DEFAULT_MODEL;
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const hardTimeoutMs = deps.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS;
  const sigkillGraceMs = deps.sigkillGraceMs ?? 3000;
  const now = deps.now ?? (() => Date.now());
  const sessionMap = deps.sessionMap ?? new Map();
  // Hooks for the live-config discovery path; injected by tests.
  const configDiscoveryOpts = {
    ...(deps.configPath !== undefined ? { configPath: deps.configPath } : {}),
    ...(deps.existsSync !== undefined ? { existsSync: deps.existsSync } : {}),
    ...(deps.readFileSync !== undefined ? { readFileSync: deps.readFileSync } : {}),
    ...(deps.forceConfigRead === true ? { force: true } : {})
  };

  function tags() {
    // Rebuild on every call so the env var / config file can change
    // between requests without restarting the proxy. Cost is one stat()
    // per call, which is negligible against the network latency of a
    // tag fetch.
    const names = buildMergedTags(configDiscoveryOpts);
    return names.map((name) => ({
      name,
      model: name,
      modified_at: new Date(0).toISOString(),
      size: 0
    }));
  }

  /**
   * Run one turn against codex.
   *
   * @param {object} args
   * @param {ReadonlyArray<{role:string,content:string}>} args.messages
   * @param {string} [args.model]
   * @param {(chunk: {message?:{role:"assistant",content:string}, done:boolean, done_reason?:string, error?:string, model:string, created_at:string}) => void} args.onEvent
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<{exitCode:number, sessionId:string|null, fullText:string}>}
   */
  async function runTurn(args) {
    const { messages, onEvent } = args;
    const requestedModel = args.model || defaultModel;
    const key = conversationKeyFromMessages(messages);
    const isFirstTurn = !sessionMap.has(key) || messages.length <= 1;
    const sessionId = isFirstTurn ? null : sessionMap.get(key);
    const argv = buildCodexArgs({ sessionId: sessionId ?? null, model: requestedModel });
    const prompt = latestUserContent(messages);
    const spawnStartedAtMs = now();

    const child = spawn(codexCommand, argv, {
      stdio: ["pipe", "pipe", "pipe"]
    });

    // Pipe the prompt in via stdin.
    if (child.stdin) {
      try {
        child.stdin.write(prompt);
        child.stdin.end();
      } catch {
        // child may have died before stdin was usable; surfaced via exit handling
      }
    }

    const createdAt = new Date().toISOString();
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let fullText = "";
    let discoveredSessionId = sessionId;
    let lastActivity = now();
    let aborted = false;
    let idleTimer = null;
    let hardTimer = null;
    // AC-12: spawn-timing MEASUREMENT (not a behaviour change). `codex
    // exec` has no daemon/persistent-process mode — every turn pays a
    // fresh process spawn + CLI init — so AC-12 makes the spawn-vs-
    // inference split an observable fact in the proxy logs rather than
    // attempting an unbuildable "warm daemon". `firstDeltaLogged` gates
    // the spawn→first-delta line to the FIRST streamed delta only.
    let firstDeltaLogged = false;

    function emitDelta(text) {
      if (!text) return;
      if (!firstDeltaLogged) {
        firstDeltaLogged = true;
        console.error(`codex-backend: spawn→first-delta ${String(now() - spawnStartedAtMs)}ms`);
      }
      fullText += text;
      onEvent({
        model: requestedModel,
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: text },
        done: false
      });
    }

    function handleStdoutChunk(chunk) {
      lastActivity = now();
      stdoutBuffer += chunk.toString("utf8");
      let from = 0;
      while (true) {
        const nl = stdoutBuffer.indexOf("\n", from);
        if (nl === -1) break;
        const line = stdoutBuffer.slice(from, nl).trim();
        from = nl + 1;
        if (line.length === 0) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          // Codex sometimes prints non-JSON banner text. Treat such lines as
          // raw text deltas so the user still sees them.
          emitDelta(line);
          continue;
        }
        if (!discoveredSessionId) {
          const found = findSessionId(event);
          if (found) discoveredSessionId = found;
        }
        const delta = extractDeltaText(event);
        if (delta) emitDelta(delta);
        // task_complete is informational; final done is emitted on child exit
        // (so non-zero exits surface as errors rather than premature success).
      }
      stdoutBuffer = stdoutBuffer.slice(from);
    }

    function handleStderrChunk(chunk) {
      lastActivity = now();
      stderrBuffer += chunk.toString("utf8");
    }

    function killChild() {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      // M8 (Phase 4b codex review): SIGTERM grace + SIGKILL fallback.
      // Without this, a codex CLI that ignores SIGTERM (or is wedged
      // inside a child syscall) hangs the request indefinitely despite
      // the idle/hard timeout firing. Matches the 3s grace used by
      // src/platform/proxy-lifecycle.ts so user-perceived deadline is
      // consistent across the spawn/timeout paths. Tests override the
      // grace to 0 so the escalation fires immediately.
      const sigkillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // child already exited — nothing to escalate to
        }
      }, sigkillGraceMs);
      sigkillTimer.unref?.();
    }

    if (child.stdout) child.stdout.on("data", handleStdoutChunk);
    if (child.stderr) child.stderr.on("data", handleStderrChunk);

    // Capture the spawn error (ENOENT, EACCES) so we can distinguish
    // "binary not found / not executable" from "binary ran and crashed".
    // Without this, both surfaced as a generic exit code -1 sentinel
    // and the user just saw "codex exited with code -1" — actively
    // hostile because the real cause (codex isn't on PATH) is invisible.
    let spawnError = null;
    const exitPromise = new Promise((resolve) => {
      child.on("close", (code) => resolve(typeof code === "number" ? code : -1));
      child.on("error", (err) => {
        spawnError = err;
        resolve(-1);
      });
    });

    // Hard timeout: kill the child after hardTimeoutMs regardless of activity.
    if (hardTimeoutMs > 0) {
      hardTimer = setTimeout(() => {
        aborted = true;
        killChild();
      }, hardTimeoutMs);
    }

    // Idle timeout: check periodically that we've seen recent activity.
    if (idleTimeoutMs > 0) {
      const tick = Math.max(250, Math.floor(idleTimeoutMs / 4));
      idleTimer = setInterval(() => {
        if (now() - lastActivity >= idleTimeoutMs) {
          aborted = true;
          killChild();
        }
      }, tick);
    }

    if (args.signal) {
      if (args.signal.aborted) {
        aborted = true;
        killChild();
      } else {
        args.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            killChild();
          },
          { once: true }
        );
      }
    }

    const exitCode = await exitPromise;
    if (idleTimer) clearInterval(idleTimer);
    if (hardTimer) clearTimeout(hardTimer);
    // AC-12: spawn→close measurement — the full per-turn process
    // lifetime. Paired with the spawn→first-delta line above this makes
    // the spawn-vs-inference latency split observable in proxy logs.
    console.error(`codex-backend: spawn→close ${String(now() - spawnStartedAtMs)}ms`);

    // Drain any trailing partial line in case codex did not terminate with \n.
    if (stdoutBuffer.trim().length > 0) {
      const trailing = stdoutBuffer.trim();
      try {
        const event = JSON.parse(trailing);
        if (!discoveredSessionId) {
          const found = findSessionId(event);
          if (found) discoveredSessionId = found;
        }
        const delta = extractDeltaText(event);
        if (delta) emitDelta(delta);
      } catch {
        emitDelta(trailing);
      }
      stdoutBuffer = "";
    }

    // Session-id fallback: scan disk if codex did not surface one in stdout.
    if (!discoveredSessionId) {
      const fromDisk = await readSessionIdFromDisk(spawnStartedAtMs, fsImpl, sessionsDir);
      if (fromDisk) discoveredSessionId = fromDisk;
    }

    if (discoveredSessionId) sessionMap.set(key, discoveredSessionId);

    if (exitCode !== 0) {
      const stderr = stderrBuffer.slice(0, 500).trim();
      const reason = aborted ? "timeout" : "error";
      const detail = describeCodexFailure({
        spawnError,
        stderr,
        exitCode,
        codexCommand
      });
      onEvent({
        model: requestedModel,
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: reason,
        error: detail
      });
      return { exitCode, sessionId: discoveredSessionId, fullText, createdAt };
    }

    onEvent({
      model: requestedModel,
      created_at: new Date().toISOString(),
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: "stop"
    });
    return { exitCode, sessionId: discoveredSessionId, fullText, createdAt };
  }

  return {
    tags,
    runTurn,
    /** Test helper: expose the in-memory session map. */
    _sessionMap: sessionMap
  };
}

export const codexDefaults = {
  model: DEFAULT_MODEL,
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  hardTimeoutMs: DEFAULT_HARD_TIMEOUT_MS,
  tags: DEFAULT_CODEX_TAGS
};
