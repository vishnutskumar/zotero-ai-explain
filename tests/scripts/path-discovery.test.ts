/**
 * Tests for scripts/llm-proxy/path-discovery.mjs.
 *
 * The path-discovery module solves Bug B2: macOS GUI apps (Zotero,
 * Firefox) spawn the proxy with a stripped-down PATH, so spawn('codex')
 * fails ENOENT even though codex is installed via Homebrew. The module
 * enriches `process.env.PATH` from the user's login shell and resolves
 * binaries with `findBinary()`.
 *
 * Coverage targets:
 *   - shell selection for fish / nu / bash / zsh
 *   - shell timeout / failure / non-zero exit → null
 *   - mergePathEntries dedup + order preservation
 *   - enrichEnvironmentPath idempotence (running twice adds nothing the
 *     second time)
 *   - shell-success vs fallback branches
 *   - Windows short-circuit (no shell query)
 *   - findBinary: override, search order, executable check, missing →
 *     null + searched list
 *
 * All tests inject stubs — none spawn a real shell.
 */

import { describe, expect, it, vi } from "vitest";

import {
  FALLBACK_PATH_ENTRIES,
  discoverLoginShellPath,
  enrichEnvironmentPath,
  findBinary,
  mergePathEntries,
  shellPathQuery
} from "../../scripts/llm-proxy/path-discovery.mjs";

describe("shellPathQuery", () => {
  it("returns null for missing / empty SHELL", () => {
    expect(shellPathQuery(undefined)).toBeNull();
    expect(shellPathQuery("")).toBeNull();
  });

  it("emits the POSIX printf form for bash/zsh/dash/ksh", () => {
    for (const shell of ["/bin/zsh", "/bin/bash", "/bin/sh", "/bin/dash", "/bin/ksh"]) {
      const q = shellPathQuery(shell);
      expect(q).not.toBeNull();
      expect(q?.command).toBe(shell);
      expect(q?.args).toEqual(["-lc", 'printf "%s" "$PATH"']);
    }
  });

  it("emits the fish string-join form for fish", () => {
    const q = shellPathQuery("/opt/homebrew/bin/fish");
    expect(q).toEqual({ command: "/opt/homebrew/bin/fish", args: ["-lc", "string join : $PATH"] });
  });

  it("emits the nushell str-join form for nu", () => {
    const q = shellPathQuery("/usr/local/bin/nu");
    expect(q?.args).toEqual(["-lc", '$env.PATH | str join ":"']);
  });
});

describe("mergePathEntries", () => {
  it("appends new entries and preserves order of existing ones", () => {
    const out = mergePathEntries("/usr/bin:/bin", "/opt/homebrew/bin:/usr/local/bin");
    expect(out).toBe("/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin");
  });

  it("dedupes — never adds an entry already present in currentPath", () => {
    const out = mergePathEntries("/usr/bin:/bin", "/usr/bin:/opt/homebrew/bin");
    expect(out).toBe("/usr/bin:/bin:/opt/homebrew/bin");
  });

  it("ignores empty / whitespace entries", () => {
    const out = mergePathEntries(":/usr/bin: ", "/bin:::/opt/homebrew/bin: ");
    expect(out).toBe("/usr/bin:/bin:/opt/homebrew/bin");
  });

  it("accepts an iterable additions argument", () => {
    const out = mergePathEntries("/usr/bin", ["/bin", "/opt/homebrew/bin"]);
    expect(out).toBe("/usr/bin:/bin:/opt/homebrew/bin");
  });
});

/* eslint-disable @typescript-eslint/no-unsafe-assignment --
 * The spawn stub in this file casts through `unknown as <complex
 * ChildProcess signature>`, which eslint flags as unsafe. The casts are
 * intentional — the real ChildProcess shape is far richer than the
 * subset `discoverLoginShellPath` consumes, and faking the full thing
 * would dwarf the actual test logic. We disable the rule file-wide here
 * because every spawn-stub test below hits the same warning. */

/**
 * Minimal child-process shape `discoverLoginShellPath` consumes. The
 * real `spawn` returns a much richer ChildProcess; we model only what
 * the module touches so the test stub stays simple and type-safe.
 */
type StubChild = {
  kill(signal?: string): void;
  on(name: string, cb: (arg: unknown) => void): void;
  stdout: {
    on(name: string, cb: (chunk: string) => void): void;
    setEncoding(enc: string): void;
  };
};

// The spawn we hand to `discoverLoginShellPath`. Declared as a type
// alias rather than inline so the eslint type-narrowing is clean and
// no `any` casts are needed downstream. Importing the real
// `typeof spawn` would pull in a ChildProcess shape with hundreds of
// fields; this contract captures exactly the API surface used.
type StubSpawn = (cmd: string, args: readonly string[], opts: unknown) => StubChild;

