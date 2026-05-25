import { describe, expect, it, vi } from "vitest";

import type { SubprocessHandle, SubprocessLike } from "../../src/platform/proxy-lifecycle.js";
import {
  DEFAULT_PROXY_PORT,
  LLM_PROXY_AUTH_TOKEN_ENV,
  NODE_BINARY_CANDIDATES,
  PROXY_AUTOSTART_PREF,
  PROXY_CONFIG_READ_CONSENT_PREF,
  PROXY_NODE_BINARY_PREF,
  PROXY_PORT_PREF,
  PROXY_SERVER_SCRIPT_PREF,
  wireProxyLifecycle,
  type ProxyPrefStore
} from "../../src/platform/wire-proxy-lifecycle.js";

function fakeSubprocess(): {
  readonly subprocess: SubprocessLike;
  readonly calls: {
    command: string;
    args: readonly string[];
    env: Readonly<Record<string, string>> | undefined;
  }[];
} {
  const calls: {
    command: string;
    args: readonly string[];
    env: Readonly<Record<string, string>> | undefined;
  }[] = [];
  const callImpl: SubprocessLike["call"] = (spec) => {
    calls.push({ command: spec.command, args: spec.arguments, env: spec.environment });
    const handle: SubprocessHandle = {
      pid: 999,
      // Never resolves on its own — tests that need exit semantics
      // would queue their own handle.
      wait: () =>
        new Promise<{ readonly exitCode: number | null }>(() => {
          // intentionally pending
        }),
      kill: () => undefined
    };
    return Promise.resolve(handle);
  };
  const subprocess: SubprocessLike = {
    call: vi.fn(callImpl)
  };
  return { subprocess, calls };
}

/**
 * Subprocess fake that gives the caller imperative control over the
 * child's wait() promise so tests can simulate an unsolicited exit and
 * assert against the wire-proxy onStateChange that follows.
 */
function controllableSubprocess(): {
  subprocess: SubprocessLike;
  releaseExit: (code: number | null) => void;
  calls: {
    command: string;
    args: readonly string[];
    env: Readonly<Record<string, string>> | undefined;
  }[];
} {
  const calls: {
    command: string;
    args: readonly string[];
    env: Readonly<Record<string, string>> | undefined;
  }[] = [];
  let resolveWait: ((value: { readonly exitCode: number | null }) => void) | null = null;
  const callImpl: SubprocessLike["call"] = (spec) => {
    calls.push({ command: spec.command, args: spec.arguments, env: spec.environment });
    const waitPromise = new Promise<{ readonly exitCode: number | null }>((resolve) => {
      resolveWait = resolve;
    });
    const handle: SubprocessHandle = {
      pid: 1234,
      wait: () => waitPromise,
      kill: () => undefined,
      stderr: {
        async readString(): Promise<string | null> {
          await Promise.resolve();
          return null;
        }
      }
    };
    return Promise.resolve(handle);
  };
  return {
    subprocess: { call: vi.fn(callImpl) },
    releaseExit(code) {
      resolveWait?.({ exitCode: code });
    },
    calls
  };
}

function memPrefs(initial?: Record<string, string>): ProxyPrefStore & {
  readonly store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    store,
    get(name) {
      return store.get(name);
    },
    set(name, value) {
      store.set(name, value);
    }
  };
}

describe("wireProxyLifecycle defaults", () => {
  it("auto-detects Node binary via pathExists in candidate order", () => {
    const sub = fakeSubprocess();
    // Force the detector to skip the highest-priority candidate so the
    // second-priority one wins. Robust against future reordering of the
    // candidate list because it consults the export directly.
    const second = NODE_BINARY_CANDIDATES[1];
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      pathExists: (p) => p === second
    });
    const snap = wired.snapshot();
    expect(snap.nodeBinaryPath).toBe(second);
    expect(snap.port).toBe(DEFAULT_PROXY_PORT);
    expect(snap.running).toBe(false);
  });

  it("falls back to bare 'node' when no candidate exists", () => {
    const sub = fakeSubprocess();
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      pathExists: () => false
    });
    expect(wired.snapshot().nodeBinaryPath).toBe("node");
  });

  it("honors persisted prefs over the default detector", () => {
    const sub = fakeSubprocess();
    const prefs = memPrefs({
      [PROXY_NODE_BINARY_PREF]: "/custom/bin/node",
      [PROXY_SERVER_SCRIPT_PREF]: "/custom/server.mjs",
      [PROXY_PORT_PREF]: "12345"
    });
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      prefs,
      pathExists: () => true
    });
    const snap = wired.snapshot();
    expect(snap.nodeBinaryPath).toBe("/custom/bin/node");
    expect(snap.serverScriptPath).toBe("/custom/server.mjs");
    expect(snap.port).toBe(12345);
  });

  it("uses defaultServerScriptPath when no pref override exists", () => {
    const sub = fakeSubprocess();
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      defaultServerScriptPath: "/from/default/server.mjs",
      pathExists: () => false
    });
    expect(wired.snapshot().serverScriptPath).toBe("/from/default/server.mjs");
  });
});

