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

import { createServer } from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createClaudeBackend } from "./backends/claude.mjs";
import { createCodexBackend } from "./backends/codex.mjs";
import { createOllamaBackend } from "./backends/ollama.mjs";
import { enrichEnvironmentPath, findBinary } from "./path-discovery.mjs";

const DEFAULT_PORT = 11400;

function readEnvInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
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
    const raw = await readBody(req);
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
    const raw = await readBody(req);
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
        const url = req.url ?? "";
        const method = req.method ?? "GET";
        if (method === "POST" && url === "/codex/api/chat") return handleCodexChat(req, res);
        if (method === "POST" && url === "/claude/api/chat") return handleClaudeChat(req, res);
        if (method === "POST" && url === "/ollama/api/chat") return handleOllamaChat(req, res);
        if (method === "GET" && url === "/codex/api/tags") return handleCodexTags(req, res);
        if (method === "GET" && url === "/claude/api/tags") return handleClaudeTags(req, res);
        if (method === "GET" && url === "/ollama/api/tags") return handleOllamaTags(req, res);
        if (method === "GET" && url === "/api/tags") return handleCombinedTags(req, res);
        // Codex embeddings are not supported; surface a clear error rather than
        // 404 to help users debug provider-profile misconfiguration.
        if (method === "POST" && url === "/codex/api/embed") {
          writeJson(res, 501, {
            error:
              "Codex backend does not support embeddings. Use the /ollama route or a remote embedding provider."
          });
          return;
        }
        if (method === "POST" && url === "/claude/api/embed") {
          writeJson(res, 501, {
            error:
              "Claude backend does not support embeddings. Use the /ollama route or a remote embedding provider."
          });
          return;
        }
        if (method === "POST" && url === "/ollama/api/embed") {
          // Passthrough embeddings to real Ollama. Keep it minimal — just
          // forward request body and response body.
          const raw = await readBody(req);
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
        try {
          writeJson(res, 500, { error: message });
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
          if (addr && typeof addr === "object") resolve(addr.port);
          else reject(new Error("could not determine listen port"));
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
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

      const shutdown = (signal) => {
        console.log(`zotero-ai-llm-proxy: received ${signal}, shutting down`);
        proxy.close().then(() => process.exit(0));
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
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
