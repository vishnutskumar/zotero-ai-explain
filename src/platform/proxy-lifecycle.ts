/**
 * proxy-lifecycle — chrome-side spawn/track of the llm-proxy server.
 *
 * Zotero plugins run with full Firefox chrome privileges. The chrome
 * `Subprocess` ESM module (`resource://gre/modules/Subprocess.sys.mjs`)
 * exposes a Mozilla-blessed `call()` to spawn a child process from the
 * parent chrome scope. This file wraps that API behind a narrow
 * `SubprocessLike` interface so unit tests can inject a fake without
 * standing up a real chrome environment.
 *
 * What the controller owns:
 *
 *   - one in-flight child process (the llm-proxy node script)
 *   - the child's pid (so `isRunning()` short-circuits without a probe
 *     when the controller knows it never started)
 *   - the `wait()` promise so `stop()` can await SIGTERM honoring
 *   - an `onExit` listener set so the UI can react to crashes
 *
 * What it does NOT own:
 *
 *   - path resolution for the Node binary or server script (the host
 *     resolves both via the settings dialog or `wire-proxy-lifecycle`
 *     defaults and hands them in via `deps`)
 *   - any DOM / settings-view state (the UI binding lives in
 *     `wire-proxy-lifecycle` / `settings-view`)
 *
 * Idempotency and re-entrancy:
 *
 *   - `start()` while already running returns the existing pid; it
 *     never double-spawns. Same goes for back-to-back start() calls
 *     before the first child has settled — the second call awaits the
 *     first.
 *   - `stop()` is a no-op when the controller is not tracking a child.
 *     If the child has already exited but the post-exit cleanup hasn't
 *     run yet, the stop() awaits cleanup and resolves cleanly.
 *   - `stop()` issues SIGTERM, waits up to `stopGracePeriodMs` (default
 *     3000) for the child to exit, then SIGKILL.
 *
 * `isRunning()` does a 500ms `GET ${baseUrl}/api/tags` probe. Truthy
 * for any 2xx response. This means "running" really means "responding
 * to traffic" rather than "child process alive" — the right answer for
 * a UI that wants to know whether the user can route requests through
 * the proxy.
 */

import type { Unsubscribe } from "./zotero-ui-types.js";

/**
 * Handle returned by `subprocess.call({...})`. Mirrors the relevant
 * subset of the chrome `Subprocess` process handle. Tests provide a
 * fake that records `kill()` and resolves `wait()` on demand.
 *
 * `pid` is the OS process id (number). `wait()` resolves with the exit
 * status object after the child terminates. `kill(signal?)` sends the
 * given signal; chrome's API accepts the signal as a string ("SIGTERM"
 * / "SIGKILL" / "SIGINT" / "SIGHUP") on platforms that expose it.
 *
 * `stderr` is an optional async readable that yields text chunks from
 * the child's stderr. Mirrors the streaming reader chrome's `Subprocess`
 * exposes (which has its own `read()`/`readString()` API). The
 * controller adapts whatever shape the host gives it — concretely:
 *
 *   - object with `readString(): Promise<string | null>` (chrome shape;
 *     null marks EOF), OR
 *   - async iterable of strings or Uint8Array, OR
 *   - undefined / null when the host does not expose stderr.
 *
 * Tests inject a fake that drains a fixed array of chunks.
 */
export type StderrReader =
  | {
      readString(): Promise<string | null>;
    }
  | AsyncIterable<string | Uint8Array>
  | null
  | undefined;

export type SubprocessHandle = {
  readonly pid: number;
  /** Resolves once the child has exited; the value is opaque to us. */
  wait(): Promise<{ readonly exitCode: number | null }>;
  /** Send a signal. Returns void; errors thrown are surfaced to the caller. */
  kill(signal?: string): void;
  /** Optional stderr stream; the controller drains it into a rolling buffer. */
  readonly stderr?: StderrReader;
};

/**
 * Narrow contract over chrome's `Subprocess.call(...)`.
 *
 * Note: the chrome API uses `arguments` as the key; we mirror that
 * exactly so the production adapter is a one-line passthrough.
 */
