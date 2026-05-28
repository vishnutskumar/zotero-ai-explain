/**
 * Ollama-compatible LLM proxy.
 *
 * Speaks the Ollama `/api/chat` + `/api/tags` wire protocol on the front side
 * so the Zotero AI Explain plugin (`src/providers/adapters/ollama.ts`) can
 * point at this proxy unchanged. Routes:
 *
 *   POST /codex/api/chat   → Codex CLI backend (multi-turn via session_id)
 *   POST /claude/api/chat  → Claude Code CLI backend (multi-turn via --resume)
 *   POST /ollama/api/chat  → Passthrough to a real Ollama daemon
 *   GET  /codex/api/tags   → Hard-coded list of Codex model identifiers
 *   GET  /claude/api/tags  → Hard-coded list of Claude model identifiers
 *   GET  /ollama/api/tags  → Forwarded from the real Ollama daemon
 *   GET  /api/tags         → Union of the above (Zotero default discovery path)
 *
 * Run:
 *   node scripts/llm-proxy/server.mjs
 *   LLM_PROXY_PORT=11400 OLLAMA_BASE_URL=http://localhost:11434 \
 *     CODEX_DEFAULT_MODEL=gpt-5.2-codex node scripts/llm-proxy/server.mjs
 *
 * To point the Zotero plugin at it, set the Ollama provider profile's
 * Base URL to one of:
 *   http://127.0.0.1:11400/codex
 *   http://127.0.0.1:11400/claude
 *   http://127.0.0.1:11400/ollama
 *
 * The plugin appends `/api/chat` and `/api/embed` itself.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createClaudeBackend } from "./backends/claude.mjs";
import { createCodexBackend } from "./backends/codex.mjs";
import { createOllamaBackend } from "./backends/ollama.mjs";
import { enrichEnvironmentPath, findBinary } from "./path-discovery.mjs";
import { LLM_PROXY_AUTH_TOKEN_ENV, LLM_PROXY_MAX_BODY_BYTES_ENV } from "./protocol-constants.mjs";

const DEFAULT_PORT = 11400;

/* ---------------------------------------------------------------------------
 * Protocol constants
 *
 * All wire-visible string literals (bearer prefix, error response bodies,
 * env-var names) live here so a rename surfaces in one place. The env-var
 * names are re-exported from `protocol-constants.mjs` because they also
 * have to match a literal on the TypeScript wiring side
 * (`src/platform/wire-proxy-lifecycle.ts`); centralizing them lets a
 * round-trip test catch a typo in either consumer.
 * ------------------------------------------------------------------------ */
const AUTH_BEARER_PREFIX = "Bearer ";
const AUTH_ERR_MISSING_BEARER = "missing bearer";
const AUTH_ERR_INVALID_TOKEN = "invalid token";
const AUTH_ERR_HOST_NOT_ALLOWED = "host not allowed";
const AUTH_ERR_ORIGIN_NOT_ALLOWED = "origin not allowed";

// Defensive fallback for the Host gate when a request somehow lands
// before `listen()`'s callback hoists the port-aware Set. The bare-
// hostname entries match the common case where a client elides the
// `:port` suffix on a default-bind probe.
const FALLBACK_ALLOWED_HOSTS = new Set(["127.0.0.1", "localhost"]);

function readEnvInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Per-request body cap. Default 1 MiB; override via the
 * `LLM_PROXY_MAX_BODY_BYTES` env var. The cap protects the chrome-side
 * fetch stack from a malicious local process pinning the proxy on a
 * huge POST — the proxy is bound to 127.0.0.1 but any local process can
 * connect. A 100k-token chat history JSON-encodes to about 400 KB, so
 * 1 MiB is generous in practice.
 */
const MAX_BODY_BYTES = readEnvInt(LLM_PROXY_MAX_BODY_BYTES_ENV, 1_048_576);

/**
 * Overflow drain timeout (F1). Default 5 s; override via the
 * `LLM_PROXY_DRAIN_TIMEOUT_MS` env var. Used by the overflow path in
 * `readBody` to bound the time the proxy will wait for a half-open
 * client to send FIN/RST or another byte after the body-cap fires. Set
 * smaller in tests to keep the suite fast.
 */
const DRAIN_TIMEOUT_MS_ENV = "LLM_PROXY_DRAIN_TIMEOUT_MS";

