/**
 * Fake Ollama HTTP server for e2e tests.
 *
 * Listens on an ephemeral port and serves the two endpoints the plugin
 * talks to:
 *   - POST /api/chat   → newline-delimited JSON chunks shaped like the
 *                        real Ollama streaming response.
 *   - POST /api/embed  → a single deterministic embedding vector.
 *
 * Every received request is recorded under `server.requests` so the
 * vitest suite can assert on routing (e.g. the plugin really POSTs to
 * `/api/chat` and not the default URL).
 *
 * Adversarial knobs (each is optional; defaults preserve the historical
 * two-delta behaviour):
 *   - `chatChunks`           — explicit chunk array (overrides `chatChunkCount`).
 *   - `chatChunkCount`       — generate this many "line N\n" deltas + a
 *                              terminal `done` chunk. Used to test that the
 *                              popup body is scrollable when the response is
 *                              long.
 *   - `firstChunkDelayMs`    — wait this long after receiving the chat POST
 *                              before writing the first chunk. Used to verify
 *                              that a loading indicator is shown DURING the
 *                              window between click and first delta.
 *   - `chunkDelayMs`         — wait this long between subsequent chunks.
 *   - `errorResponse`        — when true, respond with HTTP 500 + a plain
 *                              error body. Used to test error paths.
 *
 * Options may be mutated at runtime via `server.setOptions({...})` so a
 * single server instance can serve multiple adversarial scenarios across
 * sequential test phases without restart.
 */

import { createServer } from "node:http";

function defaultChunks() {
  return [
    { message: { content: "Hello " }, done: false },
    { message: { content: "world" }, done: true }
  ];
}

function generatedChunks(count) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    out.push({ message: { content: `line ${String(i)}\n` }, done: false });
  }
  out.push({ message: { content: "" }, done: true });
  return out;
}

function delay(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function createFakeOllamaServer(initialOptions = {}) {
  let options = { ...initialOptions };
  const requests = [];

  function resolveChunks() {
    if (Array.isArray(options.chatChunks) && options.chatChunks.length > 0) {
      return options.chatChunks;
    }
    if (typeof options.chatChunkCount === "number" && options.chatChunkCount > 0) {
      return generatedChunks(options.chatChunkCount);
    }
    return defaultChunks();
  }

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      void (async () => {
        const bodyRaw = Buffer.concat(chunks).toString("utf8");
        let bodyParsed = null;
        try {
          bodyParsed = bodyRaw.length > 0 ? JSON.parse(bodyRaw) : null;
        } catch {
          bodyParsed = null;
        }
        const entry = {
          method: req.method,
          url: req.url,
          bodyRaw,
          bodyParsed,
          receivedAt: Date.now()
        };
        requests.push(entry);

        if (options.errorResponse === true) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("fake ollama: simulated error");
          return;
        }

        if (req.method === "POST" && req.url === "/api/chat") {
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          const effectiveChunks = resolveChunks();
          const firstDelay =
            typeof options.firstChunkDelayMs === "number" ? options.firstChunkDelayMs : 0;
          const chunkDelay = typeof options.chunkDelayMs === "number" ? options.chunkDelayMs : 0;
          await delay(firstDelay);
          for (let i = 0; i < effectiveChunks.length; i++) {
            const chunk = effectiveChunks[i];
            res.write(`${JSON.stringify(chunk)}\n`);
            if (i < effectiveChunks.length - 1 && chunkDelay > 0) {
              await delay(chunkDelay);
            }
          }
          res.end();
          return;
        }
        if (req.method === "POST" && req.url === "/api/embed") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }));
          return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      })();
    });
  });

  function start() {
    return new Promise((resolveStart, rejectStart) => {
      server.once("error", rejectStart);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (typeof address === "object" && address !== null) {
          resolveStart(`http://127.0.0.1:${String(address.port)}`);
        } else {
          rejectStart(new Error("fake ollama: could not determine port"));
        }
      });
    });
  }

  function stop() {
    return new Promise((resolveStop) => {
      server.close(() => resolveStop());
    });
  }

  function setOptions(next) {
    options = { ...options, ...next };
  }

  return {
    start,
    stop,
    setOptions,
    get requests() {
      return requests;
    },
    clearRequests() {
      requests.length = 0;
    }
  };
}
