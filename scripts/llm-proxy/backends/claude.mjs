/**
 * Claude Code CLI backend for the Ollama-compatible LLM proxy.
 *
 * Translates an Ollama `/api/chat` request into a `claude -p --output-format
 * json --allowedTools "" -` (first turn) or `claude --resume <SESSION_ID> -p
 * --output-format json --allowedTools "" -` (subsequent turn) invocation, then
 * streams Claude's stdout back to the caller as Ollama-format NDJSON delta
 * objects.
 *
 * Tool use is hard-disabled
 * -------------------------
 * The proxy always passes `--allowedTools ""` so Claude behaves as a pure
 * chat model — no Read/Write/Bash/etc. This matches the Zotero plugin's
 * contract: the popup and sidebar are conversational explainers, not agents.
 *
 * Multi-turn correlation
 * ----------------------
 * Same scheme as the codex backend: we keep an in-memory
 * `Map<conversationKey, sessionId>` where `conversationKey` is derived from
 * the SHA-256 of the first user message in `messages[]` (truncated to 16 hex
 * chars). On the first turn we spawn without `--resume`, parse a `session_id`
 * out of Claude's structured output, and store it. Subsequent turns spawn
 * with `--resume <SESSION_ID>` and pass only the latest user message via
 * stdin.
 *
 * Session ID discovery
 * --------------------
 * `claude -p --output-format json` emits structured JSON that contains a
 * `session_id` field. To stay robust against minor shape changes between
 * releases we recursively walk every parsed JSON object on stdout and accept
 * the first `session_id` string we find (covers both top-level
 * `{"session_id":"…"}` and nested shapes like `{"meta":{"session_id":"…"}}`).
 *
 * Output shape
 * ------------
 * With `--output-format json`, Claude prints a single JSON object containing
 * the final result. We extract any text from it (recursive search of `text`,
 * `result`, `content[].text`, etc.) and emit it as one or more Ollama
 * `done:false` delta chunks. Non-JSON banner lines (e.g. version notices) are
 * surfaced as raw text deltas — same policy as the codex backend — so users
 * see authentication-related diagnostics in the popup rather than nothing.
 */

import { spawn as defaultSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_HARD_TIMEOUT_MS = 300_000;

/**
 * User-facing error for a claude CLI non-zero exit. Mirror of
 * codex.mjs/describeCodexFailure; see that helper for the rationale.
 * Exported for unit tests.
 */
export function describeClaudeFailure({ spawnError, stderr, exitCode, claudeCommand }) {
  if (spawnError !== null && spawnError !== undefined) {
    const code = typeof spawnError.code === "string" ? spawnError.code : null;
    if (code === "ENOENT") {
      return (
        `claude CLI not found at "${claudeCommand}". ` +
        `Install with \`npm i -g @anthropic-ai/claude-code\` or set the ` +
        `PROXY_CLAUDE_BIN environment variable to its absolute path.`
      );
    }
    if (code === "EACCES") {
      return (
        `claude CLI at "${claudeCommand}" is not executable (EACCES). ` +
        `Run \`chmod +x ${claudeCommand}\` or reinstall.`
      );
    }
    const detail = typeof spawnError.message === "string" ? spawnError.message : String(spawnError);
    return `claude CLI failed to spawn (${code ?? "unknown"}): ${detail}`;
  }
  if (stderr.length > 0) return stderr;
  return `claude exited with code ${String(exitCode)} (command: ${claudeCommand}).`;
}

/** Tags returned for /claude/api/tags. Identifier-only — Zotero only reads `name`. */
const BUILTIN_CLAUDE_TAGS = [
  "claude-opus-4-7",
  "claude-sonnet-4-7",
  "claude-haiku-4-7",
  "opus",
  "sonnet",
  "haiku"
];

function readEnvExtraClaudeTags() {
  const raw = process.env.CLAUDE_TAGS_EXTRA;
  if (typeof raw !== "string" || raw.length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Recursively walk a parsed JSON value and collect every string that
 * sits under a key named `model` or `models`. The Claude CLI's settings
 * file format has shifted over releases (`~/.claude/settings.json`,
 * `~/.claude/config.json`, nested `defaults.model`, `models[]`); this
 * helper is intentionally permissive so we don't need to hand-update
 * the proxy whenever Anthropic renames a field.
 *
 * Exported for tests.
 */
export function extractModelsFromClaudeConfig(value) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    if (typeof raw !== "string") return;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  function walk(node) {
    if (node === null || node === undefined) return;
    if (typeof node === "string") return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry);
      return;
    }
    if (typeof node !== "object") return;
    for (const [key, val] of Object.entries(node)) {
      const k = key.toLowerCase();
      if (k === "model" || k === "defaultmodel" || k === "default_model") {
        if (typeof val === "string") push(val);
      }
      if (k === "models") {
        if (Array.isArray(val)) {
          for (const item of val) {
            if (typeof item === "string") push(item);
            else if (item && typeof item === "object") {
              const inner = item;
              if (typeof inner.name === "string") push(inner.name);
              if (typeof inner.id === "string") push(inner.id);
              if (typeof inner.model === "string") push(inner.model);
            }
          }
        } else if (typeof val === "string") {
          push(val);
        }
      }
      walk(val);
    }
  }
  walk(value);
  return out;
}