function readBody(req, res) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    let finished = false;
    const chunks = [];
    const handleOverflow = () => {
      if (aborted) return;
      aborted = true;
      // Drop the original listeners so accumulated chunks stop growing
      // and the resolve/reject path runs at most once.
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      req.removeAllListeners("error");
      // `close` may have a default listener attached by the HTTP server;
      // we don't remove all of those here — we only added our own below,
      // and `cleanup()` removes that one specifically.
      const err = new Error(`body exceeds ${String(MAX_BODY_BYTES)} bytes`);
      err.code = "EBODYLIMIT";
      // Silently drain the remaining body BEFORE responding. The cap on
      // memory still holds (we discard each chunk), but letting the
      // client finish its upload eliminates the ECONNRESET race that
      // tearing the socket down mid-write produces — at the cost of
      // continuing to read N more bytes off the local-bound socket.
      // The proxy listens on 127.0.0.1 with bearer auth, so unbounded
      // local upload is not a real attack surface.
      const drain = () => {
        try {
          if (res !== undefined && !res.headersSent) {
            const payload = JSON.stringify({
              error: `body exceeds ${String(MAX_BODY_BYTES)} bytes`
            });
            res.writeHead(413, {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
              connection: "close"
            });
            res.end(payload);
          }
        } catch {
          // Response writing failed (socket already closed); fall through.
        }
        reject(err);
      };
      // F1 + F2: track all four listeners (data, end, error, close) plus
      // the drain timer so the FIRST settlement (clean `end`, drain
      // timeout, `error`, or socket `close`) tears down the others. A
      // half-open client that pauses mid-upload (F1) settles via the
      // timer; a client that destroys the socket without a parser-level
      // `error` (F2) settles via the `close` listener. Without this,
      // the route's `readBody` promise hangs indefinitely and the slot
      // never frees.
      let drainTimer = null;
      let settled = false;
      const onData = () => {
        // Discard any further data — already over cap.
      };
      const onEnd = () => {
        if (settled) return;
        settled = true;
        cleanup();
        drain();
      };
      const onError = (cause) => {
        if (settled) return;
        settled = true;
        cleanup();
        // Preserve the underlying transport error as `cause` so logs
        // surface what actually went wrong (ECONNRESET, parser error,
        // etc.) rather than only the generic EBODYLIMIT rejection.
        if (cause !== undefined) {
          Object.assign(err, { cause });
        }
        reject(err);
      };
      const onClose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        // Skip writing the 413 body here: the socket has already
        // closed (that is exactly why `close` fired without a prior
        // `end` or `error`), so any res.write/end would throw. The
        // route's outer catch swallows the EBODYLIMIT rejection.
        reject(err);
      };
      const onDrainTimeout = () => {
        if (settled) return;
        settled = true;
        cleanup();
        // The client is half-open: connection alive but no FIN/RST and
        // no further bytes. We've waited DRAIN_TIMEOUT_MS for it to
        // make up its mind; write the 413 body BEFORE tearing the
        // socket down so the wire still carries the structured error
        // response. Then force-close the socket so the route slot
        // frees and the client observes a teardown instead of hanging
        // on our side. Wrapped in try because either step may fail if
        // the socket is already in an unwritable state.
        try {
          drain();
        } catch {
          // drain() itself defends with try/catch; this outer guard
          // covers any future throws the helper might add.
        }
        try {
          if (res !== undefined) {
            res.socket?.destroy();
          }
        } catch {
          // ignore — best-effort teardown
        }
        // drain() already called reject(err); calling again is a no-op
        // because we hold the `settled` guard above.
      };
      const cleanup = () => {
        req.removeListener("data", onData);
        req.removeListener("end", onEnd);
        req.removeListener("error", onError);
        req.removeListener("close", onClose);
        if (drainTimer !== null) {
          clearTimeout(drainTimer);
          drainTimer = null;
        }
      };
      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
      req.on("close", onClose);
      const drainTimeoutMs = readEnvInt(DRAIN_TIMEOUT_MS_ENV, 5_000);
      drainTimer = setTimeout(onDrainTimeout, drainTimeoutMs);
    };
    req.on("data", (c) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        handleOverflow();
        return;
      }
      chunks.push(c);
    });
    req.on("error", (err) => {
      if (!aborted && !finished) {
        finished = true;
        reject(err);
      }
    });
    req.on("end", () => {
      if (!aborted && !finished) {
        finished = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    // Under-cap abortive disconnect: if the client closes the socket
    // before sending FIN AND without emitting a parser-level `error`,
    // neither `end` nor `error` fires and the promise would hang
    // forever. Defensive `close` listener mirrors the overflow path's
    // pattern and frees the route slot. The `finished` guard prevents
    // a spurious reject after a clean `end` (close always fires after
    // end on a Connection: close response); the `aborted` check skips
    // this path entirely once the overflow handler has taken over.
    req.on("close", () => {
      if (!aborted && !finished) {
        finished = true;
        reject(new Error("request closed before body finished"));
      }
    });
  });
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function writeNdjsonHeaders(res) {
  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "transfer-encoding": "chunked",
    "cache-control": "no-store"
  });
}

