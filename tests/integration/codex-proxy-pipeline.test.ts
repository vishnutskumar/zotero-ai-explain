/**
 * Full-subprocess integration for the codex CLI proxy path: spawns the
 * real `scripts/llm-proxy/server.mjs` with `PROXY_CODEX_BIN` pointed at
 * a fake `codex mcp-server` that speaks the MCP JSON-RPC wire shape the
 * real backend now drives, then drives it through the real ollama
 * provider adapter (the same adapter the popup uses).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOllamaProvider } from "../../src/providers/adapters/ollama.js";
import type { ChatEvent } from "../../src/providers/provider-types.js";

// `new URL("../..", import.meta.url).pathname` returns `/D:/...` on Windows
// (leading slash + drive letter); a subsequent `path.join` then produces a
// `D:\D:\...` double-drive-prefix string and the spawn ENOENTs. Use
// `fileURLToPath` so we get a native Windows path on Windows and a POSIX
// path elsewhere.
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER_SCRIPT = join(REPO_ROOT, "scripts", "llm-proxy", "server.mjs");

type Spawned = {
  readonly child: ChildProcess;
  readonly port: number;
  readonly tempDir: string;
};

async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("could not get free port"));
        return;
      }
      const { port } = addr;
      s.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * Write a fake `codex mcp-server` executable that speaks the same MCP
 * JSON-RPC wire shape the real backend now drives. The fake is a
 * self-contained Node ESM script — the shebang resolves to the current
 * Node binary via `process.execPath` so we do NOT depend on `node`
 * being on the (deliberately restricted) test PATH.
 *
 * Behaviour:
 *   1. Read JSON-RPC frames from stdin line-by-line. The proxy backend
 *      sends three frames per turn: `initialize` (id 0),
 *      `notifications/initialized` (no id), and `tools/call` (id 1).
 *      Frames before the `tools/call` are simply discarded.
 *   2. On the `tools/call` request, the fake emits (each as one
 *      `\n`-terminated JSON object):
 *        a) A `session_configured` framing notification whose nested
 *           `text` field embeds `<<<must-not-leak>>>` — verifies the
 *           denylist suppression end-to-end.
 *        b) Two `agent_message_content_delta` notifications carrying
 *           "hello " and "world" respectively, with a short delay
 *           between writes so the deltas arrive as distinct chunks
 *           in the consuming side (proves streaming, not just content).
 *        c) The denylisted `item_completed AgentMessage` terminal
 *           envelope carrying the FULL assembled text — verifies that
 *           the extractor's terminal-envelope denylist prevents the
 *           response from replaying after the deltas.
 *        d) The `id:1` tools/call response with
 *           `structuredContent.threadId` — receiving this is what
 *           causes the proxy backend to close stdin so the fake exits.
 *   3. Exit 0 when stdin closes.
 *
 * The script is POSIX-only because the existing `describeOnPosix`
 * skip (file:~190) already excludes Windows. A future cross-platform
 * port can change the shebang resolution; out of scope here.
 */
