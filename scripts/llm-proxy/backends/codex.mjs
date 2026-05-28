/**
 * Codex CLI backend for the Ollama-compatible LLM proxy.
 *
 * Translates an Ollama `/api/chat` request into a `codex mcp-server` spawn
 * driven by a minimal MCP JSON-RPC handshake. The MCP server is the only
 * non-experimental Codex subcommand that streams per-token deltas — `codex
 * exec --json` emits a single `item.completed AgentMessage` envelope at the
 * end of the turn (no flag / env var / PTY trick changes that), so we drive
 * `codex mcp-server` instead.
 *
 * Per-turn wire shape
 * -------------------
 * For each turn the backend spawns a fresh `codex mcp-server` child, writes
 * three line-delimited JSON-RPC frames to its stdin, then reads JSON-RPC
 * notifications + the final response off its stdout:
 *
 *   stdin (first turn):
 *     {"jsonrpc":"2.0","id":0,"method":"initialize",
 *       "params":{"protocolVersion":"2024-11-05","capabilities":{},
 *                 "clientInfo":{"name":"zotero-ai-proxy"}}}
 *     {"jsonrpc":"2.0","method":"notifications/initialized"}
 *     {"jsonrpc":"2.0","id":1,"method":"tools/call",
 *       "params":{"name":"codex",
 *                 "arguments":{"prompt":"<latest user>",
 *                              "sandbox":"read-only",
 *                              "approval-policy":"never",
 *                              "cwd":"<process.cwd()>",
 *                              "model":"<optional>"}}}
 *
 *   stdin (subsequent turn):
 *     … same initialize + notifications/initialized …
 *     {"jsonrpc":"2.0","id":1,"method":"tools/call",
 *       "params":{"name":"codex-reply",
 *                 "arguments":{"threadId":"<priorThreadId>","prompt":"…"}}}
 *
 *   stdout:
 *     {"jsonrpc":"2.0","method":"codex/event","params":{… "msg":{…}}}
 *       per-token deltas live at msg.type === "agent_message_content_delta"
 *       (msg.delta carries the text fragment); every other msg.type carries
 *       internal lifecycle / aggregated / tool data and is denied so it
 *       never reaches the popup.
 *     {"jsonrpc":"2.0","id":1,"result":{"structuredContent":{"threadId":"…"}}}
 *       arrives once the turn is done — we read the threadId here and close
 *       stdin so the child exits.
 *
 * Multi-turn correlation
 * ----------------------
 * Codex's `threadId` replaces the legacy `session_id` 1:1: the
 * `tools/call codex-reply { threadId }` argument accepts the same UUID
 * shape that `codex exec resume <id>` did. We keep an in-memory
 * `Map<conversationKey, threadId>` where `conversationKey` is derived
 * from the SHA-256 of the first user message in the incoming `messages[]`
 * array (truncated to 16 hex chars). This is stable for the duration of
 * the proxy process — a restart drops resume state, which is acceptable
 * because the plugin can always start a fresh conversation.
 *
 * Thread ID discovery (defensive)
 * -------------------------------
 * To stay robust against minor shape changes between releases we:
 *
 * 1. Read `result.structuredContent.threadId` from the `tools/call`
 *    response (the documented MCP result shape).
 * 2. Fall back to a recursive walk of every `codex/event` notification's
 *    `params`, accepting the first `thread_id` / `session_id` string we
 *    find (covers `params._meta.threadId` and `params.msg.thread_id`).
 * 3. Final fallback: scan `~/.codex/sessions/**` for the newest `.jsonl`
 *    file modified after the spawn began, and extract the UUID from its
 *    `rollout-<TIMESTAMP>-<UUID>.jsonl` filename or first JSONL line.
 *    `codex mcp-server` writes the same rollout files as `codex exec`,
 *    so this fallback still resolves the same UUID.
 */