/**
 * Read the user's Claude CLI config (one of a handful of historical
 * paths) and surface model names referenced inside. Returns `[]` on
 * absence / parse error / permission denied so the dropdown still
 * shows the builtin defaults.
 *
 * Gated behind `LLM_PROXY_CONFIG_READ=allow`; pass `force: true` to
 * bypass the gate in tests.
 */
export function readDiscoveredClaudeModels(opts = {}) {
  const allow = opts.force === true || process.env.LLM_PROXY_CONFIG_READ === "allow";
  if (!allow) return [];
  const exists = opts.existsSync ?? existsSync;
  const read = opts.readFileSync ?? readFileSync;
  const home = opts.home ?? homedir();
  const candidates = opts.configPaths ?? [
    join(home, ".claude", "settings.json"),
    join(home, ".claude", "config.json")
  ];
  const merged = [];
  const seen = new Set();
  for (const path of candidates) {
    try {
      if (!exists(path)) continue;
      const raw = read(path, "utf8");
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      for (const name of extractModelsFromClaudeConfig(parsed)) {
        if (seen.has(name)) continue;
        seen.add(name);
        merged.push(name);
      }
    } catch {
      // Unreadable — skip this candidate.
    }
  }
  return merged;
}

function buildMergedClaudeTags(opts = {}) {
  const seen = new Set();
  const merged = [];
  const sources = [readDiscoveredClaudeModels(opts), readEnvExtraClaudeTags(), BUILTIN_CLAUDE_TAGS];
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

const DEFAULT_CLAUDE_TAGS = buildMergedClaudeTags();

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
  return messages
    .map((m) => (m && typeof m.content === "string" ? m.content : ""))
    .filter((s) => s.length > 0)
    .join("\n");
}

/** Recursively search a parsed JSON value for a `session_id` string field. */
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
    if (key === "session_id" && typeof val === "string" && val.length > 0) return val;
    const hit = findSessionId(val);
    if (hit) return hit;
  }
  return null;
}

/**
 * Extract an assistant text fragment from a claude JSON event, if any.
 *
 * `claude -p --output-format json` returns a single object with the final
 * result. Stream-json mode (not used here) emits incremental deltas. We accept
 * either shape so we can co-exist with future versions that switch defaults.
 *
 * Recognised shapes:
 *   {"result":"..."}                      (default --output-format json)
 *   {"text":"..."}                        (alternate result wrapper)
 *   {"delta":"..."}                       (stream-json incremental)
 *   {"message":{"content":[{"type":"text","text":"..."}]}}  (anthropic shape)
 *   {"content":[{"type":"text","text":"..."}]}              (top-level content)
 *
 * `type === "user"` / `"user_message"` events are ignored so we don't echo
 * the user's own prompt back as assistant text.
 */
export function extractDeltaText(event) {
  if (!event || typeof event !== "object") return null;
  const t = typeof event.type === "string" ? event.type : "";
  if (t === "user" || t === "user_message" || t === "user_input") return null;

  if (typeof event.delta === "string" && event.delta.length > 0) return event.delta;
  if (typeof event.result === "string" && event.result.length > 0) return event.result;
  if (typeof event.text === "string" && event.text.length > 0) return event.text;

  // Anthropic message-shaped: { message: { content: [{ type:"text", text:"..."}, ...] } }
  if (event.message && typeof event.message === "object") {
    const inner = extractDeltaText(event.message);
    if (inner) return inner;
  }
  if (Array.isArray(event.content)) {
    const parts = event.content
      .filter((c) => c && typeof c === "object" && c.type === "text" && typeof c.text === "string")
      .map((c) => c.text);
    if (parts.length > 0) return parts.join("");
  }
  return null;
}

/**
 * Build the argv passed to the `claude` CLI.
 * - First turn:  ["-p","--output-format","json","--allowedTools",""]
 *                (+ optional ["--model", model])
 * - Resume:      ["--resume", <SESSION_ID>, "-p","--output-format","json","--allowedTools",""]
 *
 * The prompt is delivered via stdin (claude reads stdin when no positional
 * prompt argument is provided).
 */
export function buildClaudeArgs({ sessionId, model }) {
  const args = [];
  if (sessionId) args.push("--resume", sessionId);
  args.push("-p", "--output-format", "json", "--allowedTools", "");
  if (model) args.push("--model", model);
  return args;
}

