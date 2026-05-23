/**
 * Full-subprocess integration for the codex CLI proxy path: spawns the
 * real `scripts/llm-proxy/server.mjs` with `PROXY_CODEX_BIN` pointed at
 * a fake codex that replays the live `codex exec --json` event stream,
 * then drives it through the real ollama provider adapter (the same
 * adapter the popup uses).
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
 * Write a fake `codex` executable that replays the live event stream we
 * captured from `codex exec --json --model gpt-5.5 -`. The script is
 * POSIX-portable (`/bin/bash` shebang + heredoc) so it runs on every
 * supported platform without depending on user-installed CLIs.
 */
function writeFakeCodex(dir: string, text: string): string {
  const path = join(dir, "fake-codex");
  // The script ignores --json / --skip-git-repo-check / --model X / `-`
  // and the prompt on stdin. It emits the real codex CLI event ordering
  // observed live: thread.started, turn.started, an `item.completed`
  // command_execution (which must NOT leak into the popup), then the
  // assistant message wrapped in `item.completed` / `agent_message`,
  // then turn.completed. The agent text is interpolated from `text` so
  // the test can assert against a specific known-string.
  const script = [
    `#!/bin/bash`,
    // Consume stdin so the producing side doesn't error on EPIPE.
    `cat > /dev/null`,
    `cat <<'JSON'`,
    `{"type":"thread.started","thread_id":"thread-fixture-1"}`,
    `{"type":"turn.started"}`,
    `{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"true","aggregated_output":"<<<must-not-leak>>>","exit_code":0,"status":"completed"}}`,
    `{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"__AGENT_TEXT__"}}`,
    `{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`,
    `JSON`,
    ``
  ].join("\n");
  writeFileSync(path, script.replace("__AGENT_TEXT__", text), "utf8");
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
    stdio: ["ignore", "pipe", "pipe"]
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

describe("codex CLI proxy pipeline (real subprocess + real HTTP)", () => {
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
    const deltaText = events
      .filter((e): e is Extract<ChatEvent, { type: "delta" }> => e.type === "delta")
      .map((d) => d.text)
      .join("");
    expect(deltaText).toBe("hello world");
    // The tool-call envelope (command_execution `aggregated_output`)
    // must not leak — verifies the suppression branch in
    // extractDeltaText for non-agent_message item types.
    expect(deltaText).not.toContain("must-not-leak");
    // No in-band error event — the stream completed cleanly.
    expect(events.find((e) => e.type === "error")).toBeUndefined();
    // The terminal event from the ollama adapter is `message_end` once
    // the proxy's `done:true` lands.
    expect(events[events.length - 1]?.type).toBe("message_end");
  });
});