function parseJson(raw) {
  if (!raw || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Build the trimmed /api/diagnostics representation for one binary
 * lookup (codex / claude). When the binary was found we return the
 * resolved path — that's the most useful signal for the UI and the
 * least sensitive piece of information. When it's MISSING we return a
 * count of directories searched so the settings dialog can say
 * "Searched 12 directories, none had codex" without exposing $HOME or
 * the user's PATH layout to local sniffers.
 *
 * Exported for unit tests; not part of the runtime API.
 */
export function summarizeBinaryLookup(lookup) {
  if (lookup.path !== null) {
    return { path: lookup.path };
  }
  return { path: null, searchedCount: lookup.searched.length };
}

/**
 * @param {object} [deps]
 * @param {ReturnType<typeof createCodexBackend>} [deps.codexBackend]
 * @param {ReturnType<typeof createClaudeBackend>} [deps.claudeBackend]
 * @param {ReturnType<typeof createOllamaBackend>} [deps.ollamaBackend]
 * @param {import("./path-discovery.mjs").PathEnrichmentResult} [deps.pathEnrichment]
 *   Optional pre-computed result of `enrichEnvironmentPath`. Surfaced
 *   through /api/diagnostics so callers can paint "codex found at X" /
 *   "PATH inherited from login shell". Tests inject a fixed value.
 *   Lives in the server closure (not module scope) so two concurrent
 *   server instances don't leak state across each other in tests.
 */
export function createProxyServer(deps = {}) {
  const pathEnrichmentSnapshot = deps.pathEnrichment ?? null;
  // AUTH_TOKEN lives on the closure (not module scope) so two server
  // instances in the same Vitest worker can each pick up their own
  // env-driven token without interfering with each other. Production
  // semantics are unchanged: the env var is captured once per proxy
  // process at startup, before any request is served. See the
  // docstring on LLM_PROXY_AUTH_TOKEN_ENV for the rename contract.
  const AUTH_TOKEN = process.env[LLM_PROXY_AUTH_TOKEN_ENV] ?? null;
  // Precompute the expected-token Buffer once per server construction:
  // `AUTH_TOKEN` is frozen for the lifetime of the proxy, so allocating
  // its Buffer on every authenticated request just churns the young
  // generation. The per-request presented-token Buffer is still
  // unavoidable (it's per-request input).
  const AUTH_TOKEN_BUF = AUTH_TOKEN !== null ? Buffer.from(AUTH_TOKEN) : null;
  // Built once inside listen()'s callback (after the OS assigns the
  // bound port) so the Host gate doesn't rebuild a 4-element Set on
  // every request. Stays null until the server is listening; the gate
  // falls back to the bare-hostname allowlist in that brief window
  // (which in practice never opens because the gate only runs after
  // the server has accepted a connection). Stored on the closure (NOT
  // module scope) so two server instances spun up in the same process
  // never clobber each other.
  let allowedHostsSet = null;

  function enforceTransportPolicy(req, res) {
    // 1. Host normalization — reject DNS-rebinding attacks against
    //    the loopback bind by demanding the Host header point at a
    //    loopback name (or the bare hostname without a port for the
    //    rare client that elides it on default-bind).
    const host = (req.headers.host ?? "").toLowerCase();
    const allowed = allowedHostsSet ?? FALLBACK_ALLOWED_HOSTS;
    if (!allowed.has(host)) {
      writeJson(res, 403, { error: AUTH_ERR_HOST_NOT_ALLOWED });
      return false;
    }

    // 2. Origin — node fetch sends no Origin header (verified in P2
    //    smoke test), so the plugin's own requests pass. Browser
    //    fetches always set Origin (chrome-extension://, https://...)
    //    and get rejected. Empty / "null" are tolerated for callers
    //    behind sandboxed iframes that strip the value.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== "" && origin !== "null") {
      writeJson(res, 403, { error: AUTH_ERR_ORIGIN_NOT_ALLOWED });
      return false;
    }
    return true;
  }

  function enforceBearerPolicy(req, res) {
    // Bearer token — skipped entirely when no env var was set (the
    // `npm run proxy:llm` dev path stays unauthenticated).
    if (AUTH_TOKEN === null || AUTH_TOKEN_BUF === null) return true;
    const header = req.headers.authorization ?? "";
    if (!header.startsWith(AUTH_BEARER_PREFIX)) {
      writeJson(res, 401, { error: AUTH_ERR_MISSING_BEARER });
      return false;
    }
    const presented = header.slice(AUTH_BEARER_PREFIX.length);
    // Length-check first — timingSafeEqual throws on differing
    // lengths, and the wrong-length case is itself a constant-time
    // reject (the leak is "you got the length wrong", which doesn't
    // narrow the token).
    if (presented.length !== AUTH_TOKEN.length) {
      writeJson(res, 401, { error: AUTH_ERR_INVALID_TOKEN });
      return false;
    }
    const presentedBuf = Buffer.from(presented);
    if (!timingSafeEqual(presentedBuf, AUTH_TOKEN_BUF)) {
      writeJson(res, 401, { error: AUTH_ERR_INVALID_TOKEN });
      return false;
    }
    return true;
  }

  // Resolve absolute paths for codex/claude up-front so /api/diagnostics
  // can report them. The backends still call spawn() at run time; passing
  // the resolved path here also makes the spawn fail predictably when the
  // binary is missing (the error event's spawnfile is the full path).
  const codexBin = process.env.PROXY_CODEX_BIN ?? process.env.CODEX_BINARY;
  const claudeBin = process.env.PROXY_CLAUDE_BIN ?? process.env.CLAUDE_BINARY;
  const codexLookup = findBinary("codex", { override: codexBin });
  const claudeLookup = findBinary("claude", { override: claudeBin });
  // Codex review final residual: when a user explicitly pinned
  // PROXY_CODEX_BIN to a path that isn't executable, findBinary
  // correctly reports path:null in /api/diagnostics — but we MUST
  // still hand that exact override to the backend so spawn() fails
  // at the user's specified path (not silently falling back to a
  // bare `codex` from PATH that they didn't ask for). The user's
  // explicit pin is a contract; respect it even when it's broken so
  // the failure message matches what they typed.
  const codexCmdOverride =
    typeof codexBin === "string" && codexBin.trim().length > 0 ? codexBin.trim() : codexLookup.path;
  const claudeCmdOverride =
    typeof claudeBin === "string" && claudeBin.trim().length > 0
      ? claudeBin.trim()
      : claudeLookup.path;
  const codexBackend =
    deps.codexBackend ??
    createCodexBackend({
      ...(codexCmdOverride !== null ? { codexCommand: codexCmdOverride } : {}),
      defaultModel: process.env.CODEX_DEFAULT_MODEL,
      idleTimeoutMs: readEnvInt("CODEX_IDLE_TIMEOUT_MS", 60_000),
      hardTimeoutMs: readEnvInt("CODEX_HARD_TIMEOUT_MS", 300_000)
    });
  const claudeBackend =
    deps.claudeBackend ??
    createClaudeBackend({
      ...(claudeCmdOverride !== null ? { claudeCommand: claudeCmdOverride } : {}),
      defaultModel: process.env.CLAUDE_DEFAULT_MODEL,
      idleTimeoutMs: readEnvInt("CLAUDE_IDLE_TIMEOUT_MS", 60_000),
      hardTimeoutMs: readEnvInt("CLAUDE_HARD_TIMEOUT_MS", 300_000)
    });
  const binaryDiscovery = {
    codex: codexLookup,
    claude: claudeLookup
  };
  const ollamaBackend =
    deps.ollamaBackend ?? createOllamaBackend({ baseUrl: process.env.OLLAMA_BASE_URL });

  /**
   * Shared CLI-backend chat handler used by both /codex and /claude. Both
   * backends expose the same `runTurn` Ollama-NDJSON-via-onEvent surface, so
   * the HTTP wrapper is identical apart from which backend is invoked.
   */
  async function handleCliBackendChat(req, res, backend) {
    const raw = await readBody(req, res);
    const body = parseJson(raw);
    if (!body || !Array.isArray(body.messages)) {
      writeJson(res, 400, { error: "expected JSON body with messages[]" });
      return;
    }
    const stream = body.stream !== false; // default true (Ollama default)
    const model = typeof body.model === "string" && body.model.length > 0 ? body.model : undefined;

    const controller = new AbortController();
    const onClose = () => controller.abort();
    req.on("close", onClose);

    if (stream) {
      writeNdjsonHeaders(res);
      const write = (chunk) => {
        res.write(`${JSON.stringify(chunk)}\n`);
      };
      try {
        await backend.runTurn({
          messages: body.messages,
          model,
          onEvent: write,
          signal: controller.signal
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        write({
          model: model ?? "",
          created_at: nowIso(),
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "error",
          error: message
        });
      }
      res.end();
      return;
    }

    // Non-streaming: accumulate, then emit one Ollama-shape object.
    let assembled = "";
    let terminal = null;
    try {
      await backend.runTurn({
        messages: body.messages,
        model,
        onEvent: (chunk) => {
          if (chunk.done) {
            terminal = chunk;
          } else if (chunk.message && typeof chunk.message.content === "string") {
            assembled += chunk.message.content;
          }
        },
        signal: controller.signal
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeJson(res, 500, { error: message });
      return;
    }
    const created = nowIso();
    writeJson(res, 200, {
      model: model ?? "",
      created_at: created,
      message: { role: "assistant", content: assembled },
      done: true,
      done_reason: terminal && terminal.done_reason ? terminal.done_reason : "stop",
      ...(terminal && terminal.error ? { error: terminal.error } : {})
    });
  }

  function handleCodexChat(req, res) {
    return handleCliBackendChat(req, res, codexBackend);
  }

  function handleClaudeChat(req, res) {
    return handleCliBackendChat(req, res, claudeBackend);
  }

  async function handleOllamaChat(req, res) {
    const raw = await readBody(req, res);
    // Quick sanity: still POST JSON; but we forward verbatim regardless.
    const body = parseJson(raw);
    if (!body || !Array.isArray(body.messages)) {
      writeJson(res, 400, { error: "expected JSON body with messages[]" });
      return;
    }
    const stream = body.stream !== false;

    const controller = new AbortController();
    const onClose = () => controller.abort();
    req.on("close", onClose);

    if (stream) {
      writeNdjsonHeaders(res);
      await ollamaBackend.forwardChat({
        bodyRaw: raw,
        onChunk: (chunk) => res.write(chunk),
        onEnd: () => res.end(),
        onError: (err) => {
          try {
            res.write(
              `${JSON.stringify({
                model: typeof body.model === "string" ? body.model : "",
                created_at: nowIso(),
                message: { role: "assistant", content: "" },
                done: true,
                done_reason: "error",
                error: err.message
              })}\n`
            );
          } catch {
            // socket may already be closed
          }
          res.end();
        },
        signal: controller.signal
      });
      return;
    }

    // Non-streaming: collect Ollama's response (still NDJSON when stream:false
    // returns a single object) and emit verbatim.
    const collected = [];
    await ollamaBackend.forwardChat({
      bodyRaw: raw,
      onChunk: (chunk) =>
        collected.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk)),
      onEnd: () => {},
      onError: () => {},
      signal: controller.signal
    });
    const merged = Buffer.concat(collected).toString("utf8");
    // Ollama with stream:false returns one JSON object directly.
    const parsed = parseJson(merged.trim().split("\n").pop() ?? "");
    if (parsed) {
      writeJson(res, 200, parsed);
    } else {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(merged);
    }
  }

  async function handleCodexTags(_req, res) {
    writeJson(res, 200, { models: codexBackend.tags() });
  }

  async function handleClaudeTags(_req, res) {
    writeJson(res, 200, { models: claudeBackend.tags() });
  }

  async function handleOllamaTags(_req, res) {
    const tags = await ollamaBackend.tags();
    writeJson(res, 200, tags);
  }

  async function handleCombinedTags(req, res) {
    const ollama = await ollamaBackend.tags();
    const ollamaModels = Array.isArray(ollama.models) ? ollama.models : [];
    const merged = [...ollamaModels, ...codexBackend.tags(), ...claudeBackend.tags()];
    writeJson(res, 200, { models: merged });
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        // Transport policy (Host + Origin) runs BEFORE any route
        // dispatch so a misconfigured client can never reach a body-
        // reading handler. The bearer-token check is per-route
        // (`enforceBearerPolicy`) — most routes require it, but
        // `/api/shutdown` and `GET /` opt out by design (see below).
        if (!enforceTransportPolicy(req, res)) return;
        const url = req.url ?? "";
        const method = req.method ?? "GET";
        if (method === "POST" && url === "/codex/api/chat") {
          if (!enforceBearerPolicy(req, res)) return;
          await handleCodexChat(req, res);
          return;
        }
        if (method === "POST" && url === "/claude/api/chat") {
          if (!enforceBearerPolicy(req, res)) return;
          await handleClaudeChat(req, res);
          return;
        }
        if (method === "POST" && url === "/ollama/api/chat") {
          if (!enforceBearerPolicy(req, res)) return;
          await handleOllamaChat(req, res);
          return;
        }
        if (method === "GET" && url === "/codex/api/tags") {
          if (!enforceBearerPolicy(req, res)) return;
          return handleCodexTags(req, res);
        }
        if (method === "GET" && url === "/claude/api/tags") {
          if (!enforceBearerPolicy(req, res)) return;
          return handleClaudeTags(req, res);
        }
        if (method === "GET" && url === "/ollama/api/tags") {
          if (!enforceBearerPolicy(req, res)) return;
          return handleOllamaTags(req, res);
        }
        if (method === "GET" && url === "/api/tags") {
          if (!enforceBearerPolicy(req, res)) return;
          return handleCombinedTags(req, res);
        }
        // Codex embeddings are not supported; surface a clear error rather than
        // 404 to help users debug provider-profile misconfiguration.
        if (method === "POST" && url === "/codex/api/embed") {
          if (!enforceBearerPolicy(req, res)) return;
          writeJson(res, 501, {
            error:
              "Codex backend does not support embeddings. Use the /ollama route or a remote embedding provider."
          });
          return;
        }
        if (method === "POST" && url === "/claude/api/embed") {
          if (!enforceBearerPolicy(req, res)) return;
          writeJson(res, 501, {
            error:
              "Claude backend does not support embeddings. Use the /ollama route or a remote embedding provider."
          });
          return;
        }
        if (method === "POST" && url === "/ollama/api/embed") {
          if (!enforceBearerPolicy(req, res)) return;
          // Passthrough embeddings to real Ollama. Keep it minimal — just
          // forward request body and response body.
          const raw = await readBody(req, res);
          const fetchImpl = globalThis.fetch;
          const r = await fetchImpl(`${ollamaBackend.baseUrl}/api/embed`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: raw
          });
          const txt = await r.text();
          res.writeHead(r.status, {
            "content-type": r.headers.get("content-type") ?? "application/json"
          });
          res.end(txt);
          return;
        }
        if (method === "GET" && url === "/api/diagnostics") {
          // Bearer-gated: the diagnostics payload leaks codex/claude
          // binary paths, which we don't want to hand to other local
          // processes on the machine. The plugin sends the bearer
          // explicitly from `wire-proxy-lifecycle.ts:fetchDiagnostics`.
          if (!enforceBearerPolicy(req, res)) return;
          // Bug B2 surface: report what the proxy found at startup so
          // the plugin's settings dialog can render "Codex CLI: found at
          // /opt/homebrew/bin/codex" or "Codex CLI: NOT FOUND (set
          // PROXY_CODEX_BIN)" — without this, ENOENT spawn failures look
          // like generic "codex exited with code -1" mysteries.
          // Codex review #2: keep the response minimal. The proxy
          // binds 127.0.0.1, so the threat model is "other local
          // processes on this machine" — but we still don't need to
          // hand over the full PATH env or every $HOME-bearing path
          // we tried. The UI only needs (a) did we find the binary
          // and where, (b) was PATH enriched and from which shell.
          // When a binary is MISSING we surface a redacted count of
          // searched directories so the user gets a hint without
          // exposing usernames.
          writeJson(res, 200, {
            binaries: {
              codex: summarizeBinaryLookup(binaryDiscovery.codex),
              claude: summarizeBinaryLookup(binaryDiscovery.claude)
            },
            path: {
              enrichment:
                pathEnrichmentSnapshot !== null
                  ? {
                      source: pathEnrichmentSnapshot.source,
                      shellUsed: pathEnrichmentSnapshot.shellUsed ?? null,
                      addedCount: pathEnrichmentSnapshot.added.length
                    }
                  : null
            }
          });
          return;
        }
        if (method === "POST" && url === "/api/shutdown") {
          // INTENTIONALLY bearer-exempt. The orphan-takeover path in
          // `src/platform/wire-proxy-lifecycle.ts:tryTakeoverOrphan`
          // POSTs here when a new plugin instance detects a stale proxy
          // listening on the configured port (typical after a Zotero
          // restart with the prior session's child still alive). The
          // new instance cannot know the orphan's token — it died with
          // the prior process — so requiring bearer here would 401 the
          // takeover and leave the user stuck with a stale proxy until
          // they manually killed it. The local-only Host + Origin gates
          // above still block any network attacker; the only attack
          // vector that survives is "another local process can ask the
          // proxy to exit", which is an acceptable DoS on a single-user
          // desktop.
          //
          // Owner-controlled shutdown. The plugin's proxy-lifecycle calls
          // this when it detects an orphaned proxy on the configured port
          // (the typical "stale CLI event shape after XPI upgrade" loop)
          // and wants to take over before spawning fresh. The endpoint
          // identifies us as ours — a foreign service on the same port
          // returns 404 here and survives. We respond 200 with `{exiting:true}`
          // BEFORE close()/exit so the caller's POST resolves cleanly,
          // then close the server and exit on the next tick.
          writeJson(res, 200, { exiting: true });
          setImmediate(() => {
            try {
              server.close();
            } catch {
              // ignore — server may already be tearing down
            }
            // unref to let any pending requests finish their already-sent
            // bytes, but cap with a hard exit so a wedged child doesn't
            // hang waiting on a stuck stream.
            setTimeout(() => process.exit(0), 250).unref();
          });
          return;
        }
        if (method === "GET" && url === "/") {
          // Bearer-exempt: returns only a static route catalog (no
          // configuration, no binary paths, no secrets). The Host +
          // Origin gates above still apply so a browser visiting
          // http://127.0.0.1:<port>/ from a foreign tab is rejected.
          writeJson(res, 200, {
            name: "zotero-ai-llm-proxy",
            routes: [
              "POST /codex/api/chat",
              "POST /claude/api/chat",
              "POST /ollama/api/chat",
              "GET /codex/api/tags",
              "GET /claude/api/tags",
              "GET /ollama/api/tags",
              "GET /api/tags",
              "GET /api/diagnostics",
              "POST /api/shutdown"
            ]
          });
          return;
        }
        writeJson(res, 404, { error: `not found: ${method} ${url}` });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Body-limit overflow: `readBody` already wrote the 413
        // response (we needed to answer the client without waiting
        // for the upload to finish), so the outer catch just swallows
        // the rejection. Any other thrown error becomes a 500 — but
        // only when headers haven't already been sent.
        const code = err instanceof Error ? /** @type {{ code?: string }} */ (err).code : undefined;
        if (code === "EBODYLIMIT") {
          return;
        }
        try {
          if (!res.headersSent) writeJson(res, 500, { error: message });
        } catch {
          // headers already written
          try {
            res.end();
          } catch {
            // ignore
          }
        }
      }
    })();
  });

  return {
    server,
    codexBackend,
    claudeBackend,
    ollamaBackend,
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          const addr = server.address();
          if (addr && typeof addr === "object") {
            // Build the Host-gate allowlist once per server instance,
            // here at `listen()`-resolve time (the OS-assigned port is
            // immutable for the rest of the server's lifetime). The
            // Host gate consults this Set on every request instead of
            // rebuilding it from scratch.
            allowedHostsSet = new Set([
              `127.0.0.1:${String(addr.port)}`,
              `localhost:${String(addr.port)}`,
              "127.0.0.1",
              "localhost"
            ]);
            // Auth-state canary so a misconfigured production spawn
            // (env var dropped on the floor) shouts loudly in the
            // Zotero error console. The wiring layer always sets the
            // env var; surfacing this on the no-auth fallback catches
            // wiring bugs at the point of failure rather than at the
            // first 200-OK-from-anyone request.
            if (AUTH_TOKEN === null) {
              console.warn(
                `llm-proxy: AUTH DISABLED — set ${LLM_PROXY_AUTH_TOKEN_ENV} to enable bearer auth`
              );
            } else {
              console.log(
                `llm-proxy: auth enabled on 127.0.0.1:${String(addr.port)} (token length ${String(AUTH_TOKEN.length)})`
              );
            }
            resolve(addr.port);
          } else {
            reject(new Error("could not determine listen port"));
          }
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}