/**
 * Create a claude backend handler.
 *
 * @param {object} [deps]
 * @param {(cmd: string, args: string[], opts?: object) => any} [deps.spawn]
 * @param {string} [deps.claudeCommand]     default "claude"
 * @param {string} [deps.defaultModel]      default "" (let claude pick)
 * @param {number} [deps.idleTimeoutMs]
 * @param {number} [deps.hardTimeoutMs]
 * @param {number} [deps.sigkillGraceMs]  default 3000; ms after SIGTERM before SIGKILL escalation
 * @param {() => number} [deps.now]
 * @param {Map<string,string>} [deps.sessionMap]
 */
export function createClaudeBackend(deps = {}) {
  const spawn = deps.spawn ?? defaultSpawn;
  const claudeCommand = deps.claudeCommand ?? "claude";
  const defaultModel = deps.defaultModel ?? "";
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const hardTimeoutMs = deps.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS;
  const sigkillGraceMs = deps.sigkillGraceMs ?? 3000;
  const now = deps.now ?? (() => Date.now());
  const sessionMap = deps.sessionMap ?? new Map();
  const configDiscoveryOpts = {
    ...(deps.configPaths !== undefined ? { configPaths: deps.configPaths } : {}),
    ...(deps.existsSync !== undefined ? { existsSync: deps.existsSync } : {}),
    ...(deps.readFileSync !== undefined ? { readFileSync: deps.readFileSync } : {}),
    ...(deps.home !== undefined ? { home: deps.home } : {}),
    ...(deps.forceConfigRead === true ? { force: true } : {})
  };

  function tags() {
    const names = buildMergedClaudeTags(configDiscoveryOpts);
    return names.map((name) => ({
      name,
      model: name,
      modified_at: new Date(0).toISOString(),
      size: 0
    }));
  }

  /**
   * Run one turn against claude.
   *
   * @param {object} args
   * @param {ReadonlyArray<{role:string,content:string}>} args.messages
   * @param {string} [args.model]
   * @param {(chunk: {message?:{role:"assistant",content:string}, done:boolean, done_reason?:string, error?:string, model:string, created_at:string}) => void} args.onEvent
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<{exitCode:number, sessionId:string|null, fullText:string, createdAt?:string}>}
   */
  async function runTurn(args) {
    const { messages, onEvent } = args;
    const requestedModel = args.model || defaultModel;
    const key = conversationKeyFromMessages(messages);
    const isFirstTurn = !sessionMap.has(key) || messages.length <= 1;
    const sessionId = isFirstTurn ? null : sessionMap.get(key);
    const argv = buildClaudeArgs({
      sessionId: sessionId ?? null,
      model: requestedModel
    });
    const prompt = latestUserContent(messages);

    const child = spawn(claudeCommand, argv, {
      stdio: ["pipe", "pipe", "pipe"]
    });

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

    function emitDelta(text) {
      if (!text) return;
      fullText += text;
      onEvent({
        model: requestedModel,
        created_at: new Date().toISOString(),
        message: { role: "assistant", content: text },
        done: false
      });
    }

    function processJsonOrText(line) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // Non-JSON banner line — surface as raw text so users see authentication
        // diagnostics rather than nothing.
        emitDelta(line);
        return;
      }
      if (!discoveredSessionId) {
        const found = findSessionId(event);
        if (found) discoveredSessionId = found;
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
        processJsonOrText(line);
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
      // A claude CLI that ignores SIGTERM (or is wedged in a syscall)
      // would otherwise hang the request indefinitely past the
      // idle/hard timeout. Matches the 3s grace used by
      // src/platform/proxy-lifecycle.ts. Tests override the grace to
      // 0 so the escalation fires immediately.
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

    // Capture the spawn error so describeClaudeFailure() can surface
    // ENOENT / EACCES with an actionable message instead of "claude
    // exited with code -1". See backends/codex.mjs for the same fix.
    let spawnError = null;
    const exitPromise = new Promise((resolve) => {
      child.on("close", (code) => resolve(typeof code === "number" ? code : -1));
      child.on("error", (err) => {
        spawnError = err;
        resolve(-1);
      });
    });

    if (hardTimeoutMs > 0) {
      hardTimer = setTimeout(() => {
        aborted = true;
        killChild();
      }, hardTimeoutMs);
    }

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

    // Drain any trailing partial line that didn't end in \n. `claude -p
    // --output-format json` typically emits one big JSON object without a
    // trailing newline, so this branch is the common case.
    if (stdoutBuffer.trim().length > 0) {
      processJsonOrText(stdoutBuffer.trim());
      stdoutBuffer = "";
    }

    if (discoveredSessionId) sessionMap.set(key, discoveredSessionId);

    if (exitCode !== 0) {
      const stderr = stderrBuffer.slice(0, 500).trim();
      const reason = aborted ? "timeout" : "error";
      const detail = describeClaudeFailure({
        spawnError,
        stderr,
        exitCode,
        claudeCommand
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

export const claudeDefaults = {
  model: "",
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  hardTimeoutMs: DEFAULT_HARD_TIMEOUT_MS,
  tags: DEFAULT_CLAUDE_TAGS
};