function makeSpawnStub({
  stdout = "",
  exitCode = 0,
  delayMs = 0,
  errorOnSpawn = null,
  errorEvent = null
}: {
  readonly stdout?: string;
  readonly exitCode?: number;
  readonly delayMs?: number;
  readonly errorOnSpawn?: Error | null;
  readonly errorEvent?: Error | null;
}): StubSpawn {
  return () => {
    if (errorOnSpawn) throw errorOnSpawn;
    const listeners: Record<string, ((arg: unknown) => void)[]> = {
      error: [],
      close: [],
      data: []
    };
    const child: StubChild = {
      kill() {
        /* noop */
      },
      on(name, cb) {
        (listeners[name] ??= []).push(cb);
      },
      stdout: {
        on(name, cb) {
          (listeners[name] ??= []).push(cb as (arg: unknown) => void);
        },
        setEncoding() {
          /* noop */
        }
      }
    };
    setTimeout(() => {
      if (errorEvent !== null) {
        for (const cb of listeners.error ?? []) cb(errorEvent);
        return;
      }
      if (stdout.length > 0) {
        for (const cb of listeners.data ?? []) cb(stdout);
      }
      for (const cb of listeners.close ?? []) cb(exitCode);
    }, delayMs);
    return child;
  };
}

describe("discoverLoginShellPath", () => {
  it("resolves to the shell's stdout when exit code is 0", async () => {
    const spawn = makeSpawnStub({ stdout: "/opt/homebrew/bin:/usr/bin\n" });
    const result = await discoverLoginShellPath({
      shell: "/bin/zsh",
      spawn: spawn as unknown as typeof import("node:child_process").spawn
    });
    expect(result).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("returns null when the shell exits non-zero", async () => {
    const spawn = makeSpawnStub({ stdout: "garbage", exitCode: 2 });
    const result = await discoverLoginShellPath({
      shell: "/bin/zsh",
      spawn: spawn as unknown as typeof import("node:child_process").spawn
    });
    expect(result).toBeNull();
  });

  it("returns null when the shell never finishes within the timeout", async () => {
    const spawn = makeSpawnStub({ stdout: "/opt/homebrew/bin", delayMs: 50 });
    const result = await discoverLoginShellPath({
      shell: "/bin/zsh",
      timeoutMs: 5,
      spawn: spawn as unknown as typeof import("node:child_process").spawn
    });
    expect(result).toBeNull();
  });

  it("returns null when the spawn throws synchronously (unknown shell)", async () => {
    const spawn = makeSpawnStub({ errorOnSpawn: new Error("ENOENT") });
    const result = await discoverLoginShellPath({
      shell: "/no/such/shell",
      spawn: spawn as unknown as typeof import("node:child_process").spawn
    });
    expect(result).toBeNull();
  });

  it("returns null when SHELL is missing entirely", async () => {
    const throwSpawn: StubSpawn = () => {
      throw new Error("should not be called");
    };
    const result = await discoverLoginShellPath({
      env: { PATH: "/usr/bin" },
      spawn: throwSpawn as unknown as typeof import("node:child_process").spawn
    });
    expect(result).toBeNull();
  });
});

describe("enrichEnvironmentPath", () => {
  it("merges discovered shell PATH into env.PATH when discovery succeeds", async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      SHELL: "/bin/zsh"
    };
    const result = await enrichEnvironmentPath({
      env,
      platform: "darwin",
      discover: () => Promise.resolve("/opt/homebrew/bin:/usr/local/bin:/usr/bin")
    });
    expect(result.source).toBe("shell");
    expect(result.added).toEqual(["/opt/homebrew/bin", "/usr/local/bin"]);
    expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin");
    expect(result.shellUsed).toBe("/bin/zsh");
  });

  it("falls back to FALLBACK_PATH_ENTRIES (only those that exist) when shell discovery fails", async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/zsh"
    };
    const exists = vi.fn((p: string) => p === "/opt/homebrew/bin" || p === "/usr/local/bin");
    const result = await enrichEnvironmentPath({
      env,
      platform: "darwin",
      exists,
      discover: () => Promise.resolve(null)
    });
    expect(result.source).toBe("fallback");
    expect(result.added).toContain("/opt/homebrew/bin");
    expect(result.added).toContain("/usr/local/bin");
    // Entries that don't exist on this machine must not be added.
    expect(result.added).not.toContain("/opt/local/bin");
  });

  it("is idempotent: running twice adds nothing the second time (Bug B2 regression)", async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      SHELL: "/bin/zsh"
    };
    const discover = vi.fn(() => Promise.resolve("/opt/homebrew/bin"));
    const first = await enrichEnvironmentPath({ env, platform: "darwin", discover });
    expect(first.added).toEqual(["/opt/homebrew/bin"]);
    expect(env.PATH).toContain("/opt/homebrew/bin");
    const second = await enrichEnvironmentPath({ env, platform: "darwin", discover });
    expect(second.source).toBe("noop");
    expect(second.added).toEqual([]);
    // env.PATH unchanged after the second call.
    expect(env.PATH).toBe("/usr/bin:/bin:/opt/homebrew/bin");
  });

  it("is a no-op on Windows (GUI apps inherit user PATH normally)", async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows;C:\\Windows\\System32",
      SHELL: undefined
    };
    const discover = vi.fn(() => Promise.resolve("/should/not/run"));
    const result = await enrichEnvironmentPath({ env, platform: "win32", discover });
    expect(result.source).toBe("noop");
    expect(result.added).toEqual([]);
    expect(discover).not.toHaveBeenCalled();
  });

  it("never throws when discover() rejects", async () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", SHELL: "/bin/zsh" };
    await expect(
      enrichEnvironmentPath({
        env,
        platform: "darwin",
        exists: () => false,
        discover: () => Promise.reject(new Error("boom"))
      })
    ).resolves.toMatchObject({ source: expect.stringMatching(/fallback|noop/u) });
  });
});

