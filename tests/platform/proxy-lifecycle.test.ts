import { describe, expect, it, vi } from "vitest";

import {
  createProxyLifecycle,
  type ProxyFetch,
  type ProxyLifecycleDeps,
  type SubprocessHandle,
  type SubprocessLike
} from "../../src/platform/proxy-lifecycle.js";

/**
 * Test helper: a SubprocessLike that produces a deterministic handle
 * with an externally controllable wait() promise. The test resolves
 * the wait via `release()`; until then the child is considered
 * "running" by the lifecycle.
 */
type FakeChild = {
  readonly handle: SubprocessHandle;
  readonly kills: string[];
  /** Resolve the wait() promise with the given exit code. */
  release: (exitCode: number | null) => void;
  /** Reject the wait() promise with the given error. */
  fail: (err: Error) => void;
};

function makeFakeChild(
  pid: number,
  options?: {
    onKill?: (signal: string) => void;
    /**
     * Pre-loaded stderr chunks. The fake exposes a chrome-Subprocess-
     * shaped `readString()` that drains them in order and resolves to
     * `null` for EOF — letting the lifecycle's drainStderr loop exit.
     */
    stderrChunks?: readonly string[];
  }
): FakeChild {
  const kills: string[] = [];
  let resolveWait: ((value: { readonly exitCode: number | null }) => void) | null = null;
  let rejectWait: ((err: Error) => void) | null = null;
  const waitPromise = new Promise<{ readonly exitCode: number | null }>((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  const chunks = [...(options?.stderrChunks ?? [])];
  const handle: SubprocessHandle = {
    pid,
    wait() {
      return waitPromise;
    },
    kill(signal) {
      const s = signal ?? "SIGTERM";
      kills.push(s);
      options?.onKill?.(s);
    },
    ...(options?.stderrChunks !== undefined
      ? {
          stderr: {
            async readString(): Promise<string | null> {
              await Promise.resolve();
              if (chunks.length === 0) return null;
              return chunks.shift() ?? null;
            }
          }
        }
      : {})
  };
  return {
    handle,
    kills,
    release(exitCode) {
      resolveWait?.({ exitCode });
    },
    fail(err) {
      rejectWait?.(err);
    }
  };
}

type DeferredSpawn = {
  resolve: (child: FakeChild) => void;
  reject: (err: Error) => void;
};

function makeFakeSubprocess(): {
  readonly subprocess: SubprocessLike;
  readonly calls: {
    command: string;
    args: readonly string[];
    env: Readonly<Record<string, string>> | undefined;
  }[];
  queue: (factory: () => FakeChild | Error) => void;
  /** Queue a spawn that the test resolves manually via the returned deferred. */
  queueDeferred: () => DeferredSpawn;
  pendingChildren: FakeChild[];
} {
  const calls: {
    command: string;
    args: readonly string[];
    env: Readonly<Record<string, string>> | undefined;
  }[] = [];
  const pendingChildren: FakeChild[] = [];
  const factories: (() => FakeChild | Error | Promise<FakeChild>)[] = [];
  const callImpl: SubprocessLike["call"] = (spec) => {
    calls.push({
      command: spec.command,
      args: spec.arguments,
      env: spec.environment
    });
    const factory = factories.shift();
    if (factory === undefined) {
      return Promise.reject(new Error("no factory queued"));
    }
    const produced = factory();
    if (produced instanceof Error) {
      return Promise.reject(produced);
    }
    if (produced instanceof Promise) {
      return produced.then((child) => {
        pendingChildren.push(child);
        return child.handle;
      });
    }
    pendingChildren.push(produced);
    return Promise.resolve(produced.handle);
  };
  const subprocess: SubprocessLike = {
    call: vi.fn(callImpl)
  };
  return {
    subprocess,
    calls,
    queue(factory) {
      factories.push(factory);
    },
    queueDeferred() {
      let resolveFn: ((child: FakeChild) => void) | null = null;
      let rejectFn: ((err: Error) => void) | null = null;
      const promise = new Promise<FakeChild>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
      factories.push(() => promise);
      return {
        resolve(child) {
          resolveFn?.(child);
        },
        reject(err) {
          rejectFn?.(err);
        }
      };
    },
    pendingChildren
  };
}

function baseDeps(
  extra: Partial<ProxyLifecycleDeps> & { subprocess: SubprocessLike }
): ProxyLifecycleDeps {
  return {
    nodeBinaryPath: "/fake/node",
    serverScriptPath: "/fake/server.mjs",
    port: 11400,
    stopGracePeriodMs: 0,
    ...extra
  };
}

describe("createProxyLifecycle.start", () => {
  it("spawns the child once and returns its pid", async () => {
    const sub = makeFakeSubprocess();
    sub.queue(() => makeFakeChild(4242));
    const lifecycle = createProxyLifecycle(baseDeps({ subprocess: sub.subprocess }));

    const result = await lifecycle.start();
    expect(result).toEqual({ pid: 4242 });
    expect(sub.calls).toHaveLength(1);
    expect(sub.calls[0]).toMatchObject({
      command: "/fake/node",
      args: ["/fake/server.mjs"]
    });
    expect(sub.calls[0]?.env).toMatchObject({ LLM_PROXY_PORT: "11400" });
  });

  it("returns the existing pid when already running and does not double-spawn", async () => {
    const sub = makeFakeSubprocess();
    sub.queue(() => makeFakeChild(7777));
    const lifecycle = createProxyLifecycle(baseDeps({ subprocess: sub.subprocess }));

    const first = await lifecycle.start();
    const second = await lifecycle.start();
    expect(first).toEqual({ pid: 7777 });
    expect(second).toEqual({ pid: 7777 });
    expect(sub.calls).toHaveLength(1);
    expect(lifecycle.trackedPid()).toBe(7777);
  });

  it("returns an error result when the subprocess throws on spawn", async () => {
    const sub = makeFakeSubprocess();
    sub.queue(() => new Error("ENOENT /fake/node"));
    const lifecycle = createProxyLifecycle(baseDeps({ subprocess: sub.subprocess }));

    const result = await lifecycle.start();
    expect(result).toEqual({ error: "ENOENT /fake/node" });
    expect(lifecycle.trackedPid()).toBeNull();
  });

  it("re-spawns after the child exits on its own", async () => {
    const sub = makeFakeSubprocess();
    const first = makeFakeChild(1);
    const second = makeFakeChild(2);
    sub.queue(() => first);
    sub.queue(() => second);
    const lifecycle = createProxyLifecycle(baseDeps({ subprocess: sub.subprocess }));

    const a = await lifecycle.start();
    expect(a).toEqual({ pid: 1 });
    // Simulate crash.
    first.release(137);
    // Let the exit handler run.
    await Promise.resolve();
    await Promise.resolve();
    expect(lifecycle.trackedPid()).toBeNull();
    const b = await lifecycle.start();
    expect(b).toEqual({ pid: 2 });
  });
});

describe("createProxyLifecycle probe-before-spawn (Bug B1)", () => {
  it("skips spawn and returns { external: true } when a probe to /api/tags returns 200", async () => {
    // Regression: a manual `npm run proxy:llm` or a prior Zotero session's
    // orphan can hold the port. Spawning a second copy would EADDRINUSE-
    // crash; instead we detect-and-skip so the user's existing proxy
    // serves traffic. The Stop button then can't kill it (we don't own
    // that PID), and the snapshot exposes externallyManaged: true.
    const sub = makeFakeSubprocess();
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, status: 200 })) as ProxyFetch;
    const lifecycle = createProxyLifecycle(
      baseDeps({ subprocess: sub.subprocess, fetch: fetchSpy, probeTimeoutMs: 50 })
    );

    const result = await lifecycle.start();
    expect(result).toEqual({ external: true });
    expect(sub.calls).toHaveLength(0); // never spawned
    expect(lifecycle.trackedPid()).toBeNull();
    expect(lifecycle.isExternallyManaged()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:11400/api/tags",
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("spawns normally when the probe returns non-2xx", async () => {
    const sub = makeFakeSubprocess();
    sub.queue(() => makeFakeChild(9001));
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: false, status: 404 })) as ProxyFetch;
    const lifecycle = createProxyLifecycle(
      baseDeps({ subprocess: sub.subprocess, fetch: fetchSpy, probeTimeoutMs: 50 })
    );

    const result = await lifecycle.start();
    expect(result).toEqual({ pid: 9001 });
    expect(sub.calls).toHaveLength(1);
    expect(lifecycle.isExternallyManaged()).toBe(false);
  });

  it("spawns normally when the probe throws (ECONNREFUSED, abort, etc.)", async () => {
    const sub = makeFakeSubprocess();
    sub.queue(() => makeFakeChild(9002));
    const fetchSpy = vi.fn(() => Promise.reject(new Error("ECONNREFUSED"))) as ProxyFetch;
    const lifecycle = createProxyLifecycle(
      baseDeps({ subprocess: sub.subprocess, fetch: fetchSpy, probeTimeoutMs: 50 })
    );

    const result = await lifecycle.start();
    expect(result).toEqual({ pid: 9002 });
    expect(sub.calls).toHaveLength(1);
    expect(lifecycle.isExternallyManaged()).toBe(false);
  });

  it("falls through to spawn when no fetch is supplied (no probe possible)", async () => {
    const sub = makeFakeSubprocess();
    sub.queue(() => makeFakeChild(9003));
    const lifecycle = createProxyLifecycle(baseDeps({ subprocess: sub.subprocess }));

    const result = await lifecycle.start();
    expect(result).toEqual({ pid: 9003 });
    expect(sub.calls).toHaveLength(1);
    expect(lifecycle.isExternallyManaged()).toBe(false);
  });

  it("stop() on an externally-managed proxy clears the flag without signaling anyone", async () => {
    const sub = makeFakeSubprocess();
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, status: 200 })) as ProxyFetch;
    const lifecycle = createProxyLifecycle(
      baseDeps({ subprocess: sub.subprocess, fetch: fetchSpy, probeTimeoutMs: 50 })
    );

    await lifecycle.start();
    expect(lifecycle.isExternallyManaged()).toBe(true);

    await lifecycle.stop();
    expect(lifecycle.isExternallyManaged()).toBe(false);
    expect(sub.calls).toHaveLength(0);
  });

  it("a fresh spawn (after the external process disappears) clears the externally-managed flag", async () => {
    const sub = makeFakeSubprocess();
    // First start: probe succeeds → external.
    let probeOk = true;
    const fetchSpy = vi.fn(() =>
      Promise.resolve({ ok: probeOk, status: probeOk ? 200 : 404 })
    ) as ProxyFetch;
    sub.queue(() => makeFakeChild(9004));
    const lifecycle = createProxyLifecycle(
      baseDeps({ subprocess: sub.subprocess, fetch: fetchSpy, probeTimeoutMs: 50 })
    );

    const first = await lifecycle.start();
    expect(first).toEqual({ external: true });

    // External proxy goes away; stop() clears the flag, next start() probes
    // (fails), then spawns our own child.
    await lifecycle.stop();
    probeOk = false;
    const second = await lifecycle.start();
    expect(second).toEqual({ pid: 9004 });
    expect(lifecycle.isExternallyManaged()).toBe(false);
  });
});