describe("wireProxyLifecycle applyValues", () => {
  it("persists new values into the pref store", () => {
    const sub = fakeSubprocess();
    const prefs = memPrefs();
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      prefs,
      pathExists: () => false
    });
    wired.applyValues({
      nodeBinaryPath: "/edited/node",
      serverScriptPath: "/edited/server.mjs",
      port: 22222
    });
    expect(prefs.store.get(PROXY_NODE_BINARY_PREF)).toBe("/edited/node");
    expect(prefs.store.get(PROXY_SERVER_SCRIPT_PREF)).toBe("/edited/server.mjs");
    expect(prefs.store.get(PROXY_PORT_PREF)).toBe("22222");
    const snap = wired.snapshot();
    expect(snap.nodeBinaryPath).toBe("/edited/node");
    expect(snap.port).toBe(22222);
  });
});

describe("wireProxyLifecycle start/stop", () => {
  it("delegates start to the underlying lifecycle and reports onStateChange", async () => {
    const sub = fakeSubprocess();
    const onStateChange = vi.fn();
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs",
      onStateChange
    });
    const result = await wired.start();
    expect(result).toEqual({ pid: 999 });
    expect(sub.calls).toHaveLength(1);
    expect(sub.calls[0]).toMatchObject({
      command: "node",
      args: ["/abs/server.mjs"]
    });
    expect(onStateChange).toHaveBeenCalled();
    const latest = onStateChange.mock.calls.at(-1)?.[0] as { running: boolean };
    expect(latest.running).toBe(true);
  });

  it("auto-starts when the autostart pref is 'true'", async () => {
    const sub = fakeSubprocess();
    const prefs = memPrefs({
      "extensions.zotero-ai-explain.proxy-autostart": "true"
    });
    wireProxyLifecycle({
      subprocess: sub.subprocess,
      prefs,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs"
    });
    // Auto-start fires asynchronously; await microtasks.
    await Promise.resolve();
    await Promise.resolve();
    expect(sub.calls).toHaveLength(1);
  });

  it("auto-starts when the autostart pref is missing (opt-out default)", async () => {
    const sub = fakeSubprocess();
    wireProxyLifecycle({
      subprocess: sub.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs"
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sub.calls).toHaveLength(1);
  });

  it("does not auto-start when the autostart pref is explicitly 'false'", async () => {
    const sub = fakeSubprocess();
    const prefs = memPrefs({ [PROXY_AUTOSTART_PREF]: "false" });
    wireProxyLifecycle({
      subprocess: sub.subprocess,
      prefs,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs"
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sub.calls).toHaveLength(0);
  });

  it("populates snapshot().diagnostics after a successful start by fetching /api/diagnostics (Bug B2)", async () => {
    const sub = fakeSubprocess();
    const diagnosticsBody = {
      binaries: {
        codex: { path: "/opt/homebrew/bin/codex" },
        claude: { path: null, searchedCount: 2 }
      },
      path: {
        enrichment: { source: "shell", shellUsed: "/bin/zsh", addedCount: 1 }
      }
    };
    const diagnosticsFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(diagnosticsBody)
      })
    );
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs",
      diagnosticsFetch
    });
    const result = await wired.start();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    expect(result).toMatchObject({ pid: expect.any(Number) });
    expect(diagnosticsFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/diagnostics"),
      expect.any(Object)
    );
    const snap = wired.snapshot();
    expect(snap.diagnostics).toEqual(diagnosticsBody);
  });

  it("does not crash and leaves diagnostics undefined when /api/diagnostics fails", async () => {
    const sub = fakeSubprocess();
    const diagnosticsFetch = vi.fn(() => Promise.reject(new Error("ECONNREFUSED")));
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs",
      diagnosticsFetch
    });
    const result = await wired.start();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    expect(result).toMatchObject({ pid: expect.any(Number) });
    expect(wired.snapshot().diagnostics).toBeUndefined();
  });

  it("a stale /api/diagnostics fetch resolving after stop() does NOT repopulate diagnostics (codex review #3)", async () => {
    // Race: start() awaits fetchDiagnostics. The user clicks Stop
    // while the fetch is still in flight. stop() clears diagnostics
    // and the underlying child shuts down. Then the fetch resolves
    // with a body describing the now-dead process. Without a
    // generation guard, that body would overwrite the snapshot.
    const sub = controllableSubprocess();
    type JsonResolver = (value: { binaries: unknown; path: unknown }) => void;
    // Use a single-cell holder so TS doesn't narrow the slot back to
    // null after the synchronous `= null` initializer (the assignment
    // happens inside a Promise callback the flow analyzer doesn't see).
    const resolveJsonRef: { fn: JsonResolver | null } = { fn: null };
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs",
      diagnosticsFetch: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          // Stall the body resolution so the test can drive the race.
          json: () =>
            new Promise<{ binaries: unknown; path: unknown }>((resolve) => {
              resolveJsonRef.fn = resolve;
            })
        })
    });
    const startPromise = wired.start();
    // Yield enough microtasks for doSpawn to register the
    // controllable child handle (so releaseExit has a wait promise to
    // unblock). Without this the lifecycle hasn't recorded the child
    // when we trigger the exit, so doTerminate's await never resolves.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    // Stop before the diagnostics fetch resolves. Release the wait
    // exit so doTerminate completes.
    const stopPromise = wired.stop();
    sub.releaseExit(0);
    await stopPromise;
    expect(wired.snapshot().diagnostics).toBeUndefined();
    // Now resolve the stale body. The generation guard MUST drop it.
    resolveJsonRef.fn?.({
      binaries: {
        codex: { path: "/dead/codex" },
        claude: { path: null, searchedCount: 0 }
      },
      path: { enrichment: null }
    });
    await startPromise; // the fetch await completes; assignment should be skipped
    expect(wired.snapshot().diagnostics).toBeUndefined();
  });

  it("clears stale diagnostics on stop() so the UI never shows old data after a restart", async () => {
    const sub = controllableSubprocess();
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs",
      diagnosticsFetch: () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              binaries: {
                codex: { path: "/old/codex" },
                claude: { path: null, searchedCount: 0 }
              },
              path: { enrichment: null }
            })
        })
    });
    await wired.start();
    expect(wired.snapshot().diagnostics).toBeDefined();
    const stopPromise = wired.stop();
    // controllableSubprocess.wait() pends until we release; resolve so
    // the lifecycle's doTerminate() can complete its await.
    sub.releaseExit(0);
    await stopPromise;
    expect(wired.snapshot().diagnostics).toBeUndefined();
  });

  it("propagates the externally-managed flag into snapshot() and skips spawn (Bug B1)", async () => {
    // Wire layer must surface the lifecycle's externally-managed
    // detection: when the probe finds a foreign proxy on the port, the
    // snapshot reports running=true AND externallyManaged=true so the
    // settings UI can disable Stop and explain why.
    const sub = fakeSubprocess();
    const onStateChange = vi.fn();
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs",
      fetch: () => Promise.resolve({ ok: true, status: 200 }),
      onStateChange
    });
    const result = await wired.start();
    expect(result).toEqual({ external: true });
    expect(sub.calls).toHaveLength(0);
    const snap = wired.snapshot();
    expect(snap.running).toBe(true);
    expect(snap.externallyManaged).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const lastState: { running: boolean; externallyManaged: boolean } =
      onStateChange.mock.calls.at(-1)?.[0];
    expect(lastState.running).toBe(true);
    expect(lastState.externallyManaged).toBe(true);
  });
});