/**
 * Cross-platform "parent-died" detector.
 *
 * macOS has no `prctl(PR_SET_PDEATHSIG)` and POSIX has no automatic
 * child-cleanup on parent death; when Zotero is force-quit / crashes
 * / OS-killed, the proxy is reparented to launchd (PID 1) and survives
 * as an orphan holding the configured port. The plugin's clean-exit JS
 * callback only fires on a graceful Zotero shutdown, so orphans
 * accumulate across crashes.
 *
 * The reliable cross-platform trick: when the parent process dies, the
 * OS closes the writable end of any pipe the parent had to the child's
 * stdin. The child then sees stdin emit `'end'` (clean EOF) or
 * `'error'` (rare; e.g. EBADF). Mozilla's `Subprocess.sys.mjs` always
 * spawns children with stdin as a pipe (it's a writable stream on
 * `proc.stdin`), so the EOF arrives reliably under chrome.
 *
 * Edge cases:
 *   - `node server.mjs < /dev/null`: stdin EOFs immediately at startup.
 *     This is intended — no parent is writing, so there's nothing to
 *     wait on. The dev workflow (`npm run proxy:llm` from a terminal)
 *     keeps a TTY attached, so EOF only arrives on Ctrl-D.
 *   - Concurrent SIGTERM + EOF: the caller's `shutdownFn` MUST be
 *     idempotent (single-shot). See the `shuttingDown` guard below.
 *
 * Without `process.stdin.resume()` Node's default-paused stdin never
 * emits `'end'` — the kernel-level EOF is buffered but the JS event
 * loop never observes it. `.resume()` opts in to the byte stream.
 *
 * @param {(signal: string) => void} shutdownFn
 */