export type SubprocessLike = {
  call(spec: {
    readonly command: string;
    readonly arguments: readonly string[];
    readonly environment?: Readonly<Record<string, string>>;
    readonly environmentAppend?: boolean;
    readonly stderr?: "pipe" | "ignore" | "stdout";
  }): Promise<SubprocessHandle>;
};

/** Lightweight fetch contract so the `isRunning()` probe can be stubbed. */
export type ProxyFetch = (
  input: string,
  init?: { readonly signal?: AbortSignal }
) => Promise<{ readonly ok: boolean; readonly status: number }>;

export type ProxyLifecycleDeps = {
  readonly subprocess: SubprocessLike;
  readonly nodeBinaryPath: string;
  readonly serverScriptPath: string;
  readonly port: number;
  readonly fetch?: ProxyFetch;
  readonly debug?: (msg: string) => void;
  /** Grace period before SIGKILL. Default 3000ms; tests inject 0. */
  readonly stopGracePeriodMs?: number;
  /**
   * Override for the 500ms isRunning probe timeout. Tests pass 0 so
   * the AbortController doesn't dangle when fetch throws synchronously.
   */
  readonly probeTimeoutMs?: number;
  /**
   * Extra environment variables merged on top of `LLM_PROXY_PORT`. Used
   * by the consent-gated config-discovery flow to inject
   * `LLM_PROXY_CONFIG_READ=allow` only after the user has approved.
   */
  readonly extraEnvironment?: Readonly<Record<string, string>>;
  /**
   * If the child exits within this many ms of spawn, the lifecycle
   * treats the exit as "early failure" and surfaces the rolling stderr
   * buffer to onExit listeners (see `onExit` callback signature) even
   * when the exit code is zero. Default 2000ms.
   */
  readonly earlyExitWindowMs?: number;
  /**
   * Injectable monotonic clock so tests can deterministically trigger
   * the early-exit path without sleeping.
   */
  readonly now?: () => number;
};

export type ProxyStartResult =
  | { readonly pid: number }
  | { readonly external: true }
  | { readonly error: string };

export type ProxyLifecycle = {
  /**
   * Spawn the proxy. Three outcomes:
   *   - `{ pid }` — we spawned the child and own it. stop() will kill it.
   *   - `{ external: true }` — a foreign process is already serving
   *     /api/tags on the configured port, so we skip the spawn and let
   *     the user's existing proxy serve traffic. stop() is a no-op in
   *     this case (we don't own that process).
   *   - `{ error }` — spawn failed; controller stays "not running".
   *
   * If a child is already tracked (running or starting), the existing
   * pid is returned without spawning a second process.
   */
  start(): Promise<ProxyStartResult>;
  /**
   * SIGTERM the child, wait up to `stopGracePeriodMs` for clean exit,
   * SIGKILL otherwise. No-op when nothing is tracked. When the previous
   * start() returned `{ external: true }`, stop() clears the
   * externally-managed flag but does not signal the foreign process.
   */
  stop(): Promise<void>;
  /** True iff the proxy responds to a 500ms GET /api/tags probe. */
  isRunning(): Promise<boolean>;
  /** Synchronous accessor: is the controller currently tracking a pid? */
  trackedPid(): number | null;
  /**
   * Synchronous accessor: was the last successful start() actually a
   * probe-hit against a foreign process on the port? UI surfaces this
   * so the user knows the proxy is running but not under plugin control
   * (and the Stop button cannot affect it).
   */
  isExternallyManaged(): boolean;
  /**
   * Register a callback fired when the tracked child exits — whether
   * driven by stop() or an unexpected crash. The argument is the exit
   * code (null when unknown / signal-terminated).
   *
   * The optional second argument carries diagnostic info captured by
   * the controller: the rolling stderr buffer (last ~500 chars) and a
   * `unexpected` flag that is true iff the child died on its own
   * (non-zero exit code, or any exit within `earlyExitWindowMs` of
   * spawn — e.g. EADDRINUSE crash before the server bound the port).
   * Existing listeners that take only the first argument continue to
   * work because TypeScript treats extra parameters as ignored.
   */
  onExit(callback: (exitCode: number | null, info?: ProxyExitInfo) => void): Unsubscribe;
};