/**
 * Bug B — consent-gated config discovery: the wiring layer reads a
 * pref and forwards `LLM_PROXY_CONFIG_READ=allow` to the child only
 * when consent === "always".
 */
describe("wireProxyLifecycle config-read consent (Bug B)", () => {
  it("passes LLM_PROXY_CONFIG_READ=allow when the pref is 'always'", async () => {
    const sub = fakeSubprocess();
    const prefs = memPrefs({ [PROXY_CONFIG_READ_CONSENT_PREF]: "always" });
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      prefs,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs"
    });
    await wired.start();
    expect(sub.calls[0]?.env).toMatchObject({ LLM_PROXY_CONFIG_READ: "allow" });
  });

  it("AC-21: defaults to passing LLM_PROXY_CONFIG_READ=allow when the pref is missing", async () => {
    // AC-21 flipped the consent default to allow so the codex / claude
    // dropdowns serve the user's REAL configured models out of the
    // box. Users opt OUT by setting the pref to "never".
    const sub = fakeSubprocess();
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs"
    });
    await wired.start();
    expect(sub.calls[0]?.env).toMatchObject({ LLM_PROXY_CONFIG_READ: "allow" });
  });

  it("does NOT pass LLM_PROXY_CONFIG_READ when the pref is 'never'", async () => {
    const sub = fakeSubprocess();
    const prefs = memPrefs({ [PROXY_CONFIG_READ_CONSENT_PREF]: "never" });
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      prefs,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs"
    });
    await wired.start();
    const env = sub.calls[0]?.env ?? {};
    expect(env).not.toHaveProperty("LLM_PROXY_CONFIG_READ");
  });
});