import { spawn as defaultSpawn } from "node:child_process";
import { promises as fs, readFileSync, existsSync } from "node:fs";
import { mkdtemp, copyFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
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
 * Hardcoded fallback for /codex/api/tags when live config-read is
 * disabled. AC-21: previously this listed speculative future names
 * (`gpt-5.4`, `o4`, etc.) that don't exist in the real Codex CLI,
 * which made the dropdown look authoritative when it wasn't. Trimmed
 * to a single conservative entry; live discovery via
 * `readDiscoveredCodexModels` is the source of truth when consent is
 * granted, and users can extend with `CODEX_TAGS_EXTRA`.
 */
const BUILTIN_CODEX_TAGS = ["gpt-5.2-codex"];
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
 * id. Codex's event schema named this `session_id` in earlier releases,
 * `thread_id` in the `codex exec --json` shape, and `threadId` (camelCase)
 * in the MCP-server `_meta` envelope. The in-process artefact is a
 * "thread" — `tools/call codex-reply { threadId }` accepts the same UUID
 * that `codex exec resume` did. We accept any of the three field names
 * so the proxy survives the rename without losing multi-turn resume.
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
      (key === "session_id" || key === "thread_id" || key === "threadId") &&
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
 * must NEVER surface as assistant content. Includes:
 *
 *   - Legacy `codex exec --json` types (`command_execution`, `reasoning`,
 *     `user_message`, `system_message`, `user_input`, `thread.started`,
 *     `turn.started`, `turn.completed`) — retained so the test fixtures
 *     that replay the old shape still suppress correctly.
 *   - MCP-server-only types (`session_configured`, `mcp_startup_update`,
 *     `task_started`, `task_complete`, `raw_response_item`, `item_started`,
 *     `item_completed`, `agent_message`) — `item_completed` /
 *     `raw_response_item` / `agent_message` each carry the FULL assembled
 *     response after the per-token deltas have already streamed; surfacing
 *     any of them would emit the final answer two or three times into the
 *     popup.
 *
 * Entries are listed once in `snake_case` (the MCP wire convention).
 * Incoming `msg.type` strings are normalized via `normalizeMsgType` at
 * the comparison site, so PascalCase variants codex has historically
 * emitted (e.g. `Reasoning`, `UserMessage`, `AgentMessage`) match
 * automatically without duplicating entries here.
 *
 * Centralised so every text-extracting branch consults the same denylist —
 * preventing the "command_execution event with a top-level `delta` field"
 * bypass that an earlier per-branch denylist missed.
 */
const NON_ASSISTANT_EVENT_TYPES = new Set([
  "command_execution",
  "reasoning",
  "user_message",
  "system_message",
  "user_input",
  "thread.started",
  "turn.started",
  "turn.completed",
  "session_configured",
  "mcp_startup_update",
  "task_started",
  "task_complete",
  "raw_response_item",
  "item_started",
  "item_completed",
  "agent_message"
]);

/**
 * Normalize a codex event `msg.type` string to its canonical snake_case
 * form for set-membership lookup. Codex has shipped at least two casings
 * for the same logical event (`agent_message` and `AgentMessage`,
 * `reasoning` and `Reasoning`, …). Rather than maintaining both casings
 * in `NON_ASSISTANT_EVENT_TYPES`, we keep one canonical entry and
 * snake-case the comparand here.
 *
 * Examples:
 *   "AgentMessage"  -> "agent_message"
 *   "agent_message" -> "agent_message"
 *   "Reasoning"     -> "reasoning"
 *   "thread.started" -> "thread.started"  (dots / digits untouched)
 */
function normalizeMsgType(t) {
  if (typeof t !== "string" || t.length === 0) return t;
  return t.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Extract an assistant text fragment from a codex JSON event, if any.
 *
 * The proxy now drives `codex mcp-server`. Per-token deltas arrive as
 * JSON-RPC notifications:
 *   {jsonrpc:"2.0", method:"codex/event",
 *    params:{ msg:{ type:"agent_message_content_delta", delta:"…" } } }
 *
 * Everything else returns null. In particular the THREE terminal envelopes
 * `codex mcp-server` emits AFTER the deltas — `item_completed AgentMessage`,
 * `raw_response_item`, and `agent_message` — would otherwise re-emit the
 * full answer two or three times. They're all in `NON_ASSISTANT_EVENT_TYPES`.
 *
 * Legacy `codex exec --json` shapes (`agent_message_delta`,
 * `item.completed agent_message`, top-level `content` arrays, etc.) are
 * preserved so existing fixtures and the live-fixture integration test
 * continue to surface their text via the same extractor.
 */
export function extractDeltaText(event) {
  if (!event || typeof event !== "object") return null;

  // MCP-server JSON-RPC notification: descend into params.msg.
  if (event.method === "codex/event" && event.params && typeof event.params === "object") {
    const inner = event.params.msg;
    if (!inner || typeof inner !== "object") return null;
    if (
      inner.type === "agent_message_content_delta" &&
      typeof inner.delta === "string" &&
      inner.delta.length > 0
    ) {
      return inner.delta;
    }
    // Every other MCP envelope (task_started, mcp_startup_update,
    // item_completed AgentMessage, raw_response_item, …) is denied so
    // the assembled response doesn't replay after the deltas.
    return null;
  }

  // Legacy shapes from `codex exec --json` and from existing fixtures.
  // Tool-call and framing events carry text fields that are internal —
  // any of those reaching the popup would dump shell output / reasoning
  // into the user's explanation.
  const msg = event.msg && typeof event.msg === "object" ? event.msg : event;
  const t = typeof msg.type === "string" ? msg.type : null;
  if (t !== null && NON_ASSISTANT_EVENT_TYPES.has(normalizeMsgType(t))) return null;

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
 * Build the argv passed to `codex` for the MCP-server backend.
 * - Default:        ["mcp-server", "-c", "mcp_servers={}"]
 * - With a model:   ["mcp-server", "-c", "mcp_servers={}", "-c", "model=<name>"]
 *
 * The `-c mcp_servers={}` override is always present. Codex's `-c` flag
 * parses the value as TOML (per `codex --help`); the inline empty table
 * `{}` overrides any `[mcp_servers]` section in `~/.codex/config.toml`,
 * preventing user-configured MCP sidecars from spawning. We drive
 * `codex mcp-server` purely as a streaming chat backend, so paying the
 * startup cost of every configured MCP server (each typically 200-800 ms)
 * would directly inflate spawn→first-delta latency without delivering
 * any feature value. Users with 3-5 configured MCPs saw 1-3 s of avoidable
 * startup per turn without this override.
 *
 * Session resume is handled inside the MCP `tools/call` arguments
 * (`name: "codex-reply"` with `threadId`), NOT via argv — so the same
 * argv applies to first turns and resumes.
 */
export function buildCodexMcpArgs({ model } = {}) {
  const base = ["mcp-server", "-c", "mcp_servers={}"];
  if (typeof model === "string" && model.length > 0) {
    base.push("-c", `model=${model}`);
  }
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

  /**
   * Lazily-created per-backend isolation tmpdir. Reused across `runTurn`
   * calls so we don't pay the mkdtemp cost on every turn AND so concurrent
   * turns share the same isolated HOME (codex's auth.json is read once
   * per spawn, but the resulting OAuth token is cached on disk — sharing
   * the dir lets that cache survive between turns).
   *
   * Cached as a Promise so concurrent `runTurn` calls all await the same
   * single mkdtemp; without the promise cache, two concurrent first turns
   * would each spawn their own mkdtemp and one would leak.
   */
  let isolationDirPromise = null;

  /**
   * Build (once) the isolation directory for codex spawns and copy the
   * user's `~/.codex/auth.json` into it so codex finds the OAuth token at
   * `$CODEX_HOME/auth.json`. We deliberately do NOT copy `~/.codex/config.toml`
   * or `~/.codex/AGENTS.md` — those are precisely the pollution sources
   * (skill plugins, Superpowers preamble, user-installed skills) we are
   * isolating from.
   *
   * Why this isolation matters: `codex mcp-server` (the only codex
   * subcommand that streams per-token deltas) has no `--ephemeral` /
   * `--ignore-user-config` flag — only `codex exec` does. The viable
   * isolation lever is environment-based: set HOME and CODEX_HOME to an
   * empty tmpdir at spawn time. That strips `~/.codex/AGENTS.md`,
   * `~/.codex/config.toml`, `~/.codex/skills/*`, `~/.agents/skills/*`,
   * and project `AGENTS.md` from process.cwd(). The 5 bundled `.system`
   * skills (imagegen, openai-docs, plugin-creator, skill-creator,
   * skill-installer) remain — they are baked into the codex binary, all
   * phrased as descriptive triggers ("Use when..."), and none activate
   * for "Explain this passage". Accepted limitation.
   *
   * Auth note: `~/.codex/auth.json` is the OAuth token file. If it is
   * absent (the user authenticates via an OPENAI_API_KEY env var), we
   * skip the copy silently — codex will still find the env var from the
   * spawn env. We never error here: a missing auth file is the user's
   * responsibility, and a broken isolation helper must not break every
   * turn.
   */
  async function ensureIsolationDir() {
    if (isolationDirPromise !== null) return isolationDirPromise;
    isolationDirPromise = (async () => {
      const dir = await mkdtemp(join(tmpdir(), "zotero-ai-codex-"));
      const src = join(homedir(), ".codex", "auth.json");
      try {
        await access(src);
        await copyFile(src, join(dir, "auth.json"));
      } catch {
        // Auth file absent (user uses an env-var API key) or unreadable.
        // Codex will surface its own auth error from the isolated dir if
        // the env var is also missing — that's the right place to report.
      }
      return dir;
    })();
    return isolationDirPromise;
  }
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
    const argv = buildCodexMcpArgs({ model: requestedModel });
    const prompt = latestUserContent(messages);
    const spawnStartedAtMs = now();

    // Build (or reuse) the isolation tmpdir so codex doesn't see the
    // user's ~/.codex/AGENTS.md / config.toml / skills / impeccable etc.
    // See ensureIsolationDir() for the full rationale.
    const isolationDir = await ensureIsolationDir();

    const child = spawn(codexCommand, argv, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: isolationDir,
      env: { ...process.env, HOME: isolationDir, CODEX_HOME: isolationDir }
    });

    // Write the three MCP JSON-RPC handshake frames to stdin. The
    // tools/call frame uses `name: "codex"` for the first turn or
    // `name: "codex-reply"` (with the prior threadId) for resumes.
    // After writing we keep stdin OPEN so the child can still see the
    // notifications it expects; we close stdin once the tools/call
    // response arrives (or the child exits / a timeout fires).
    const TOOL_CALL_ID = 1;
    const toolName = sessionId ? "codex-reply" : "codex";
    const toolArguments = sessionId
      ? { threadId: sessionId, prompt }
      : (() => {
          const base = {
            prompt,
            sandbox: "read-only",
            "approval-policy": "never",
            // `cwd` rides the tools/call arguments AND the spawn options
            // for the same isolation reason: codex's `tools/call codex`
            // resolves project AGENTS.md relative to this cwd. Pointing
            // it at the empty isolation dir suppresses the plugin's own
            // project AGENTS.md alongside the user's global ones.
            cwd: isolationDir
          };
          if (typeof requestedModel === "string" && requestedModel.length > 0) {
            base.model = requestedModel;
          }
          return base;
        })();
    const initializeFrame = {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "zotero-ai-proxy" }
      }
    };
    const initializedFrame = { jsonrpc: "2.0", method: "notifications/initialized" };
    const toolCallFrame = {
      jsonrpc: "2.0",
      id: TOOL_CALL_ID,
      method: "tools/call",
      params: { name: toolName, arguments: toolArguments }
    };
    function closeStdin() {
      if (!child.stdin) return;
      try {
        child.stdin.end();
      } catch {
        // ignore — child may already have exited
      }
    }
    if (child.stdin) {
      try {
        child.stdin.write(`${JSON.stringify(initializeFrame)}\n`);
        child.stdin.write(`${JSON.stringify(initializedFrame)}\n`);
        child.stdin.write(`${JSON.stringify(toolCallFrame)}\n`);
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
    let rpcErrorMessage = null;
    // AC-12: spawn-timing MEASUREMENT (not a behaviour change). `codex
    // mcp-server` is spawned per turn (no daemon mode), so AC-12 makes
    // the spawn-vs-inference split an observable fact in the proxy logs
    // rather than attempting an unbuildable "warm daemon".
    // `firstDeltaLogged` gates the spawn→first-delta line to the FIRST
    // streamed delta only.
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

    function processEvent(event) {
      // Discover the codex threadId opportunistically from any nested
      // _meta / msg field. The recursive walker accepts session_id,
      // thread_id and threadId.
      if (!discoveredSessionId) {
        const found = findSessionId(event);
        if (found) discoveredSessionId = found;
      }
      // tools/call response: capture the threadId from
      // structuredContent and close stdin so the MCP server exits
      // cleanly. Also short-circuit any per-turn `error` field on the
      // JSON-RPC envelope.
      if (event && typeof event === "object" && event.id === TOOL_CALL_ID) {
        if (event.result && typeof event.result === "object") {
          const sc = event.result.structuredContent;
          if (
            sc &&
            typeof sc === "object" &&
            typeof sc.threadId === "string" &&
            sc.threadId.length > 0
          ) {
            discoveredSessionId = sc.threadId;
          }
          closeStdin();
          return;
        }
        if (event.error && typeof event.error === "object") {
          rpcErrorMessage =
            typeof event.error.message === "string" && event.error.message.length > 0
              ? event.error.message
              : `codex MCP error ${String(event.error.code ?? "")}`.trim();
          // Don't flag `aborted` — that would force the fallback exit
          // branch to label the terminal as "timeout". The RPC error is
          // explicit and we surface it via the rpcErrorMessage branch
          // below.
          closeStdin();
          return;
        }
      }
      const delta = extractDeltaText(event);
      if (delta) emitDelta(delta);
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
        processEvent(event);
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
        processEvent(event);
      } catch {
        emitDelta(trailing);
      }
      stdoutBuffer = "";
    }

    // Session-id fallback: scan disk if codex did not surface one in stdout.
    // mcp-server writes the same rollout files as `codex exec`, so this
    // fallback still resolves the same UUID when stdout didn't expose one
    // (e.g. the tools/call response carried no structuredContent.threadId
    // and no nested _meta.threadId / msg.thread_id).
    if (!discoveredSessionId) {
      const fromDisk = await readSessionIdFromDisk(spawnStartedAtMs, fsImpl, sessionsDir);
      if (fromDisk) discoveredSessionId = fromDisk;
    }

    if (discoveredSessionId) sessionMap.set(key, discoveredSessionId);

    // JSON-RPC `error` envelope on the tools/call response → surface as
    // a terminal error chunk regardless of the child's exit status. The
    // MCP server typically exits 0 even when the tool call returned an
    // error envelope, so a clean exit code is not by itself proof of
    // success.
    if (rpcErrorMessage !== null) {
      onEvent({
        model: requestedModel,
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: "" },
        done: true,
        done_reason: "error",
        error: rpcErrorMessage
      });
      return { exitCode, sessionId: discoveredSessionId, fullText, createdAt };
    }

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
