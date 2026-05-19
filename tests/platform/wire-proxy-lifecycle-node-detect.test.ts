import { describe, expect, it, vi } from "vitest";

import type { SubprocessHandle, SubprocessLike } from "../../src/platform/proxy-lifecycle.js";
import {
  NODE_BINARY_CANDIDATES,
  detectNodeBinaryWithStatus,
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