/**
 * Bug C — exit-diagnostic propagation: the wiring layer must hydrate
 * `lastError` from the lifecycle's `ProxyExitInfo.stderr` whenever an
 * unexpected exit fires, and clear it on a successful start.
 */
describe("wireProxyLifecycle exit diagnostics (Bug C)", () => {
  it("populates snapshot().lastError with the buffered stderr on unexpected exit", async () => {
    const ctl = controllableSubprocess();
    const states: { running: boolean; lastError?: string }[] = [];
    const wired = wireProxyLifecycle({
      subprocess: ctl.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs",
      onStateChange: (s) => {
        states.push({
          running: s.running,
          ...(s.lastError !== undefined ? { lastError: s.lastError } : {})
        });
      }
    });
    await wired.start();
    // Simulate an immediate non-zero exit (e.g., EADDRINUSE).
    ctl.releaseExit(1);
    // Let the wait()-handler and onStateChange propagate.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const snap = wired.snapshot();
    expect(snap.running).toBe(false);
    expect(snap.lastError).toBeDefined();
    expect(snap.lastError).toMatch(/Proxy exited/u);
    // onStateChange MUST have received at least one update carrying
    // the lastError after the exit fired.
    const errStates = states.filter((s) => s.lastError !== undefined);
    expect(errStates.length).toBeGreaterThan(0);
  });

  it("codex P1: redetectNode() does NOT rebuild lifecycle while a start is in flight", async () => {
    // Race: start() awaits subprocess.call(); during that await,
    // trackedPid() is still null. Before the P1 fix, redetectNode()
    // saw null and rebuilt the lifecycle — orphaning whatever child
    // the original lifecycle ended up spawning.
    let resolveCall!: (handle: SubprocessHandle) => void;
    const pendingCalls: { command: string }[] = [];
    const callImpl: SubprocessLike["call"] = (spec) => {
      pendingCalls.push({ command: spec.command });
      return new Promise<SubprocessHandle>((resolve) => {
        resolveCall = resolve;
      });
    };
    const subprocess: SubprocessLike = { call: vi.fn(callImpl) };
    const wired = wireProxyLifecycle({
      subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs"
    });
    // Kick off start; await microtasks so the inner await reaches
    // the still-pending subprocess.call().
    const startP = wired.start();
    await Promise.resolve();
    await Promise.resolve();
    expect(pendingCalls).toHaveLength(1);

    // Concurrent Detect click. Before the fix this rebuilt the
    // lifecycle, and the subsequent resolveCall below would attach
    // the spawned handle to a lifecycle no longer referenced.
    wired.redetectNode();

    // Resolve the pending subprocess.call() — original lifecycle still
    // owns the spawn so it gets tracked, no orphan.
    const handle: SubprocessHandle = {
      pid: 4242,
      wait: () => new Promise(() => undefined),
      kill: () => undefined
    };
    resolveCall(handle);
    await startP;

    // The single spawn is tracked, and no extra spawn occurred from a
    // rebuilt lifecycle.
    expect(pendingCalls).toHaveLength(1);
    expect(wired.snapshot().running).toBe(true);
  });

  it("clears lastError on a fresh successful start()", async () => {
    const ctl = controllableSubprocess();
    const wired = wireProxyLifecycle({
      subprocess: ctl.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs"
    });
    await wired.start();
    ctl.releaseExit(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(wired.snapshot().lastError).toBeDefined();
    // Now start again — wiring should clear lastError before the new spawn.
    await wired.start();
    expect(wired.snapshot().lastError).toBeUndefined();
  });
});

/**
 * Proxy-auth wiring (C1-C4): the bearer token MUST land in the spawned
 * proxy's environment AND be readable via `getProxyAuthToken()` for the
 * bootstrap-side Ollama adapter closure to attach `Authorization: Bearer
 * <token>` to its requests. The token rotates per `start()` and clears
 * on `stop()` so a restart cleanly invalidates the old credential.
 */
describe("wireProxyLifecycle proxy-auth wiring", () => {
  const UUID_V4_SHAPE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

  it("C1: subprocess.call env carries LLM_PROXY_AUTH_TOKEN in UUID v4 shape", async () => {
    const sub = fakeSubprocess();
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs",
      // Disable auto-start so the only spawn captured is the one we
      // explicitly trigger from this test (auto-start would race the
      // explicit start() and double the call count).
      autoStartOverride: false
    });
    await wired.start();
    expect(sub.calls).toHaveLength(1);
    const env = sub.calls[0]?.env ?? {};
    // Asserted via the shared constant so a typo on either side
    // (parent OR child) surfaces here — see the C5 round-trip test
    // below for the cross-side guarantee.
    expect(env).toHaveProperty(LLM_PROXY_AUTH_TOKEN_ENV);
    expect(env[LLM_PROXY_AUTH_TOKEN_ENV]).toMatch(UUID_V4_SHAPE);
  });

  it("C2: getProxyAuthToken() returns the same UUID after start()", async () => {
    const sub = fakeSubprocess();
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs",
      autoStartOverride: false
    });
    // Before start, no token is minted — getProxyAuthToken reports null
    // so the bootstrap closure attaches no Authorization header.
    expect(wired.getProxyAuthToken()).toBeNull();
    await wired.start();
    const fromAccessor = wired.getProxyAuthToken();
    const fromEnv = sub.calls[0]?.env?.[LLM_PROXY_AUTH_TOKEN_ENV];
    expect(fromAccessor).not.toBeNull();
    expect(fromAccessor).toBe(fromEnv);
  });

  it("C3: getProxyAuthToken() returns null after stop()", async () => {
    const ctl = controllableSubprocess();
    const wired = wireProxyLifecycle({
      subprocess: ctl.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs",
      autoStartOverride: false
    });
    await wired.start();
    expect(wired.getProxyAuthToken()).not.toBeNull();
    const stopPromise = wired.stop();
    // Release the wait() promise so doTerminate() can complete its await.
    ctl.releaseExit(0);
    await stopPromise;
    expect(wired.getProxyAuthToken()).toBeNull();
  });

  it("C4: a second start() after stop() rotates the token (new UUID, not reused)", async () => {
    const ctl = controllableSubprocess();
    const wired = wireProxyLifecycle({
      subprocess: ctl.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs",
      autoStartOverride: false
    });
    await wired.start();
    const tokenA = wired.getProxyAuthToken();
    expect(tokenA).not.toBeNull();
    const stopPromise = wired.stop();
    ctl.releaseExit(0);
    await stopPromise;
    await wired.start();
    const tokenB = wired.getProxyAuthToken();
    expect(tokenB).not.toBeNull();
    expect(tokenB).not.toBe(tokenA);
    // Both spawns saw their own token in env, no carry-over.
    expect(ctl.calls).toHaveLength(2);
    expect(ctl.calls[0]?.env?.[LLM_PROXY_AUTH_TOKEN_ENV]).toBe(tokenA);
    expect(ctl.calls[1]?.env?.[LLM_PROXY_AUTH_TOKEN_ENV]).toBe(tokenB);
  });

  // -------------------------------------------------------------------
  // C5 (round-trip): the SHARED `LLM_PROXY_AUTH_TOKEN_ENV` symbol the
  // plugin imports MUST be the exact literal the proxy child reads from
  // `process.env`. The constant lives in `scripts/llm-proxy/protocol-
  // constants.mjs`; both sides (wire-proxy-lifecycle.ts AND the proxy
  // server.mjs) import it. This test feeds the spawn-environment value
  // BACK INTO `createProxyServer` via `process.env`, constructs a real
  // server, and asserts the bearer gate accepts a Bearer header carrying
  // the wired-side token. If either side drifts (typo on the
  // wire-proxy-lifecycle import path, typo on the server.mjs read), the
  // request 401s and this test fails — catching the kind of silent
  // no-auth-mode downgrade that the canary alone cannot.
  // -------------------------------------------------------------------
  it("C5: parent and child use the same env-var symbol — round-trips through createProxyServer", async () => {
    const sub = fakeSubprocess();
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs",
      autoStartOverride: false
    });
    await wired.start();
    // Read the env the plugin handed to the spawn — under the shared
    // symbol. A child-side typo on `process.env.LLM_PROXY_AUTH_TOKEN`
    // would still find the value if the parent kept the matching
    // literal, but reading via the constant on BOTH sides guarantees
    // they're locked together.
    const wiredEnv = sub.calls[0]?.env ?? {};
    const wiredToken = wiredEnv[LLM_PROXY_AUTH_TOKEN_ENV];
    expect(wiredToken).toBeDefined();
    // Construct a real proxy with the same env applied, then drive a
    // request through it. The proxy reads `process.env[LLM_PROXY_AUTH_
    // TOKEN_ENV]` at createProxyServer time — same constant.
    const { createProxyServer } = await import("../../scripts/llm-proxy/server.mjs");
    // Sanity guard: the value the parent set must equal the literal the
    // child reads. If a future refactor split the constant into two
    // copies that drifted, this assertion would fail along with the
    // bearer round-trip below.
    expect(LLM_PROXY_AUTH_TOKEN_ENV).toBe("LLM_PROXY_AUTH_TOKEN");
    const original = process.env.LLM_PROXY_AUTH_TOKEN;
    process.env.LLM_PROXY_AUTH_TOKEN = wiredToken;
    try {
      const proxy = createProxyServer();
      const port = await proxy.listen(0);
      try {
        // Correct token (wired-side) — must be accepted.
        const okResp = await fetch(`http://127.0.0.1:${String(port)}/api/tags`, {
          headers: { authorization: `Bearer ${String(wiredToken)}` }
        });
        expect(okResp.status).toBe(200);
        // No token — must be rejected. Confirms the gate is actually on.
        const noAuthResp = await fetch(`http://127.0.0.1:${String(port)}/api/tags`);
        expect(noAuthResp.status).toBe(401);
      } finally {
        await proxy.close();
      }
    } finally {
      if (original === undefined) delete process.env.LLM_PROXY_AUTH_TOKEN;
      else process.env.LLM_PROXY_AUTH_TOKEN = original;
    }
  });

  // -------------------------------------------------------------------
  // C6 (diagnostics auth header): after this patch `/api/diagnostics` is
  // bearer-gated on the proxy side (it leaks codex/claude binary paths).
  // The plugin's own diagnosticsFetch MUST therefore include the bearer
  // header it minted at spawn time, or it would 401 against its own
  // child. Asserted by capturing the init object the fetch was called
  // with and inspecting the headers.
  // -------------------------------------------------------------------
  it("C6: diagnosticsFetch is called with the Authorization header when auth is enabled", async () => {
    const sub = fakeSubprocess();
    const diagnosticsCalls: {
      url: string;
      init: { headers?: Record<string, string> } | undefined;
    }[] = [];
    const diagnosticsFetch = vi.fn((url: string, init?: { headers?: Record<string, string> }) => {
      diagnosticsCalls.push({ url, init });
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            binaries: {
              codex: { path: "/usr/bin/codex" },
              claude: { path: null, searchedCount: 0 }
            },
            path: { enrichment: null }
          })
      });
    });
    const wired = wireProxyLifecycle({
      subprocess: sub.subprocess,
      pathExists: () => false,
      defaultServerScriptPath: "/abs/server.mjs",
      diagnosticsFetch,
      autoStartOverride: false
    });
    await wired.start();
    const token = wired.getProxyAuthToken();
    expect(token).not.toBeNull();
    expect(diagnosticsCalls.length).toBeGreaterThanOrEqual(1);
    const firstCall = diagnosticsCalls[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.url).toMatch(/\/api\/diagnostics$/u);
    const headers = firstCall?.init?.headers ?? {};
    expect(headers.Authorization).toBe(`Bearer ${String(token)}`);
  });
});