describe("createProxyLifecycle.stop", () => {
  it("is a no-op when nothing is running", async () => {
    const sub = makeFakeSubprocess();
    const lifecycle = createProxyLifecycle(baseDeps({ subprocess: sub.subprocess }));
    await expect(lifecycle.stop()).resolves.toBeUndefined();
    expect(sub.calls).toHaveLength(0);
  });

  it("SIGTERM honored: child exits cleanly before the grace period elapses", async () => {
    const sub = makeFakeSubprocess();
    const fake = makeFakeChild(101, {
      onKill: (signal) => {
        if (signal === "SIGTERM") {
          // Honor the signal: child exits immediately.
          fake.release(0);
        }
      }
    });
    sub.queue(() => fake);
    const lifecycle = createProxyLifecycle(
      baseDeps({ subprocess: sub.subprocess, stopGracePeriodMs: 100 })
    );
    await lifecycle.start();
    await lifecycle.stop();
    expect(fake.kills).toEqual(["SIGTERM"]);
    expect(lifecycle.trackedPid()).toBeNull();
  });

  it("falls back to SIGKILL when SIGTERM doesn't exit within the grace period", async () => {
    const sub = makeFakeSubprocess();
    let receivedKill = false;
    const fake = makeFakeChild(202, {
      onKill: (signal) => {
        if (signal === "SIGKILL") {
          receivedKill = true;
          fake.release(null);
        }
        // SIGTERM is ignored — simulates a stuck child.
      }
    });
    sub.queue(() => fake);
    const lifecycle = createProxyLifecycle(
      baseDeps({ subprocess: sub.subprocess, stopGracePeriodMs: 0 })
    );
    await lifecycle.start();
    await lifecycle.stop();
    expect(fake.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(receivedKill).toBe(true);
    expect(lifecycle.trackedPid()).toBeNull();
  });

  it("is idempotent: two concurrent stop() calls await the same teardown", async () => {
    const sub = makeFakeSubprocess();
    const fake = makeFakeChild(303, {
      onKill: () => {
        fake.release(0);
      }
    });
    sub.queue(() => fake);
    const lifecycle = createProxyLifecycle(
      baseDeps({ subprocess: sub.subprocess, stopGracePeriodMs: 10 })
    );
    await lifecycle.start();
    const a = lifecycle.stop();
    const b = lifecycle.stop();
    await Promise.all([a, b]);
    // Only one SIGTERM should have been sent — the second stop() reused
    // the inflight promise.
    expect(fake.kills).toEqual(["SIGTERM"]);
  });
});

describe("createProxyLifecycle.isRunning", () => {
  it("returns true on a 200 from the probe URL", async () => {
    const sub = makeFakeSubprocess();
    const urls: string[] = [];
    const fetcher: ProxyFetch = (url) => {
      urls.push(url);
      return Promise.resolve({ ok: true, status: 200 });
    };
    const lifecycle = createProxyLifecycle(
      baseDeps({ subprocess: sub.subprocess, fetch: fetcher, probeTimeoutMs: 0 })
    );
    await expect(lifecycle.isRunning()).resolves.toBe(true);
    expect(urls).toEqual(["http://127.0.0.1:11400/api/tags"]);
  });

  it("returns false when fetch rejects (e.g. ECONNREFUSED)", async () => {
    const sub = makeFakeSubprocess();
    const fetcher: ProxyFetch = vi.fn(() => Promise.reject(new Error("ECONNREFUSED")));
    const lifecycle = createProxyLifecycle(
      baseDeps({ subprocess: sub.subprocess, fetch: fetcher, probeTimeoutMs: 0 })
    );
    await expect(lifecycle.isRunning()).resolves.toBe(false);
  });

  it("falls back to trackedPid check when no fetch is supplied", async () => {
    const sub = makeFakeSubprocess();
    sub.queue(() => makeFakeChild(909));
    const lifecycle = createProxyLifecycle(baseDeps({ subprocess: sub.subprocess }));
    await expect(lifecycle.isRunning()).resolves.toBe(false);
    await lifecycle.start();
    await expect(lifecycle.isRunning()).resolves.toBe(true);
  });
});

describe("createProxyLifecycle.onExit", () => {
  it("fires registered listeners with the child's exit code", async () => {
    const sub = makeFakeSubprocess();
    const fake = makeFakeChild(111);
    sub.queue(() => fake);
    const lifecycle = createProxyLifecycle(baseDeps({ subprocess: sub.subprocess }));
    const listener = vi.fn();
    const unsubscribe = lifecycle.onExit(listener);
    await lifecycle.start();
    fake.release(42);
    await Promise.resolve();
    await Promise.resolve();
    // Bug-C: the listener now receives `(exitCode, info)`. The diagnostic
    // info bag carries the rolling stderr buffer + an "unexpected" flag
    // so the UI can decide whether to surface an error message. Backwards-
    // compatible: legacy single-arg listeners simply ignore arg 2.
    expect(listener).toHaveBeenCalledWith(42, expect.objectContaining({ unexpected: true }));
    unsubscribe();
  });

  it("does not fire after the listener is unsubscribed", async () => {
    const sub = makeFakeSubprocess();
    const fake = makeFakeChild(222);
    sub.queue(() => fake);
    const lifecycle = createProxyLifecycle(baseDeps({ subprocess: sub.subprocess }));
    const listener = vi.fn();
    const unsubscribe = lifecycle.onExit(listener);
    unsubscribe();
    await lifecycle.start();
    fake.release(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(listener).not.toHaveBeenCalled();
  });
});

/**
 * H1 (Phase 4b codex review) — start/stop race coverage.
 *
 * The pre-fix implementation guarded duplicate starts and stops as two
 * independent in-flight promises but never coordinated between them.
 * A stop() during an in-flight start() observed `child === null` and
 * returned without killing the soon-to-be-spawned child; a start()
 * during a stop() returned the pid of a process about to be SIGKILL'd.
 *
 * After the fix, all transitions flow through a state machine
 * (idle → starting → running → stopping → idle) so concurrent
 * start/stop calls serialize correctly.
 */
describe("createProxyLifecycle race serialization (H1)", () => {
  it("concurrent start() + start() returns the same pid and only spawns once", async () => {
    const sub = makeFakeSubprocess();
    const deferred = sub.queueDeferred();
    const lifecycle = createProxyLifecycle(baseDeps({ subprocess: sub.subprocess }));

    const first = lifecycle.start();
    const second = lifecycle.start();
    // Both calls are in-flight; let them merge before the spawn resolves.
    deferred.resolve(makeFakeChild(5151));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual({ pid: 5151 });
    expect(b).toEqual({ pid: 5151 });
    expect(sub.calls).toHaveLength(1);
  });

  it("concurrent stop() + stop() is idempotent no-op when nothing is running", async () => {
    const sub = makeFakeSubprocess();
    const lifecycle = createProxyLifecycle(baseDeps({ subprocess: sub.subprocess }));
    const a = lifecycle.stop();
    const b = lifecycle.stop();
    await Promise.all([a, b]);
    expect(sub.calls).toHaveLength(0);
  });

  it("stop() called during an in-flight start() waits for spawn AND THEN kills the just-spawned child", async () => {
    const sub = makeFakeSubprocess();
    const deferred = sub.queueDeferred();
    const fake = makeFakeChild(6000, {
      onKill: (signal) => {
        if (signal === "SIGTERM") {
          fake.release(0);
        }
      }
    });
    const lifecycle = createProxyLifecycle(
      baseDeps({ subprocess: sub.subprocess, stopGracePeriodMs: 10 })
    );

    // Begin start (handle resolution is pending).
    const startPromise = lifecycle.start();
    // Stop in the same tick — the pre-fix code saw `child === null` and
    // returned without killing.
    const stopPromise = lifecycle.stop();

    // Let the spawn resolve.
    deferred.resolve(fake);

    const [startResult] = await Promise.all([startPromise, stopPromise]);
    expect(startResult).toEqual({ pid: 6000 });
    // Critical: the child WAS killed. Pre-fix this list was empty.
    expect(fake.kills).toEqual(["SIGTERM"]);
    expect(lifecycle.trackedPid()).toBeNull();
  });

  it("start() called during an in-flight stop() waits for stop to complete before spawning a fresh child", async () => {
    const sub = makeFakeSubprocess();
    const first = makeFakeChild(7100, {
      onKill: (signal) => {
        if (signal === "SIGTERM") {
          // Honor the signal: child exits cleanly.
          first.release(0);
        }
      }
    });
    const second = makeFakeChild(7200);
    sub.queue(() => first);
    sub.queue(() => second);
    const lifecycle = createProxyLifecycle(
      baseDeps({ subprocess: sub.subprocess, stopGracePeriodMs: 10 })
    );

    await lifecycle.start();
    expect(lifecycle.trackedPid()).toBe(7100);

    // Begin stop and start in the same tick.
    const stopPromise = lifecycle.stop();
    const restartPromise = lifecycle.start();

    const [, restart] = await Promise.all([stopPromise, restartPromise]);
    // Restart must be a NEW process, not the killed one.
    expect(restart).toEqual({ pid: 7200 });
    expect(first.kills).toEqual(["SIGTERM"]);
    expect(sub.calls).toHaveLength(2);
    expect(lifecycle.trackedPid()).toBe(7200);
  });

  /**
   * H1 iter 3 — Start → Stop → Start-before-spawn-resolves race.
   *
   * The iter 2 fix wired the FSM so driveStop awaits an in-flight start
   * before killing the spawned child. But the public start() method
   * returned the cached inflightStart promise unconditionally, so a
   * Start → Stop → Start sequence where the third call lands before the
   * first start's spawn resolves received the pid of the doomed child
   * the pending stop was about to kill.
   *
   * The fix: when start() is called while a stop is in flight, the
   * second-and-later start() awaits the stop first, then drives a
   * fresh spawn rather than returning the doomed promise.
   */
  it("H1 iter 3: Start→Stop→Start before spawn resolves yields a fresh pid, not the doomed one", async () => {
    const sub = makeFakeSubprocess();
    const doomedDeferred = sub.queueDeferred();
    const doomed = makeFakeChild(9100, {
      onKill: (signal) => {
        if (signal === "SIGTERM") {
          doomed.release(0);
        }
      }
    });
    const fresh = makeFakeChild(9200);
    sub.queue(() => fresh);

    const lifecycle = createProxyLifecycle(
      baseDeps({ subprocess: sub.subprocess, stopGracePeriodMs: 10 })
    );

    // Step 1: first start — spawn pending (handle not resolved yet).
    const firstStart = lifecycle.start();
    // Step 2: stop in the same tick — must wait for spawn then kill.
    const stopPromise = lifecycle.stop();
    // Step 3: a third start BEFORE the first spawn resolves. Pre-fix,
    // this returned the same inflightStart promise as `firstStart` and
    // therefore resolved to pid 9100 — the doomed child.
    const thirdStart = lifecycle.start();

    // Now resolve the first spawn; the FSM stop awaits it then SIGTERMs
    // the spawned child. The third start was already queued to await
    // the stop.
    doomedDeferred.resolve(doomed);

    const [first, , third] = await Promise.all([firstStart, stopPromise, thirdStart]);

    // The doomed start still returns its pid — its job was to spawn,
    // and it did. But the third start MUST be a fresh pid.
    expect(first).toEqual({ pid: 9100 });
    expect(third).toEqual({ pid: 9200 });
    // Two distinct spawns: the doomed one and the fresh one.
    expect(sub.calls).toHaveLength(2);
    // The doomed child received SIGTERM.
    expect(doomed.kills).toEqual(["SIGTERM"]);
    // The fresh child is the one currently tracked.
    expect(lifecycle.trackedPid()).toBe(9200);
  });

  it("start() during start() during stop() serializes through the FSM (interleaved transitions)", async () => {
    const sub = makeFakeSubprocess();
    const first = makeFakeChild(8100, {
      onKill: (signal) => {
        if (signal === "SIGTERM") {
          first.release(0);
        }
      }
    });
    const second = makeFakeChild(8200);
    sub.queue(() => first);
    sub.queue(() => second);
    const lifecycle = createProxyLifecycle(
      baseDeps({ subprocess: sub.subprocess, stopGracePeriodMs: 10 })
    );

    await lifecycle.start();
    const stopPromise = lifecycle.stop();
    // Two concurrent starts during the stop must collapse into a single
    // spawn after the stop completes.
    const restart1 = lifecycle.start();
    const restart2 = lifecycle.start();

    const [, a, b] = await Promise.all([stopPromise, restart1, restart2]);
    expect(a).toEqual(b);
    expect(a).toEqual({ pid: 8200 });
    expect(sub.calls).toHaveLength(2);
  });
});

/**
 * Bug C — proxy spawn / early-crash diagnostics.
 *
 * Premises:
 *   P1. The lifecycle MUST drain the child's stderr stream into a
 *       rolling buffer (last ~500 chars).
 *   P2. When the child exits with a non-zero code, onExit listeners
 *       MUST receive the buffer and an `unexpected: true` flag.
 *   P3. When the child exits within `earlyExitWindowMs` of spawn
 *       (default 2000ms) — even with exit code 0 — onExit listeners
 *       MUST receive `unexpected: true` (this is the EADDRINUSE-style
 *       failure mode that previously surfaced silently).
 *   P4. When the user initiates the shutdown via stop(), the resulting
 *       exit MUST be classified as `unexpected: false` even if the
 *       child exit happens to land inside the early-exit window.
 *   P5. A long-running healthy child whose exit happens AFTER the
 *       window MUST NOT trigger a false-positive "unexpected" signal.
 *   P6. The buffer MUST be capped to STDERR_BUFFER_LIMIT chars so
 *       megabyte-long log spam doesn't balloon the controller's heap.
 *   P7. `extraEnvironment` deps MUST be merged into the spawn env
 *       alongside `LLM_PROXY_PORT` so the consent-gated config-read
 *       flow can pass `LLM_PROXY_CONFIG_READ=allow`.
 */
describe("createProxyLifecycle exit diagnostics (Bug C)", () => {
  it("captures stderr into the rolling buffer and surfaces it on non-zero exit", async () => {
    const sub = makeFakeSubprocess();
    const fake = makeFakeChild(11000, {
      stderrChunks: ["Error: listen EADDRINUSE: address already in use 127.0.0.1:11400\n"]
    });
    sub.queue(() => fake);
    const lifecycle = createProxyLifecycle(baseDeps({ subprocess: sub.subprocess }));
    const listener = vi.fn();
    lifecycle.onExit(listener);
    await lifecycle.start();
    // Let drainStderr swallow the queued chunks before the child exits.
    await Promise.resolve();
    await Promise.resolve();
    fake.release(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    const args = listener.mock.calls[0] as [number | null, { stderr: string; unexpected: boolean }];
    expect(args[0]).toBe(1);
    expect(args[1]).toMatchObject({ unexpected: true });
    expect(args[1].stderr).toContain("EADDRINUSE");
  });

  it("flags exits within the early-exit window as unexpected even when exit code is zero", async () => {
    let nowVal = 1_000_000;
    const sub = makeFakeSubprocess();
    const fake = makeFakeChild(12000, {
      stderrChunks: ["SyntaxError: Unexpected token at server.mjs:1\n"]
    });
    sub.queue(() => fake);
    const lifecycle = createProxyLifecycle(
      baseDeps({
        subprocess: sub.subprocess,
        earlyExitWindowMs: 2000,
        now: () => nowVal
      })
    );
    const listener = vi.fn();
    lifecycle.onExit(listener);
    await lifecycle.start();
    await Promise.resolve();
    // Advance time by 100ms — well inside the early-exit window.
    nowVal += 100;
    fake.release(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    const info = listener.mock.calls[0]?.[1] as { unexpected: boolean; stderr: string };
    expect(info.unexpected).toBe(true);
    expect(info.stderr).toContain("SyntaxError");
  });

  it("classifies user-initiated stops as expected even when they land in the early-exit window", async () => {
    let nowVal = 2_000_000;
    const sub = makeFakeSubprocess();
    const fake = makeFakeChild(13000, {
      onKill: (signal) => {
        if (signal === "SIGTERM") {
          fake.release(0);
        }
      }
    });
    sub.queue(() => fake);
    const lifecycle = createProxyLifecycle(
      baseDeps({
        subprocess: sub.subprocess,
        earlyExitWindowMs: 5000, // huge so stop() lands inside it
        now: () => nowVal
      })
    );
    const listener = vi.fn();
    lifecycle.onExit(listener);
    await lifecycle.start();
    nowVal += 50;
    await lifecycle.stop();
    await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    const info = listener.mock.calls[0]?.[1] as { unexpected: boolean };
    expect(info.unexpected).toBe(false);
  });

  it("does NOT flag a healthy long-running child whose exit happens after the window", async () => {
    let nowVal = 3_000_000;
    const sub = makeFakeSubprocess();
    const fake = makeFakeChild(14000);
    sub.queue(() => fake);
    const lifecycle = createProxyLifecycle(
      baseDeps({
        subprocess: sub.subprocess,
        earlyExitWindowMs: 2000,
        now: () => nowVal
      })
    );
    const listener = vi.fn();
    lifecycle.onExit(listener);
    await lifecycle.start();
    // Advance well past the early-exit window. Child exits 0 from a
    // normal lifecycle shutdown (e.g., a graceful node process.exit()).
    nowVal += 60_000;
    fake.release(0);
    await Promise.resolve();
    await Promise.resolve();
    const info = listener.mock.calls[0]?.[1] as { unexpected: boolean };
    expect(info.unexpected).toBe(false);
  });

  it("caps the stderr buffer so multi-MB log spam doesn't blow up the controller", async () => {
    const sub = makeFakeSubprocess();
    // Queue a huge string + a final identifiable tail so we can assert
    // the buffer kept the tail (the most-recent diagnostic).
    const huge = "x".repeat(2000);
    const tail = "*** FINAL_DIAGNOSTIC ***";
    const fake = makeFakeChild(15000, {
      stderrChunks: [huge, tail]
    });
    sub.queue(() => fake);
    const lifecycle = createProxyLifecycle(baseDeps({ subprocess: sub.subprocess }));
    const listener = vi.fn();
    lifecycle.onExit(listener);
    await lifecycle.start();
    // Let both stderr chunks drain.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    fake.release(2);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const info = listener.mock.calls[0]?.[1] as { stderr: string };
    expect(info.stderr.length).toBeLessThanOrEqual(500);
    expect(info.stderr).toContain(tail);
  });

  it("merges extraEnvironment into the spawn env alongside LLM_PROXY_PORT", async () => {
    const sub = makeFakeSubprocess();
    sub.queue(() => makeFakeChild(16000));
    const lifecycle = createProxyLifecycle(
      baseDeps({
        subprocess: sub.subprocess,
        extraEnvironment: { LLM_PROXY_CONFIG_READ: "allow", FOO: "bar" }
      })
    );
    await lifecycle.start();
    expect(sub.calls).toHaveLength(1);
    expect(sub.calls[0]?.env).toMatchObject({
      LLM_PROXY_PORT: "11400",
      LLM_PROXY_CONFIG_READ: "allow",
      FOO: "bar"
    });
  });
});
