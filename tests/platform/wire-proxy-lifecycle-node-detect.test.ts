import { describe, expect, it, vi } from "vitest";

import type { SubprocessHandle, SubprocessLike } from "../../src/platform/proxy-lifecycle.js";
import {
  NODE_BINARY_CANDIDATES,
  detectNodeBinaryWithStatus,
  homeRelativeNodeCandidates,
  wireProxyLifecycle
} from "../../src/platform/wire-proxy-lifecycle.js";

function stubSubprocess(): SubprocessLike {
  const callImpl: SubprocessLike["call"] = () =>
    Promise.resolve({
      pid: 1,
      wait: () => new Promise(() => undefined),
      kill: () => undefined
    } as SubprocessHandle);
  return { call: vi.fn(callImpl) };
}

describe("detectNodeBinaryWithStatus", () => {
  it("prefers `whichRunner` output over the candidate list", () => {
    const result = detectNodeBinaryWithStatus({
      whichRunner: () => "/custom/which/node",
      pathExists: () => true
    });
    expect(result.path).toBe("/custom/which/node");
    expect(result.autoDetectFailed).toBe(false);
  });

  it("trims whichRunner output (which prints a trailing newline)", () => {
    const result = detectNodeBinaryWithStatus({
      whichRunner: () => "  /opt/homebrew/bin/node\n",
      pathExists: () => false
    });
    expect(result.path).toBe("/opt/homebrew/bin/node");
  });

  it("falls back to candidate paths when whichRunner returns null", () => {
    const result = detectNodeBinaryWithStatus({
      whichRunner: () => null,
      pathExists: (p) => p === NODE_BINARY_CANDIDATES[2]
    });
    expect(result.path).toBe(NODE_BINARY_CANDIDATES[2]);
    expect(result.autoDetectFailed).toBe(false);
  });

  it("falls back to candidate paths when whichRunner throws", () => {
    const result = detectNodeBinaryWithStatus({
      whichRunner: () => {
        throw new Error("subprocess crashed");
      },
      pathExists: (p) => p === NODE_BINARY_CANDIDATES[0]
    });
    expect(result.path).toBe(NODE_BINARY_CANDIDATES[0]);
  });

  it("returns the bare 'node' command and flags auto-detect failed when nothing is found", () => {
    const result = detectNodeBinaryWithStatus({
      pathExists: () => false
    });
    expect(result.path).toBe("node");
    expect(result.autoDetectFailed).toBe(true);
  });

  it("Apple Silicon Homebrew path takes priority over /usr/local/bin in the candidate list", () => {
    // Apple Silicon Macs install Homebrew under /opt/homebrew by
    // default; placing this candidate FIRST means the most common
    // current-gen developer machine wins without needing the
    // whichRunner path.
    expect(NODE_BINARY_CANDIDATES[0]).toBe("/opt/homebrew/bin/node");
    expect(NODE_BINARY_CANDIDATES[1]).toBe("/usr/local/bin/node");
  });

  it("AC-20: includes Windows defaults in the static candidate list", () => {
    expect(NODE_BINARY_CANDIDATES).toContain("C:\\Program Files\\nodejs\\node.exe");
    expect(NODE_BINARY_CANDIDATES).toContain("C:\\Program Files (x86)\\nodejs\\node.exe");
  });

  it("AC-20: appends home-relative shim candidates when homeDir is supplied", () => {
    const wantedShim = "/var/test-fixture/dev/.volta/bin/node";
    const result = detectNodeBinaryWithStatus({
      pathExists: (p) => p === wantedShim,
      homeDir: "/var/test-fixture/dev"
    });
    expect(result.path).toBe(wantedShim);
    expect(result.autoDetectFailed).toBe(false);
  });

  it("AC-20: home-relative candidates cover volta / asdf / fnm / n", () => {
    const candidates = homeRelativeNodeCandidates("/var/test-fixture/dev");
    expect(candidates).toContain("/var/test-fixture/dev/.volta/bin/node");
    expect(candidates).toContain("/var/test-fixture/dev/.asdf/shims/node");
    expect(candidates).toContain("/var/test-fixture/dev/.local/share/fnm/aliases/default/bin/node");
    expect(candidates).toContain("/var/test-fixture/dev/n/bin/node");
  });

  it("AC-20: home-relative candidates use Windows-style separators when homeDir contains backslashes", () => {
    const candidates = homeRelativeNodeCandidates("C:\\Users\\Dev");
    expect(candidates).toContain("C:\\Users\\Dev\\.volta\\bin\\node");
  });

  it("AC-20: detection prefers static system paths over home-relative shims when both exist", () => {
    // /opt/homebrew/bin/node should win over ~/.volta/bin/node so a
    // system-managed Node beats a developer's local shim.
    const result = detectNodeBinaryWithStatus({
      pathExists: (p) =>
        p === "/opt/homebrew/bin/node" || p === "/var/test-fixture/dev/.volta/bin/node",
      homeDir: "/var/test-fixture/dev"
    });
    expect(result.path).toBe("/opt/homebrew/bin/node");
  });
});