function writeFakeCodex(dir: string, text: string): string {
  const path = join(dir, "fake-codex");
  // Split the agent text into at least two chunks so the consuming
  // side observes streaming (≥2 distinct `done:false` deltas).
  const split = Math.max(1, Math.floor(text.length / 2));
  const piece1 = text.slice(0, split);
  const piece2 = text.slice(split);
  // The fake script. Templated values are JSON-stringified into the
  // body so embedded quotes / backslashes are safe.
  const script = `#!${process.execPath}
import { createInterface } from "node:readline";
const TEXT = ${JSON.stringify(text)};
const PIECE_1 = ${JSON.stringify(piece1)};
const PIECE_2 = ${JSON.stringify(piece2)};
const THREAD_ID = "thread-fixture-1";
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function respond() {
  // (a) Denylisted framing envelope carrying a must-not-leak string —
  // proves the extractor's framing denylist works end-to-end.
  emit({
    jsonrpc: "2.0",
    method: "codex/event",
    params: {
      _meta: { threadId: THREAD_ID },
      msg: {
        type: "session_configured",
        session_id: THREAD_ID,
        text: "<<<must-not-leak>>>"
      }
    }
  });
  // (b) Two streamed deltas.
  emit({
    jsonrpc: "2.0",
    method: "codex/event",
    params: {
      _meta: { threadId: THREAD_ID },
      msg: { type: "agent_message_content_delta", item_id: "msg_0", delta: PIECE_1 }
    }
  });
  await sleep(10);
  emit({
    jsonrpc: "2.0",
    method: "codex/event",
    params: {
      _meta: { threadId: THREAD_ID },
      msg: { type: "agent_message_content_delta", item_id: "msg_0", delta: PIECE_2 }
    }
  });
  // (c) Denylisted terminal envelope carrying the FULL text — proves
  // the terminal-envelope denylist prevents double emission.
  emit({
    jsonrpc: "2.0",
    method: "codex/event",
    params: {
      _meta: { threadId: THREAD_ID },
      msg: {
        type: "item_completed",
        item: {
          type: "AgentMessage",
          content: [{ type: "Text", text: TEXT }],
          phase: "final_answer"
        }
      }
    }
  });
  // (d) tools/call response — receiving this is what causes the
  // backend to close stdin so this process exits.
  emit({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: TEXT }],
      structuredContent: { threadId: THREAD_ID, content: TEXT }
    }
  });
}
const rl = createInterface({ input: process.stdin });
let responded = false;
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let frame;
  try {
    frame = JSON.parse(trimmed);
  } catch {
    return;
  }
  // The backend's third frame is tools/call with id:1. Earlier frames
  // (initialize id:0, notifications/initialized) are discarded.
  if (!responded && frame && frame.id === 1 && frame.method === "tools/call") {
    responded = true;
    respond().catch((err) => {
      process.stderr.write("fake-codex respond error: " + String(err) + "\\n");
      process.exit(1);
    });
  }
});
rl.on("close", () => {
  process.exit(0);
});
`;
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
  return path;
}

/**
 * Resolve when the spawned proxy logs its "listening on" banner —
 * the deterministic signal that the HTTP server has bound and is ready.
 * Avoids the polling-with-fetch loop (which both jitters by 50ms and
 * makes spurious early connect attempts before the server is up).
 */
function waitForListening(stdout: NodeJS.ReadableStream, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      stdout.off("data", onData);
      reject(new Error(`proxy did not announce listening within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    const onData = (chunk: string): void => {
      buffer += chunk;
      if (buffer.includes("zotero-ai-llm-proxy listening on")) {
        clearTimeout(timer);
        stdout.off("data", onData);
        resolve();
      }
    };
    stdout.on("data", onData);
  });
}

async function startProxy(text: string): Promise<Spawned> {
  const tempDir = mkdtempSync(join(tmpdir(), "codex-proxy-pipeline-"));
  const fakeBin = writeFakeCodex(tempDir, text);
  const port = await pickFreePort();
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    env: {
      ...process.env,
      PROXY_CODEX_BIN: fakeBin,
      LLM_PROXY_PORT: String(port),
      // Disable PATH enrichment so the test does not silently fall back
      // to a real codex on the host machine (CI hosts may have one).
      PATH: "/usr/bin:/bin",
      // Keep the server quiet — no banner lines to clutter test output.
      // Ignored if not honored; falls back to the default banner.
      LLM_PROXY_QUIET: "1"
    },
    // stdin MUST be a pipe (not "ignore") so the proxy's
    // `installParentDeathDetector` sees an open stdin at startup.
    // `"ignore"` connects stdin to /dev/null, which triggers immediate
    // EOF and self-shutdown — see `scripts/llm-proxy/server.mjs`.
    // The test never writes to stdin; the pipe stays open until we kill
    // the child in `stopProxy()`.
    stdio: ["pipe", "pipe", "pipe"]
  });
  // `stdio: pipe` makes these streams non-null in the inferred type.
  const { stdout, stderr } = child;
  stdout.setEncoding("utf8");
  stderr.setEncoding("utf8");
  // Capture stderr for diagnostics on failure but don't print at runtime.
  const stderrBuf: string[] = [];
  stderr.on("data", (chunk: string) => stderrBuf.push(chunk));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      // Surface a non-zero exit during the suite as part of the next assertion.
      stderrBuf.push(`\n[proxy exited with code ${String(code)}]`);
    }
  });
  try {
    await waitForListening(stdout, 5_000);
  } catch (err) {
    child.kill("SIGKILL");
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\nproxy stderr: ${stderrBuf.join("")}`
    );
  }
  return { child, port, tempDir };
}