/**
 * Diagnostic info passed to `onExit` listeners alongside the raw exit
 * code. `stderr` is the trailing ~500 chars of the child's stderr
 * (empty string when no stream was attached or no data arrived);
 * `unexpected` is true iff the controller did NOT initiate the exit
 * (so a crash, EADDRINUSE, syntax error, missing-node).
 */
export type ProxyExitInfo = {
  readonly stderr: string;
  readonly unexpected: boolean;
};

const DEFAULT_GRACE_PERIOD_MS = 3000;
const DEFAULT_PROBE_TIMEOUT_MS = 500;
const DEFAULT_EARLY_EXIT_WINDOW_MS = 2000;
const STDERR_BUFFER_LIMIT = 500;
/**
 * Maximum time the exit handler will wait for the stderr drainer to
 * flush before snapshotting the buffer. Without this race-grace, a
 * fast-crashing child's wait() resolves before drainStderr has consumed
 * any chunks, leaving the UI's "Proxy exited (N)" message with no tail.
 * 500ms covers the typical chrome Subprocess stream-flush window after
 * the child terminates; if the drainer already saw EOF synchronously
 * (the common healthy-exit case) the race resolves immediately.
 */
const STDERR_GRACE_MS = 500;

export function createProxyLifecycle(deps: ProxyLifecycleDeps): ProxyLifecycle {
  const debug = deps.debug ?? ((): void => undefined);
  const fetcher: ProxyFetch | undefined = deps.fetch;
  const grace = deps.stopGracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  const probeTimeout = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const earlyExitWindowMs = deps.earlyExitWindowMs ?? DEFAULT_EARLY_EXIT_WINDOW_MS;
  const now = deps.now ?? ((): number => Date.now());

  let child: SubprocessHandle | null = null;
  // True when the last successful start() detected a foreign process on
  // the port instead of spawning a child. Cleared by stop(). When set,
  // trackedPid() stays null because we don't own a child handle.
  let externallyManaged = false;
  // The wait() promise belongs to the in-flight child so stop() can
  // await it. We re-wrap so observers don't race the .then() chain.
  let childExit: Promise<{ readonly exitCode: number | null }> | null = null;
  // Spawn time of the currently-tracked child. Used to classify exits
  // inside `earlyExitWindowMs` as "unexpected" even if the exit code
  // is technically zero (a crash that swallowed its own exit status,
  // for example a process that was SIGKILL'd by the OS).
  let childSpawnedAtMs = 0;
  // Rolling stderr buffer for the currently-tracked child. Capped at
  // STDERR_BUFFER_LIMIT chars (sliced from the tail so the most recent
  // diagnostic — usually the actual error — survives).
  let stderrBuffer = "";
  // Completion promise for the stderr drainer of the currently-tracked
  // child. The exit handler races this against STDERR_GRACE_MS so a
  // fast-crashing child doesn't lose its stderr tail to the exit-vs-
  // drain ordering race. Null when no drainer is running (no child, or
  // the child exposed no stderr stream).
  let stderrDrainerDone: Promise<void> | null = null;
  // True iff the controller initiated the shutdown (stop() called).
  // Set inside doTerminate, consulted in the exit handler to decide
  // whether to flag the exit as "unexpected" for listeners.
  let stoppingByUser = false;
  // Re-entrant start guard: if start() is called twice before the first
  // spawn resolves, the second call awaits this promise.
  let inflightStart: Promise<ProxyStartResult> | null = null;
  // Re-entrant stop guard: if stop() is called twice, the second call
  // awaits the first.
  let inflightStop: Promise<void> | null = null;
  const exitListeners = new Set<(code: number | null, info?: ProxyExitInfo) => void>();

  // Finite-state machine: idle → starting → running → stopping → idle.
  //
  // Why a state machine? Independent start/stop guards (inflightStart /
  // inflightStop) leaked races: stop() during an inflight start() saw
  // `child === null` and returned without killing the soon-to-be-spawned
  // child; start() during a stop() returned the pid of a process the
  // stop() was about to SIGKILL. The state field gives every transition
  // a single source of truth so the public methods can serialize:
  //
  //   - start() during starting → await inflightStart, return its pid.
  //   - start() during running  → return existing pid (no spawn).
  //   - start() during stopping → await stop completion, then start fresh.
  //   - stop() during starting  → await start completion, then kill what
  //     was just spawned (this is the H1 fix — otherwise we'd return
  //     before killing).
  //   - stop() during running   → kill the tracked child.
  //   - stop() during stopping  → return inflightStop (idempotent).
  type State = "idle" | "starting" | "running" | "stopping";
  let state: State = "idle";

  function emitExit(code: number | null, info: ProxyExitInfo): void {
    for (const listener of exitListeners) {
      try {
        listener(code, info);
      } catch (err) {
        debug(
          `proxy-lifecycle exit listener threw: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  function appendStderr(chunk: string): void {
    if (chunk.length === 0) return;
    stderrBuffer = (stderrBuffer + chunk).slice(-STDERR_BUFFER_LIMIT);
  }

  /**
   * Drain the child's stderr stream into the rolling buffer. Supports
   * both the chrome `Subprocess` shape (`readString()` returning
   * Promise<string|null> with null marking EOF) and the test-friendly
   * async-iterable shape (`for await (const chunk of stream) ...`).
   *
   * Errors are swallowed: a broken stderr stream must not prevent the
   * exit handler from firing. The buffer already accumulated up to the
   * failure point is still surfaced to listeners.
   *
   * Returns a promise that ALWAYS resolves (never rejects) when the
   * drainer reaches EOF or hits an error. The exit handler awaits this
   * (raced against STDERR_GRACE_MS) so a fast-crashing child's stderr
   * chunks make it into the snapshot before listeners fire.
   */
  function drainStderr(handle: SubprocessHandle): Promise<void> {
    const stream = handle.stderr;
    if (stream === undefined || stream === null) return Promise.resolve();
    return (async () => {
      try {
        if (typeof (stream as { readString?: unknown }).readString === "function") {
          const reader = stream as { readString(): Promise<string | null> };
          let next = await reader.readString();
          while (next !== null) {
            appendStderr(typeof next === "string" ? next : String(next));
            next = await reader.readString();
          }
          return;
        }
        if (
          typeof (stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
          "function"
        ) {
          for await (const chunk of stream as AsyncIterable<string | Uint8Array>) {
            if (typeof chunk === "string") appendStderr(chunk);
            else if (chunk instanceof Uint8Array) {
              try {
                appendStderr(new TextDecoder().decode(chunk));
              } catch {
                // ignore decode failures — the buffer best-effort.
              }
            }
          }
        }
      } catch (err) {
        debug(
          `proxy-lifecycle stderr drain failed: ${err instanceof Error ? err.message : String(err)}`
        );
        // Swallow the error so the returned promise resolves cleanly —
        // the exit handler awaits this and must never see a rejection.
      }
    })();
  }

  /**
   * Build the `ProxyExitInfo` snapshot for the currently-tracked child.
   * Captured AT exit time so a listener that triggers another start()
   * doesn't observe a buffer mutated by the new child's stderr.
   */
  function snapshotExitInfo(exitCode: number | null): ProxyExitInfo {
    const elapsed = now() - childSpawnedAtMs;
    const earlyExit = elapsed < earlyExitWindowMs;
    const nonZeroExit = exitCode !== null && exitCode !== 0;
    // "unexpected" means: the user didn't ask for it, AND either the
    // exit code is non-zero or the child died within the early-exit
    // window. The early-exit gate is what catches EADDRINUSE crashes
    // where the child happens to return 0 before binding the port.
    const unexpected = !stoppingByUser && (nonZeroExit || earlyExit);
    return { stderr: stderrBuffer, unexpected };
  }

  /**
   * Hook the child's wait() so we observe unsolicited exits and clear
   * the tracked handle so the next start() spawns afresh.
   */
  function wireExit(handle: SubprocessHandle): Promise<{ readonly exitCode: number | null }> {
    // Race the drainer's completion against STDERR_GRACE_MS so the
    // exit info snapshot includes stderr that arrived just before the
    // exit AND so a hung drainer cannot block exit notification forever.
    // The drainer promise (set in doSpawn) is captured by reference at
    // await time; if it's already resolved (EOF arrived synchronously)
    // the race short-circuits immediately.
    const awaitDrainerOrGrace = async (): Promise<void> => {
      const drainer = stderrDrainerDone ?? Promise.resolve();
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const graceElapsed = new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, STDERR_GRACE_MS);
      });
      try {
        await Promise.race([drainer, graceElapsed]);
      } finally {
        if (graceTimer !== undefined) clearTimeout(graceTimer);
      }
    };
    const promise = handle
      .wait()
      .then(async (result) => {
        await awaitDrainerOrGrace();
        const info = snapshotExitInfo(result.exitCode);
        if (child === handle) {
          child = null;
          childExit = null;
          // Only flip state to idle when nothing else is in flight; an
          // active stop() owns the transition and will reset state when
          // doTerminate() returns. Same for a starting state (the child
          // we just spawned exited before doSpawn promoted state).
          if (state === "running") {
            state = "idle";
          }
        }
        emitExit(result.exitCode, info);
        return result;
      })
      .catch(async (err: unknown) => {
        await awaitDrainerOrGrace();
        // Treat a thrown wait() as exit with unknown code so listeners fire.
        const info = snapshotExitInfo(null);
        if (child === handle) {
          child = null;
          childExit = null;
          if (state === "running") {
            state = "idle";
          }
        }
        debug(
          `proxy-lifecycle wait() rejected: ${err instanceof Error ? err.message : String(err)}`
        );
        emitExit(null, info);
        return { exitCode: null };
      });
    return promise;
  }

  async function doSpawn(): Promise<ProxyStartResult> {
    try {
      // Reset diagnostic state for the new child so a previous crash's
      // stderr doesn't leak into this run's exit info.
      stderrBuffer = "";
      stderrDrainerDone = null;
      stoppingByUser = false;
      // We're claiming ownership with a fresh spawn — drop any stale
      // external-management flag from a prior probe-skip.
      externallyManaged = false;
      // Mozilla's `Subprocess.sys.mjs` (the production spawn adapter)
      // unconditionally pipes the child's stdin so callers can drive it
      // via `proc.stdin.write()` / `.close()`. We rely on that here:
      // the server's `installParentDeathDetector` listens for stdin EOF
      // and self-terminates on parent death — without a piped stdin
      // there's nothing for the kernel to close when Zotero crashes /
      // is force-quit, and the proxy would survive as an orphan
      // reparented to launchd/init. See
      // `scripts/llm-proxy/server.mjs` for the EOF-handler rationale.
      const handle = await deps.subprocess.call({
        command: deps.nodeBinaryPath,
        arguments: [deps.serverScriptPath],
        environment: {
          LLM_PROXY_PORT: String(deps.port),
          ...(deps.extraEnvironment ?? {})
        },
        environmentAppend: true,
        stderr: "pipe"
      });
      child = handle;
      childSpawnedAtMs = now();
      // Capture the drainer promise BEFORE wiring exit so wireExit's
      // awaitDrainerOrGrace sees a non-null reference. (drainStderr is
      // synchronous up to its first await, so the assignment happens
      // before wait() can possibly resolve.)
      stderrDrainerDone = drainStderr(handle);
      childExit = wireExit(handle);
      state = "running";
      debug(`proxy-lifecycle spawned pid=${String(handle.pid)} port=${String(deps.port)}`);
      return { pid: handle.pid };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      debug(`proxy-lifecycle spawn failed: ${message}`);
      state = "idle";
      return { error: message };
    }
  }

  /**
   * Terminate the currently-tracked child. Caller must have set
   * `state = "stopping"` before invoking. On return, the handle has
   * exited (or has been SIGKILL'd) and state is reset to `idle`.
   */
  async function doTerminate(
    handle: SubprocessHandle,
    exitPromise: Promise<unknown>
  ): Promise<void> {
    // Mark the exit as user-initiated BEFORE sending the signal so the
    // wait()-handler classifies it correctly even on instant exits.
    stoppingByUser = true;
    try {
      handle.kill("SIGTERM");
    } catch (err) {
      debug(`proxy-lifecycle SIGTERM threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Wait up to `grace` ms for clean exit, else SIGKILL.
    const raced = await raceWithTimeout(exitPromise, grace);
    if (raced === "timeout") {
      try {
        handle.kill("SIGKILL");
      } catch (err) {
        debug(`proxy-lifecycle SIGKILL threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Wait without a deadline for the SIGKILL exit to land. If the
      // exit handler ran while we were racing, exitPromise is already
      // resolved and this is immediate.
      try {
        await exitPromise;
      } catch {
        // wait() failures are already logged inside wireExit's catch.
      }
    }
    // The wireExit() handler clears `child` / `childExit`. Belt-and-
    // suspenders: clear again here so a buggy adapter that never fires
    // wait() doesn't leave us thinking we're still tracking.
    if (child === handle) {
      child = null;
      childExit = null;
    }
    state = "idle";
  }

  /**
   * Probe the configured port before spawning. Returns true iff a
   * foreign process is already serving /api/tags so the caller should
   * skip the spawn. Any non-2xx response, network error, or absent
   * fetcher returns false so the spawn proceeds as before.
   */
  async function probeExisting(): Promise<boolean> {
    if (fetcher === undefined) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, probeTimeout);
    try {
      const response = await fetcher(`http://127.0.0.1:${String(deps.port)}/api/tags`, {
        signal: controller.signal
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Single state-machine driver for start(). Honors the in-flight stop
   * by awaiting it before deciding what to do. Re-checks state after
   * every await because the world can have changed (e.g. an unsolicited
   * exit reset state to "idle" while we slept).
   */
  async function driveStart(): Promise<ProxyStartResult> {
    // Yield once so callers that fire start()+stop() in the same
    // synchronous tick reach driveStart()/driveStop() in event-loop
    // order; without this the test for "stop() during start()" can
    // observe the second call before the first has even set state.
    if (state === "stopping" && inflightStop !== null) {
      // start() while stopping: wait for the stop to finish, then we
      // spawn a fresh process. This is the documented behavior — the
      // user clicked Stop then Start before the first child fully
      // released its port, so we serialize.
      try {
        await inflightStop;
      } catch {
        // stop failures are already logged; proceed to spawn anyway so
        // the user's Start request isn't silently dropped.
      }
    }
    // After awaiting the stop we may have raced a new start() that
    // already won the transition.
    if (state === "starting" && inflightStart !== null) {
      return inflightStart;
    }
    if (state === "running" && child !== null) {
      return { pid: child.pid };
    }
    // Transition the FSM to "starting" BEFORE awaiting the probe so a
    // concurrent stop() (driveStop checks `state === "starting"`) serializes
    // against the in-flight start instead of no-op'ing because state is
    // still "idle". Race-test regression: the H1 serialization tests rely
    // on the synchronous state flip happening before the next sync tick
    // dispatches stop().
    state = "starting";
    // Probe-before-spawn: when someone else (a manual `npm run proxy:llm`,
    // a prior Zotero session whose child outlived the parent, a separate
    // tool sharing the port) is already serving /api/tags, spawning a
    // second copy would just EADDRINUSE-crash and the user would see a
    // confusing failure. Detect-and-skip is the documented fix in the
    // orphan-spawn-port-collision pattern.
    if (await probeExisting()) {
      externallyManaged = true;
      debug(
        `proxy-lifecycle: detected external proxy on port ${String(deps.port)}; skipping spawn`
      );
      // No child was spawned, so there's nothing for a future stop() to
      // signal — drop back to idle.
      state = "idle";
      return { external: true };
    }
    return doSpawn();
  }

  /**
   * Single state-machine driver for stop(). Awaits any in-flight start
   * so it can kill the just-spawned child instead of racing with it
   * (the H1 bug: the old code saw `child === null` mid-spawn and
   * returned without killing).
   */
  async function driveStop(): Promise<void> {
    if (state === "starting" && inflightStart !== null) {
      // Wait for the spawn to land so we kill the resulting child
      // rather than no-op'ing on the current `child === null` view.
      // If the spawn failed, state will be "idle" after the await and
      // the early-return below handles it cleanly.
      try {
        await inflightStart;
      } catch {
        // spawn rejections become error results; no child to kill.
      }
    }
    // External-management drop: we never owned a child handle, so we
    // can't (and shouldn't) send signals to the foreign process. Clear
    // the flag so subsequent start() probes again.
    if (externallyManaged) {
      externallyManaged = false;
    }
    if (child === null || childExit === null) {
      state = "idle";
      return;
    }
    state = "stopping";
    await doTerminate(child, childExit);
  }

  return {
    start(): Promise<ProxyStartResult> {
      // H1 (Phase 4b codex review iter 3) — Start → Stop → Start race.
      //
      // The earlier fix coordinated stop() vs an in-flight start() via the
      // FSM (driveStop awaits inflightStart before killing). But the
      // public start() returned the cached inflightStart promise
      // unconditionally, so a Start → Stop → Start sequence where the
      // third call lands BEFORE the spawn resolves received the pid of
      // the doomed child the in-flight stop was about to kill.
      //
      // The correct serialization: if a stop is in flight when start()
      // is called, await it first so the doomed start has been fully
      // killed before we hand back any pid. After the stop completes the
      // controller is back in `idle`, and we can drive a fresh spawn (or
      // join a concurrent start that won the post-stop race).
      if (inflightStop !== null) {
        const pendingStop = inflightStop;
        const promise = pendingStop
          .catch(() => undefined) // stop errors already logged; proceed.
          .then(() => {
            // After the stop resolves, the doomed inflightStart has
            // already settled (driveStop awaited it). Another start()
            // may have won the post-stop race; join it instead of
            // double-spawning.
            if (inflightStart !== null) return inflightStart;
            const driven = driveStart().finally(() => {
              inflightStart = null;
            });
            inflightStart = driven;
            return driven;
          });
        return promise;
      }
      if (inflightStart !== null) return inflightStart;
      const promise = driveStart().finally(() => {
        inflightStart = null;
      });
      inflightStart = promise;
      return promise;
    },
    stop(): Promise<void> {
      if (inflightStop !== null) return inflightStop;
      const promise = driveStop().finally(() => {
        inflightStop = null;
      });
      inflightStop = promise;
      return promise;
    },
    async isRunning(): Promise<boolean> {
      if (fetcher === undefined) {
        // No fetch supplied: fall back to "tracking a child" as a proxy.
        return child !== null;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, probeTimeout);
      try {
        const response = await fetcher(`http://127.0.0.1:${String(deps.port)}/api/tags`, {
          signal: controller.signal
        });
        return response.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
    trackedPid(): number | null {
      return child?.pid ?? null;
    },
    isExternallyManaged(): boolean {
      return externallyManaged;
    },
    onExit(callback): Unsubscribe {
      exitListeners.add(callback);
      return () => {
        exitListeners.delete(callback);
      };
    }
  };
}

/**
 * Race `promise` against a timeout. Resolves to `"timeout"` when the
 * timer fires first; otherwise resolves to the awaited value. The
 * timer is cleaned up in either branch so the caller doesn't leak a
 * pending setTimeout handle.
 */
async function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      resolve("timeout");
    }, ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