describe("wireProxyLifecycle.redetectNode", () => {
  it("AC-20: re-runs detection and updates the snapshot", () => {
    let nodeExists = false;
    const wired = wireProxyLifecycle({
      subprocess: stubSubprocess(),
      pathExists: () => nodeExists
    });
    // Before install: autoDetectFailed=true, falls back to "node".
    expect(wired.snapshot().nodeAutoDetectFailed).toBe(true);
    expect(wired.snapshot().nodeBinaryPath).toBe("node");
    // Simulate user installing Node, then clicking Detect.
    nodeExists = true;
    const refreshed = wired.redetectNode();
    expect(refreshed.nodeAutoDetectFailed).toBe(false);
    expect(refreshed.nodeBinaryPath).toBe(NODE_BINARY_CANDIDATES[0]);
  });

  it("AC-20: persists the resolved Node path when detection succeeds", () => {
    const prefs = new Map<string, string>();
    const wired = wireProxyLifecycle({
      subprocess: stubSubprocess(),
      pathExists: (p) => p === NODE_BINARY_CANDIDATES[0],
      prefs: {
        get: (n) => prefs.get(n),
        set: (n, v) => {
          prefs.set(n, v);
        }
      }
    });
    wired.redetectNode();
    expect(prefs.get("extensions.zotero-ai-explain.proxy-node-binary")).toBe(
      NODE_BINARY_CANDIDATES[0]
    );
  });

  it("AC-20: skips persisting when detection still fails so the user can fix and retry", () => {
    const prefs = new Map<string, string>();
    const wired = wireProxyLifecycle({
      subprocess: stubSubprocess(),
      pathExists: () => false,
      prefs: {
        get: (n) => prefs.get(n),
        set: (n, v) => {
          prefs.set(n, v);
        }
      }
    });
    wired.redetectNode();
    expect(prefs.has("extensions.zotero-ai-explain.proxy-node-binary")).toBe(false);
  });
});

describe("wireProxyLifecycle node auto-detect surface", () => {
  it("snapshot reports nodeAutoDetectFailed=false when a candidate exists", () => {
    const wired = wireProxyLifecycle({
      subprocess: stubSubprocess(),
      pathExists: (p) => p === NODE_BINARY_CANDIDATES[0]
    });
    const snap = wired.snapshot();
    expect(snap.nodeAutoDetectFailed).toBe(false);
    expect(snap.nodeBinaryPath).toBe(NODE_BINARY_CANDIDATES[0]);
  });

  it("snapshot reports nodeAutoDetectFailed=true when no candidate exists AND no whichRunner is wired", () => {
    const wired = wireProxyLifecycle({
      subprocess: stubSubprocess(),
      pathExists: () => false
    });
    const snap = wired.snapshot();
    expect(snap.nodeAutoDetectFailed).toBe(true);
    expect(snap.nodeBinaryPath).toBe("node");
  });

  it("whichRunner-resolved path clears the autoDetectFailed flag", () => {
    const wired = wireProxyLifecycle({
      subprocess: stubSubprocess(),
      whichRunner: () => "/var/test-fixture/dev/.nvm/versions/node/v22.0.0/bin/node",
      pathExists: () => false
    });
    const snap = wired.snapshot();
    expect(snap.nodeAutoDetectFailed).toBe(false);
    expect(snap.nodeBinaryPath).toBe("/var/test-fixture/dev/.nvm/versions/node/v22.0.0/bin/node");
  });

  it("user-typed node path via applyValues clears nodeAutoDetectFailed", () => {
    const wired = wireProxyLifecycle({
      subprocess: stubSubprocess(),
      pathExists: () => false
    });
    expect(wired.snapshot().nodeAutoDetectFailed).toBe(true);
    wired.applyValues({
      nodeBinaryPath: "/custom/path/node",
      serverScriptPath: "/srv.mjs",
      port: 11400
    });
    const snap = wired.snapshot();
    expect(snap.nodeAutoDetectFailed).toBe(false);
    expect(snap.nodeBinaryPath).toBe("/custom/path/node");
  });
});