function installParentDeathDetector(shutdownFn) {
  process.stdin.on("end", () => shutdownFn("stdin-eof"));
  process.stdin.on("error", (err) => {
    console.error(`zotero-ai-llm-proxy: stdin error: ${err?.message ?? String(err)}`);
    shutdownFn("stdin-error");
  });
  process.stdin.resume();
}

// Entrypoint: only run when invoked directly (node scripts/llm-proxy/server.mjs).
// `file://${process.argv[1]}` would naively concatenate a Windows-style
// `D:\a\...` path into a URL, producing unescaped backslashes that don't
// match `import.meta.url`'s percent-encoded URL form. Use `pathToFileURL`
// so the comparison works on every platform.
const isDirect =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  const port = readEnvInt("LLM_PROXY_PORT", DEFAULT_PORT);
  // Bug B2: macOS GUI apps (Zotero, Firefox) spawn the proxy with the
  // minimal `PATH=/usr/bin:/bin:/usr/sbin:/sbin` — no Homebrew, no
  // /usr/local, no asdf, no cargo. Discover the user's real login-shell
  // PATH and merge it in BEFORE we resolve codex/claude binaries. The
  // discovery is best-effort and never blocks: a broken .zshrc or an
  // unknown shell falls back to a static list of common prefixes.
  enrichEnvironmentPath().then(
    (enrichment) => {
      if (enrichment.added.length > 0) {
        console.log(
          `zotero-ai-llm-proxy: enriched PATH (${enrichment.source}) with ${enrichment.added.length} entries`
        );
      }
      const proxy = createProxyServer({ pathEnrichment: enrichment });
      proxy.listen(port).then(
        (actual) => {
          console.log(`zotero-ai-llm-proxy listening on http://127.0.0.1:${String(actual)}`);

          console.log(`  /codex   → Codex CLI (multi-turn session_id resume)`);

          console.log(`  /claude  → Claude Code CLI (multi-turn --resume)`);

          console.log(`  /ollama  → ${proxy.ollamaBackend.baseUrl}`);
        },
        (err) => {
          console.error(`zotero-ai-llm-proxy failed to bind: ${err.message}`);
          process.exit(1);
        }
      );

      // Single-shot guard: EOF on stdin may arrive concurrently with a
      // SIGTERM the lifecycle controller is sending. Both code paths call
      // `shutdown`, so without a guard we'd hit `process.exit(0)` twice
      // (the second after `proxy.close()` resolves on a torn-down server).
      let shuttingDown = false;
      const shutdown = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`zotero-ai-llm-proxy: received ${signal}, shutting down`);
        proxy.close().then(() => process.exit(0));
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      installParentDeathDetector(shutdown);
    },
    (err) => {
      // enrichEnvironmentPath promises to never reject, but defend in
      // depth — a single missed catch shouldn't take down the proxy.
      console.error(
        `zotero-ai-llm-proxy: PATH enrichment unexpectedly failed: ${err?.message ?? String(err)}`
      );
      process.exit(1);
    }
  );
}
