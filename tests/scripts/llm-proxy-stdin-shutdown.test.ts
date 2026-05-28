/**
 * Real-subprocess coverage for the proxy's stdin-EOF self-termination
 * path (`installParentDeathDetector` in `scripts/llm-proxy/server.mjs`).
 *
 * Why a real spawn: the EOF mechanism depends on kernel-level pipe
 * closure, Node's process.stdin event wiring, and our `.resume()` call
 * playing well together. In-process tests can't model "parent closes
 * the writable end of the child's stdin pipe" — that's an OS contract,
 * not a JS one. We spawn the server via `node:child_process.spawn` with
 * `stdio: ["pipe", "pipe", "pipe"]`, wait for the "listening on"
 * banner, then close our end of stdin and assert the child exits.
 *
 * Why POSIX-only: the EOF path works on Linux + macOS reliably. Windows
 * pipe semantics differ enough (no real fork; Subprocess.sys.mjs uses
 * named pipes) that we don't gate Windows release on this; the
 * orphan-takeover path (`POST /api/shutdown`) covers cleanup there.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVER_SCRIPT = join(REPO_ROOT, "scripts", "llm-proxy", "server.mjs");

const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

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
 * Resolve when the spawned proxy logs its "listening on" banner; reject
 * if the timer fires first. Listening implies the HTTP server is bound
 * AND the entry block has installed signal + stdin handlers (both run
 * in the same `.then` after `listen()`).
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

/** Resolve with the child's exit code (or null when killed by signal). */
function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`child did not exit within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

type Spawned = {
  readonly child: ChildProcess;
  readonly port: number;
  readonly stderrBuf: string[];
};

async function startProxy(): Promise<Spawned> {
  const port = await pickFreePort();
  // Stripped PATH so the child can't fall back to a real codex / claude
  // / ollama on the host machine. We only test the entry block, not the
  // backend routes — no env beyond port is needed.
  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    env: {
      ...process.env,
      LLM_PROXY_PORT: String(port),
      PATH: "/usr/bin:/bin"
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  // `stdio: ["pipe","pipe","pipe"]` narrows stdout/stderr/stdin to
  // non-null in the inferred type — no runtime null check needed.
  const { stdout, stderr } = child;
  stdout.setEncoding("utf8");
  stderr.setEncoding("utf8");
  const stderrBuf: string[] = [];
  stderr.on("data", (chunk: string) => stderrBuf.push(chunk));
  try {
    await waitForListening(stdout, 5_000);
  } catch (err) {
    child.kill("SIGKILL");
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\nproxy stderr: ${stderrBuf.join("")}`
    );
  }
  return { child, port, stderrBuf };
}

describeOnPosix("llm-proxy stdin-EOF self-termination", () => {
  let spawned: Spawned | null = null;

  afterEach(() => {
    // Hard cleanup so a leaked child doesn't hold the OS-assigned port
    // across the next test run.
    if (spawned !== null && !spawned.child.killed && spawned.child.exitCode === null) {
      spawned.child.kill("SIGKILL");
    }
    spawned = null;
  });

  it("SE-1: closing parent-side stdin causes the child to exit 0 within 2000ms", async () => {
    spawned = await startProxy();
    const exitPromise = waitForExit(spawned.child, 2_000);
    // Close our writable end of the child's stdin. The kernel delivers
    // EOF to the child's read end, Node emits `'end'` on process.stdin,
    // the handler calls `shutdown("stdin-eof")`, which runs
    // `proxy.close()` then `process.exit(0)`.
    spawned.child.stdin?.end();
    const code = await exitPromise;
    expect(code).toBe(0);
  }, 10_000);

  it("SE-2: shutdown log line names the stdin-eof signal source", async () => {
    spawned = await startProxy();
    const stdoutBuf: string[] = [];
    spawned.child.stdout?.on("data", (chunk: string) => stdoutBuf.push(chunk));
    const exitPromise = waitForExit(spawned.child, 2_000);
    spawned.child.stdin?.end();
    await exitPromise;
    // The shared `shutdown(signal)` closure logs the signal name; the
    // stdin handler passes "stdin-eof" so the log is operator-readable
    // and distinguishable from a SIGTERM-driven shutdown in field logs.
    expect(stdoutBuf.join("")).toContain("stdin-eof");
  }, 10_000);

  it("SE-3: SIGTERM after stdin EOF does not double-exit or throw", async () => {
    spawned = await startProxy();
    const exitPromise = waitForExit(spawned.child, 3_000);
    // Race: close stdin AND immediately send SIGTERM. The single-shot
    // `shuttingDown` guard must collapse both into a single shutdown
    // path; without the guard, `proxy.close()` would be called twice
    // and the second `process.exit(0)` would either be redundant
    // (harmless) or throw if it races server teardown.
    spawned.child.stdin?.end();
    spawned.child.kill("SIGTERM");
    const code = await exitPromise;
    // Either signal path arrived first; both terminate with code 0.
    // The key correctness condition is "exits cleanly without an
    // unhandled rejection / crash". `stderr` should not contain
    // "UnhandledPromiseRejection" or similar.
    expect(code).toBe(0);
    expect(spawned.stderrBuf.join("")).not.toMatch(/UnhandledPromise|TypeError|RangeError/);
  }, 15_000);
});