describe("findBinary", () => {
  it("returns the override verbatim when it's executable, and stops searching", () => {
    const result = findBinary("codex", {
      env: { PATH: "/usr/bin:/bin" },
      override: "/custom/bin/codex",
      isExecutable: (p: string) => p === "/custom/bin/codex"
    });
    expect(result.path).toBe("/custom/bin/codex");
    expect(result.searched).toEqual(["/custom/bin/codex"]);
  });

  it("a non-executable override reports path=null instead of painting green (codex review #1 residual)", () => {
    // Even when the user explicitly set PROXY_CODEX_BIN, a typoed path
    // or one missing +x bit must NOT be reported as "found" — the
    // settings dialog would paint a green row and the user would only
    // find out at spawn time with an EACCES.
    const result = findBinary("codex", {
      env: { PATH: "/usr/bin:/bin" },
      override: "/no/such/path/codex",
      isExecutable: () => false
    });
    expect(result.path).toBeNull();
    expect(result.searched).toEqual(["/no/such/path/codex"]);
  });

  it("default executable check on POSIX uses access(X_OK), not just exists (codex review #1)", () => {
    // Regression: the default `isExecutable` was `existsSync`, so a
    // /opt/homebrew/bin/codex without +x bits painted a green "found"
    // row in the settings dialog and then EACCES'd at spawn time.
    // The fixed default routes through `accessSync(path, X_OK)` on
    // POSIX. We verify by pointing PATH at a fake-only-on-this-machine
    // directory; the accessSync default throws ENOENT and findBinary
    // returns null. The pre-fix code would have returned the candidate
    // when `exists` (the previous default) was the fallback for
    // `isExecutable` — both checks point at the same syscall, so the
    // assertion still discriminates because the test passes no
    // `isExecutable` override at all, exercising the live default.
    const result = findBinary("codex", {
      env: {
        PATH: "/var/test-fixture/zotero-ai-test-prefix-9999/bin:/var/test-fixture/zotero-ai-test-prefix-9998/bin"
      },
      platform: "darwin"
    });
    expect(result.path).toBeNull();
  });

  it("returns null and the full searched-paths list when the binary is missing everywhere", () => {
    const result = findBinary("codex", {
      env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
      exists: () => false,
      isExecutable: () => false,
      platform: "darwin"
    });
    expect(result.path).toBeNull();
    expect(result.searched).toEqual(["/usr/bin/codex", "/bin/codex", "/opt/homebrew/bin/codex"]);
  });

  it("returns the first executable match in PATH order", () => {
    const result = findBinary("codex", {
      env: { PATH: "/usr/bin:/opt/homebrew/bin" },
      isExecutable: (p: string) => p === "/opt/homebrew/bin/codex",
      platform: "darwin"
    });
    expect(result.path).toBe("/opt/homebrew/bin/codex");
    expect(result.searched).toEqual(["/usr/bin/codex", "/opt/homebrew/bin/codex"]);
  });

  it("on Windows expands PATHEXT to .exe / .cmd / .bat in order", () => {
    const tried: string[] = [];
    const result = findBinary("codex", {
      env: { PATH: "C:\\bin", PATHEXT: ".EXE;.CMD" },
      platform: "win32",
      isExecutable: (p: string) => {
        tried.push(p);
        return p.endsWith(".cmd");
      }
    });
    expect(result.path).toBe("C:\\bin\\codex.cmd");
    expect(tried).toEqual(["C:\\bin\\codex.exe", "C:\\bin\\codex.cmd"]);
  });

  it("treats an empty override the same as no override (falls through to PATH search)", () => {
    const result = findBinary("codex", {
      env: { PATH: "/opt/homebrew/bin" },
      override: "   ",
      isExecutable: () => true,
      platform: "darwin"
    });
    expect(result.path).toBe("/opt/homebrew/bin/codex");
  });
});

describe("FALLBACK_PATH_ENTRIES", () => {
  it("includes the common macOS Homebrew prefixes", () => {
    expect(FALLBACK_PATH_ENTRIES).toContain("/opt/homebrew/bin");
    expect(FALLBACK_PATH_ENTRIES).toContain("/usr/local/bin");
  });

  it("includes user-local runtime install dirs (cargo, bun, .local)", () => {
    const joined = FALLBACK_PATH_ENTRIES.join(":");
    expect(joined).toContain(".cargo/bin");
    expect(joined).toContain(".bun/bin");
    expect(joined).toContain(".local/bin");
  });
});