async function stopProxy(s: Spawned): Promise<void> {
  if (!s.child.killed) {
    s.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      s.child.once("exit", () => {
        resolve();
      });
      // Hard cap so a wedged child does not block teardown.
      const timer = setTimeout(() => {
        if (!s.child.killed) s.child.kill("SIGKILL");
        resolve();
      }, 2_000);
      timer.unref();
    });
  }
  rmSync(s.tempDir, { recursive: true, force: true });
}

let proxy: Spawned | null = null;

beforeAll(async () => {
  proxy = await startProxy("hello world");
}, 30_000);

afterAll(async () => {
  if (proxy !== null) {
    await stopProxy(proxy);
    proxy = null;
  }
});

// `writeFakeCodex` emits a Node ESM script with a shebang that points
// at `process.execPath`. POSIX kernels honour the shebang and invoke
// Node directly; Windows ignores shebangs at the OS level so the spawn
// silently returns no stdout there. The pipeline coverage stays
// POSIX-only (Linux + macOS CI both exercise it); a future
// cross-platform port can swap to a `.cmd` wrapper on Windows.
const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

describeOnPosix("codex CLI proxy pipeline (real subprocess + real HTTP)", () => {
  it("ollama adapter pointed at /codex receives a delta with the agent_message text", async () => {
    if (proxy === null) throw new Error("proxy did not start");
    const provider = createOllamaProvider({ fetch: globalThis.fetch });
    const baseUrl = `http://127.0.0.1:${String(proxy.port)}/codex`;
    const events: ChatEvent[] = [];
    const controller = new AbortController();
    for await (const event of provider.streamChat(
      {
        selection: {
          itemId: 0,
          libraryId: 0,
          text: "fixture",
          context: { before: "", after: "" }
        } as never,
        messages: [{ role: "user", content: "Reply exactly: hello world" }],
        profile: { baseUrl, model: "gpt-5.5" } as never
      } as never,
      controller.signal
    )) {
      events.push(event);
    }
    // The adapter must have produced at least one delta carrying the
    // assistant text. Pre-fix this assertion failed because the proxy
    // emitted zero `message.content` deltas — the regression that
    // surfaced as "popup stuck loading".
    const deltas = events.filter(
      (e): e is Extract<ChatEvent, { type: "delta" }> => e.type === "delta"
    );
    const deltaText = deltas.map((d) => d.text).join("");
    expect(deltaText).toBe("hello world");
    // The denylisted framing envelope (`session_configured` with a
    // nested `text` field) and the terminal `item_completed
    // AgentMessage` envelope both carry strings that must NOT reach the
    // popup. `must-not-leak` proves the framing denylist; the assembled
    // "hello world" appearing EXACTLY once (above) proves the terminal
    // denylist (would otherwise be "hello worldhello world").
    expect(deltaText).not.toContain("must-not-leak");
    // Streaming proof: the fake emits two distinct
    // `agent_message_content_delta` frames ("hello " + "world") with a
    // short delay between them, so the consuming side must observe at
    // least two delta events (not one assembled blob).
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    // No in-band error event — the stream completed cleanly.
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    // The terminal event from the ollama adapter is `message_end` once
    // the proxy's `done:true` lands.
    expect(events[events.length - 1]?.type).toBe("message_end");
  });
});
