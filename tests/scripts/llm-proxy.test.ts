import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildClaudeArgs,
  createClaudeBackend,
  describeClaudeFailure,
  extractDeltaText as extractClaudeDeltaText,
  extractModelsFromClaudeConfig,
  readDiscoveredClaudeModels
} from "../../scripts/llm-proxy/backends/claude.mjs";
import {
  createCodexBackend,
  describeCodexFailure,
  extractDeltaText,
  parseCodexConfigTomlForModels,
  readDiscoveredCodexModels
} from "../../scripts/llm-proxy/backends/codex.mjs";
import { createOllamaBackend } from "../../scripts/llm-proxy/backends/ollama.mjs";
import { createProxyServer } from "../../scripts/llm-proxy/server.mjs";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type FakeChildOptions = {
  readonly stdoutLines: readonly string[];
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly closeDelayMs?: number;
};

type SpawnCall = {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly stdin: string;
};

function makeFakeChild(opts: FakeChildOptions) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    stdin: Writable;
    kill: (sig?: string) => void;
  };
  const stdinBuf: string[] = [];
  child.stdin = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      stdinBuf.push(text);
      cb();
    }
  });
  const noopRead = (): void => {
    // Stream needs a read implementation, but data is pushed externally.
  };
  child.stdout = new Readable({ read: noopRead });
  child.stderr = new Readable({ read: noopRead });
  child.kill = () => {
    // Behave like a real child: closing emits close.
    setImmediate(() => {
      child.emit("close", opts.exitCode ?? -1);
    });
  };
  // Drive the script asynchronously to mimic real spawn timing.
  setImmediate(() => {
    for (const line of opts.stdoutLines) {
      child.stdout.push(`${line}\n`);
    }
    child.stdout.push(null);
    if (opts.stderr && opts.stderr.length > 0) child.stderr.push(opts.stderr);
    child.stderr.push(null);
    const fire = () => child.emit("close", opts.exitCode ?? 0);
    if (opts.closeDelayMs && opts.closeDelayMs > 0) {
      setTimeout(fire, opts.closeDelayMs);
    } else {
      setImmediate(fire);
    }
  });
  return { child, getStdin: () => stdinBuf.join("") };
}

function makeSpawnRecorder(scripts: readonly FakeChildOptions[]) {
  const calls: SpawnCall[] = [];
  let i = 0;
  function spawn(cmd: string, args: readonly string[]): unknown {
    const script = scripts[Math.min(i, scripts.length - 1)] ?? { stdoutLines: [] };
    i++;
    const { child, getStdin } = makeFakeChild(script);
    // Capture stdin after the child consumes it (settled on next tick).
    setImmediate(() => {
      calls.push({ cmd, args: [...args], stdin: getStdin() });
    });
    return child;
  }
  return { spawn, calls };
}

async function postJson(
  port: number,
  path: string,
  body: unknown
): Promise<{ status: number; text: string }> {
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, text };
}

async function getJson(port: number, path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${String(port)}${path}`);
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

function ndjsonLines(text: string): unknown[] {
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

/**
 * Build a `codex/event` JSON-RPC notification carrying a single
 * `agent_message_content_delta` chunk — the per-token frame the
 * `codex mcp-server` backend now parses.
 */
function mcpDelta(delta: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "codex/event",
    params: { msg: { type: "agent_message_content_delta", delta } }
  });
}

/**
 * Build the JSON-RPC response for `tools/call codex` carrying a
 * `structuredContent.threadId`. The codex backend uses this to capture
 * the threadId for resume and to close stdin so the child exits.
 */
function mcpToolCallResponse(threadId: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: "" }],
      structuredContent: { threadId }
    }
  });
}

/**
 * Build a `codex/event` JSON-RPC notification carrying a non-delta
 * `msg` (e.g. `session_configured`, `task_started`). All of these
 * MUST flow through `extractDeltaText` as null so the assembled response
 * doesn't replay after the deltas.
 */
function mcpFraming(msg: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "codex/event",
    params: { msg }
  });
}

describe("llm-proxy / codex backend", () => {
  it("non-streaming chat assembles deltas into one Ollama-shape object", async () => {
    const { spawn } = makeSpawnRecorder([
      {
        stdoutLines: [
          mcpFraming({ type: "session_configured", session_id: "sess-1" }),
          mcpDelta("Hello "),
          mcpDelta("world"),
          mcpFraming({ type: "task_complete" }),
          mcpToolCallResponse("sess-1")
        ]
      }
    ]);
    const codexBackend = createCodexBackend({ spawn });
    const proxy = createProxyServer({ codexBackend });
    const port = await proxy.listen(0);
    try {
      const { status, text } = await postJson(port, "/codex/api/chat", {
        model: "gpt-5.2-codex",
        messages: [{ role: "user", content: "hi" }],
        stream: false
      });
      expect(status).toBe(200);
      const parsed = JSON.parse(text) as {
        message: { content: string };
        done: boolean;
        done_reason: string;
      };
      expect(parsed.message.content).toBe("Hello world");
      expect(parsed.done).toBe(true);
      expect(parsed.done_reason).toBe("stop");
    } finally {
      await proxy.close();
    }
  });

  it("streaming chat emits multiple done:false chunks then a done:true chunk", async () => {
    const { spawn } = makeSpawnRecorder([
      {
        stdoutLines: [
          mcpFraming({ type: "session_configured", session_id: "sess-2" }),
          mcpDelta("alpha"),
          mcpDelta(" beta"),
          mcpDelta(" gamma"),
          mcpToolCallResponse("sess-2")
        ]
      }
    ]);
    const codexBackend = createCodexBackend({ spawn });
    const proxy = createProxyServer({ codexBackend });
    const port = await proxy.listen(0);
    try {
      const { status, text } = await postJson(port, "/codex/api/chat", {
        model: "gpt-5.2-codex",
        messages: [{ role: "user", content: "hi" }],
        stream: true
      });
      expect(status).toBe(200);
      const lines = ndjsonLines(text) as {
        done: boolean;
        message?: { content: string };
        done_reason?: string;
      }[];
      const partials = lines.filter((l) => !l.done);
      const terminals = lines.filter((l) => l.done);
      // Hard streaming contract: at least TWO done:false chunks for a
      // three-delta upstream. A backend that buffered the deltas into a
      // single final emission would land at 1 here.
      expect(partials.length).toBeGreaterThanOrEqual(2);
      expect(terminals.length).toBe(1);
      expect(terminals[0]?.done_reason).toBe("stop");
      expect(partials.map((p) => p.message?.content ?? "").join("")).toBe("alpha beta gamma");
    } finally {
      await proxy.close();
    }
  });

  it("multi-turn: same first-user-message hash → first turn `codex`, second turn `codex-reply`", async () => {
    const recorder = makeSpawnRecorder([
      {
        stdoutLines: [
          mcpFraming({ type: "session_configured", session_id: "sess-multi" }),
          mcpDelta("one"),
          mcpToolCallResponse("sess-multi")
        ]
      },
      {
        stdoutLines: [
          mcpFraming({ type: "session_configured", session_id: "sess-multi" }),
          mcpDelta("two"),
          mcpToolCallResponse("sess-multi")
        ]
      }
    ]);
    const codexBackend = createCodexBackend({ spawn: recorder.spawn });
    const proxy = createProxyServer({ codexBackend });
    const port = await proxy.listen(0);
    try {
      const firstUserContent = "explain mitochondria";
      // Turn 1.
      await postJson(port, "/codex/api/chat", {
        messages: [{ role: "user", content: firstUserContent }],
        stream: false
      });
      // Turn 2 with the same first-user-message → must hit codex-reply.
      await postJson(port, "/codex/api/chat", {
        messages: [
          { role: "user", content: firstUserContent },
          { role: "assistant", content: "one" },
          { role: "user", content: "follow-up" }
        ],
        stream: false
      });
      // Allow setImmediate spawn-call capture to flush.
      await new Promise((r) => setImmediate(r));
      expect(recorder.calls.length).toBe(2);
      const firstArgs = recorder.calls[0]?.args ?? [];
      const secondArgs = recorder.calls[1]?.args ?? [];
      // Both turns spawn `codex mcp-server` — resume flows through the
      // tools/call payload, not the argv.
      expect(firstArgs[0]).toBe("mcp-server");
      expect(secondArgs[0]).toBe("mcp-server");
      // The MCP handshake on stdin carries the turn-specific tools/call.
      const firstStdin = recorder.calls[0]?.stdin ?? "";
      const secondStdin = recorder.calls[1]?.stdin ?? "";
      const firstToolCall = firstStdin
        .split("\n")
        .filter((l) => l.length > 0)
        .map(
          (l) =>
            JSON.parse(l) as {
              method?: string;
              params?: { name?: string; arguments?: Record<string, unknown> };
            }
        )
        .find((m) => m.method === "tools/call");
      const secondToolCall = secondStdin
        .split("\n")
        .filter((l) => l.length > 0)
        .map(
          (l) =>
            JSON.parse(l) as {
              method?: string;
              params?: { name?: string; arguments?: Record<string, unknown> };
            }
        )
        .find((m) => m.method === "tools/call");
      expect(firstToolCall?.params?.name).toBe("codex");
      expect(firstToolCall?.params?.arguments?.prompt).toBe(firstUserContent);
      expect(firstToolCall?.params?.arguments?.sandbox).toBe("read-only");
      expect(firstToolCall?.params?.arguments?.["approval-policy"]).toBe("never");
      expect(secondToolCall?.params?.name).toBe("codex-reply");
      expect(secondToolCall?.params?.arguments?.threadId).toBe("sess-multi");
      // The follow-up stdin must carry ONLY the latest user message in
      // the tools/call arguments — codex's resume reloads the session
      // on its end.
      expect(secondToolCall?.params?.arguments?.prompt).toBe("follow-up");
    } finally {
      await proxy.close();
    }
  });

  // AC-12 Adv-8 — codex spawn is MEASURED, not warmed (codex has no
  // daemon mode, SP-12.5). The high-value guard is "exactly one
  // `codex mcp-server` child per turn, and turn N>1 passes
  // `codex-reply` with the prior threadId" so multi-turn chats do not
  // pay a cold first-turn re-init each time.
  it("AC-12 Adv-8: runTurn spawns exactly ONE codex child per turn", async () => {
    const recorder = makeSpawnRecorder([
      {
        stdoutLines: [
          mcpFraming({ type: "session_configured", session_id: "sess-once" }),
          mcpDelta("answer"),
          mcpToolCallResponse("sess-once")
        ]
      }
    ]);
    const codexBackend = createCodexBackend({ spawn: recorder.spawn });
    await codexBackend.runTurn({
      messages: [{ role: "user", content: "single turn" }],
      onEvent: () => undefined
    });
    await new Promise((r) => setImmediate(r));
    // One turn → exactly one spawned child. A redundant re-spawn (e.g. a
    // speculative warm-up or a double-exec) turns this red.
    expect(recorder.calls.length).toBe(1);
    expect(recorder.calls[0]?.args[0]).toBe("mcp-server");
  });

  it("AC-12 Adv-8: turn N>1 of the same conversation passes `codex-reply` with the captured threadId — one child each", async () => {
    const recorder = makeSpawnRecorder([
      {
        stdoutLines: [
          mcpFraming({ type: "session_configured", session_id: "sess-resume" }),
          mcpDelta("first"),
          mcpToolCallResponse("sess-resume")
        ]
      },
      {
        stdoutLines: [
          mcpFraming({ type: "session_configured", session_id: "sess-resume" }),
          mcpDelta("second"),
          mcpToolCallResponse("sess-resume")
        ]
      }
    ]);
    const codexBackend = createCodexBackend({ spawn: recorder.spawn });
    const firstUser = "explain the krebs cycle";
    await codexBackend.runTurn({
      messages: [{ role: "user", content: firstUser }],
      onEvent: () => undefined
    });
    await codexBackend.runTurn({
      messages: [
        { role: "user", content: firstUser },
        { role: "assistant", content: "first" },
        { role: "user", content: "and the electron transport chain?" }
      ],
      onEvent: () => undefined
    });
    await new Promise((r) => setImmediate(r));
    // Each turn spawns exactly ONE child — two turns → two children.
    expect(recorder.calls.length).toBe(2);
    const firstArgs = recorder.calls[0]?.args ?? [];
    const secondArgs = recorder.calls[1]?.args ?? [];
    // Both turns invoke the MCP server; argv is identical (no resume flag).
    expect(firstArgs[0]).toBe("mcp-server");
    expect(secondArgs[0]).toBe("mcp-server");
    const secondToolCall = (recorder.calls[1]?.stdin ?? "")
      .split("\n")
      .filter((l) => l.length > 0)
      .map(
        (l) =>
          JSON.parse(l) as {
            method?: string;
            params?: { name?: string; arguments?: Record<string, unknown> };
          }
      )
      .find((m) => m.method === "tools/call");
    // Turn 2 reuses the codex session via `codex-reply { threadId }` so
    // the model does not pay a cold first-turn re-init.
    expect(secondToolCall?.params?.name).toBe("codex-reply");
    expect(secondToolCall?.params?.arguments?.threadId).toBe("sess-resume");
  });

  it("non-zero codex exit emits a terminal error chunk with stderr (no silent completion)", async () => {
    const { spawn } = makeSpawnRecorder([
      {
        stdoutLines: [],
        stderr: "codex: authentication failed — please run `codex login`",
        exitCode: 2
      }
    ]);
    const codexBackend = createCodexBackend({ spawn });
    const proxy = createProxyServer({ codexBackend });
    const port = await proxy.listen(0);
    try {
      const { status, text } = await postJson(port, "/codex/api/chat", {
        messages: [{ role: "user", content: "anything" }],
        stream: true
      });
      expect(status).toBe(200);
      const lines = ndjsonLines(text) as {
        done: boolean;
        done_reason?: string;
        error?: string;
      }[];
      const terminal = lines.find((l) => l.done);
      expect(terminal).toBeDefined();
      expect(terminal?.done_reason).toBe("error");
      expect(terminal?.error).toMatch(/authentication failed/);
      // Hard contract: there must NOT be a done:true with done_reason:"stop" hiding the error.
      const stopTerminal = lines.find((l) => l.done && l.done_reason === "stop");
      expect(stopTerminal).toBeUndefined();
    } finally {
      await proxy.close();
    }
  });

  it("M8 (codex): SIGTERM grace then SIGKILL escalation when child ignores SIGTERM", async () => {
    // Custom spawn whose fake child IGNORES SIGTERM but emits close on
    // SIGKILL. Without the M8 fix, the backend awaits exit indefinitely
    // and the request hangs past the idle/hard timeout. With the fix,
    // the SIGKILL escalation fires after `sigkillGraceMs` (here 0) and
    // the backend resolves.
    const observedSignals: string[] = [];
    function spawn(): unknown {
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        stdin: Writable;
        kill: (sig?: string) => void;
      };
      const noopRead = (): void => undefined;
      child.stdout = new Readable({ read: noopRead });
      child.stderr = new Readable({ read: noopRead });
      child.stdin = new Writable({
        write(_chunk, _enc, cb) {
          cb();
        }
      });
      child.kill = (sig?: string) => {
        observedSignals.push(sig ?? "SIGTERM");
        // Only SIGKILL produces a close — SIGTERM is silently dropped.
        if (sig === "SIGKILL") {
          setImmediate(() => child.emit("close", -1));
        }
      };
      // Push nothing on stdout/stderr; never exits on its own.
      setImmediate(() => {
        child.stdout.push(null);
        child.stderr.push(null);
      });
      return child;
    }
    const codexBackend = createCodexBackend({
      spawn,
      idleTimeoutMs: 30,
      hardTimeoutMs: 60,
      sigkillGraceMs: 0
    });
    const proxy = createProxyServer({ codexBackend });
    const port = await proxy.listen(0);
    try {
      const { text } = await postJson(port, "/codex/api/chat", {
        messages: [{ role: "user", content: "stuck" }],
        stream: true
      });
      const lines = ndjsonLines(text) as {
        done: boolean;
        done_reason?: string;
      }[];
      const terminal = lines.find((l) => l.done);
      expect(terminal?.done_reason).toBe("timeout");
      // Both signals were attempted in order.
      expect(observedSignals[0]).toBe("SIGTERM");
      expect(observedSignals).toContain("SIGKILL");
    } finally {
      await proxy.close();
    }
  });

  it("idle/hard timeout kills child and surfaces a timeout terminal chunk", async () => {
    const { spawn } = makeSpawnRecorder([
      {
        stdoutLines: [],
        // Never exits on its own → forces hard timeout. The fake child's
        // kill() emits close, so the backend can finish.
        closeDelayMs: 30_000,
        exitCode: -1
      }
    ]);
    const codexBackend = createCodexBackend({
      spawn,
      idleTimeoutMs: 50,
      hardTimeoutMs: 75
    });
    const proxy = createProxyServer({ codexBackend });
    const port = await proxy.listen(0);
    try {
      const { text } = await postJson(port, "/codex/api/chat", {
        messages: [{ role: "user", content: "slow" }],
        stream: true
      });
      const lines = ndjsonLines(text) as {
        done: boolean;
        done_reason?: string;
        error?: string;
      }[];
      const terminal = lines.find((l) => l.done);
      expect(terminal?.done_reason).toBe("timeout");
    } finally {
      await proxy.close();
    }
  });

  it("threadId from `_meta.threadId` on a codex/event notification is captured for resume", async () => {
    // The MCP-server protocol carries the threadId in two places: the
    // structuredContent of the tools/call response AND every
    // notification's `params._meta.threadId`. The proxy must recognise
    // either so multi-turn explain doesn't keep spawning fresh codex
    // sessions (which re-narrate their own onboarding instead of
    // continuing the conversation).
    const recorder = makeSpawnRecorder([
      {
        stdoutLines: [
          JSON.stringify({
            jsonrpc: "2.0",
            method: "codex/event",
            params: {
              _meta: { requestId: 1, threadId: "019e3ea7-thread-uuid" },
              msg: {
                type: "session_configured",
                session_id: "019e3ea7-thread-uuid",
                thread_id: "019e3ea7-thread-uuid"
              }
            }
          }),
          mcpDelta("first")
          // Intentionally omit the tools/call response so the test
          // exercises the per-notification _meta walker, not the
          // structuredContent path.
        ]
      },
      {
        stdoutLines: [
          mcpFraming({ type: "session_configured", session_id: "019e3ea7-thread-uuid" }),
          mcpDelta("second"),
          mcpToolCallResponse("019e3ea7-thread-uuid")
        ]
      }
    ]);
    const codexBackend = createCodexBackend({ spawn: recorder.spawn });
    await codexBackend.runTurn({
      messages: [{ role: "user", content: "explain mitochondria" }],
      onEvent: () => undefined
    });
    expect(codexBackend._sessionMap.size).toBe(1);
    await codexBackend.runTurn({
      messages: [
        { role: "user", content: "explain mitochondria" },
        { role: "assistant", content: "first" },
        { role: "user", content: "follow-up" }
      ],
      onEvent: () => undefined
    });
    await new Promise((r) => setImmediate(r));
    expect(recorder.calls.length).toBe(2);
    const secondToolCall = (recorder.calls[1]?.stdin ?? "")
      .split("\n")
      .filter((l) => l.length > 0)
      .map(
        (l) =>
          JSON.parse(l) as {
            method?: string;
            params?: { name?: string; arguments?: Record<string, unknown> };
          }
      )
      .find((m) => m.method === "tools/call");
    expect(secondToolCall?.params?.name).toBe("codex-reply");
    expect(secondToolCall?.params?.arguments?.threadId).toBe("019e3ea7-thread-uuid");
    // The follow-up stdin must carry ONLY the latest user message in
    // the tools/call arguments — codex's resume reloads the session
    // on its end.
    expect(secondToolCall?.params?.arguments?.prompt).toBe("follow-up");
  });

  it("threadId discovered in a nested msg.thread_id is captured for resume", async () => {
    const recorder = makeSpawnRecorder([
      {
        stdoutLines: [
          // Nested under `msg` (no _meta, no structuredContent).
          JSON.stringify({
            jsonrpc: "2.0",
            method: "codex/event",
            params: { msg: { type: "session_configured", thread_id: "nested-id" } }
          }),
          mcpDelta("ok")
        ]
      },
      {
        stdoutLines: [
          mcpFraming({ type: "session_configured", session_id: "nested-id" }),
          mcpDelta("two"),
          mcpToolCallResponse("nested-id")
        ]
      }
    ]);
    const codexBackend = createCodexBackend({ spawn: recorder.spawn });
    const drainedFirst: unknown[] = [];
    const drainedSecond: unknown[] = [];
    await codexBackend.runTurn({
      messages: [{ role: "user", content: "first" }],
      onEvent: (c) => drainedFirst.push(c)
    });
    expect(drainedFirst.length).toBeGreaterThan(0);
    expect(codexBackend._sessionMap.size).toBe(1);
    await codexBackend.runTurn({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "again" }
      ],
      onEvent: (c) => drainedSecond.push(c)
    });
    expect(drainedSecond.length).toBeGreaterThan(0);
    await new Promise((r) => setImmediate(r));
    const secondToolCall = (recorder.calls[1]?.stdin ?? "")
      .split("\n")
      .filter((l) => l.length > 0)
      .map(
        (l) =>
          JSON.parse(l) as {
            method?: string;
            params?: { name?: string; arguments?: Record<string, unknown> };
          }
      )
      .find((m) => m.method === "tools/call");
    expect(secondToolCall?.params?.name).toBe("codex-reply");
    expect(secondToolCall?.params?.arguments?.threadId).toBe("nested-id");
  });

  it("extractDeltaText: codex/event agent_message_content_delta surfaces the delta string", () => {
    expect(
      extractDeltaText({
        method: "codex/event",
        params: { msg: { type: "agent_message_content_delta", delta: "hi" } }
      })
    ).toBe("hi");
    // The same shape with metadata still resolves.
    expect(
      extractDeltaText({
        jsonrpc: "2.0",
        method: "codex/event",
        params: {
          _meta: { requestId: 1, threadId: "abc" },
          msg: { type: "agent_message_content_delta", item_id: "msg_0", delta: "world" }
        }
      })
    ).toBe("world");
    // A delta msg with an EMPTY string must not return the string.
    expect(
      extractDeltaText({
        method: "codex/event",
        params: { msg: { type: "agent_message_content_delta", delta: "" } }
      })
    ).toBeNull();
    // Non-codex/event events fall through to the legacy branches.
    expect(extractDeltaText(null)).toBeNull();
  });

  it("extractDeltaText denies the three MCP terminal envelopes to prevent duplicate emission", () => {
    // After streaming `agent_message_content_delta` chunks, codex
    // mcp-server emits THREE more `codex/event` notifications carrying
    // the full assembled response: `item_completed AgentMessage`,
    // `raw_response_item`, and `agent_message`. Surfacing any of them
    // would echo the final answer two or three times into the popup.
    expect(
      extractDeltaText({
        method: "codex/event",
        params: {
          msg: {
            type: "item_completed",
            item: { type: "AgentMessage", content: [{ type: "Text", text: "x" }] }
          }
        }
      })
    ).toBeNull();
    expect(
      extractDeltaText({
        method: "codex/event",
        params: {
          msg: {
            type: "raw_response_item",
            item: { type: "message", content: [{ type: "output_text", text: "leak" }] }
          }
        }
      })
    ).toBeNull();
    expect(
      extractDeltaText({
        method: "codex/event",
        params: { msg: { type: "agent_message", message: "leak" } }
      })
    ).toBeNull();
    expect(
      extractDeltaText({
        method: "codex/event",
        params: {
          msg: { type: "AgentMessage", content: [{ type: "Text", text: "leak" }] }
        }
      })
    ).toBeNull();
  });

  it("extractDeltaText denies MCP framing events (session_configured, task_*, mcp_startup_update, *Reasoning*, UserMessage)", () => {
    // These all arrive on the codex/event stream BEFORE / DURING the
    // turn and never carry assistant text. The denylist gates them so
    // a future codex release that adds a top-level `text` to one
    // doesn't accidentally bleed shell output into the popup.
    const denied = [
      "session_configured",
      "mcp_startup_update",
      "task_started",
      "task_complete",
      "item_started",
      "Reasoning",
      "UserMessage"
    ];
    for (const type of denied) {
      expect(
        extractDeltaText({
          method: "codex/event",
          params: { msg: { type, text: "<<<leak>>>", delta: "<<<leak>>>", message: "<<<leak>>>" } }
        })
      ).toBeNull();
    }
  });

  it("extractDeltaText still handles legacy item.completed / agent_message envelope", () => {
    // The integration test fake-codex (tests/integration/
    // codex-proxy-pipeline.test.ts) emits the pre-MCP `codex exec
    // --json` shape. Retaining the legacy branches lets the integration
    // test continue to exercise the extraction path.
    expect(
      extractDeltaText({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "hello world" }
      })
    ).toBe("hello world");
    // Same envelope nested under msg (forward-compat with future codex shapes).
    expect(
      extractDeltaText({
        msg: {
          type: "item.completed",
          item: { id: "item_2", type: "agent_message", text: "nested" }
        }
      })
    ).toBe("nested");
    // Speculative streaming variant.
    expect(
      extractDeltaText({
        type: "item.delta",
        item: { type: "agent_message", delta: "partial " }
      })
    ).toBe("partial ");
  });

  it("extractDeltaText must NOT surface command_execution / reasoning items as assistant text", () => {
    // Tool-call items carry their own `text` / `aggregated_output` fields.
    // Surfacing them would dump shell output (and potentially private file
    // contents) into the popup. Each non-agent_message item.type must
    // return null even when the inner item has text-like fields.
    expect(
      extractDeltaText({
        type: "item.completed",
        item: {
          id: "item_0",
          type: "command_execution",
          command: "/bin/zsh -lc 'ls'",
          aggregated_output: "should-not-leak",
          text: "should-not-leak-either",
          exit_code: 0,
          status: "completed"
        }
      })
    ).toBeNull();
    expect(
      extractDeltaText({
        type: "item.completed",
        item: { type: "reasoning", text: "internal cot" }
      })
    ).toBeNull();
    // The framing events that arrive before/after the agent message
    // similarly carry no assistant text and must produce no delta.
    expect(extractDeltaText({ type: "thread.started", thread_id: "x" })).toBeNull();
    expect(extractDeltaText({ type: "turn.started" })).toBeNull();
    expect(extractDeltaText({ type: "turn.completed", usage: { input_tokens: 1 } })).toBeNull();
  });

  it("extractDeltaText denylist gates the top-level delta / message / text branches", () => {
    // Codex review #2: an event whose `type` is internal but which also
    // carries a top-level `delta` / `message` / `text` field was leaking
    // tool output into the popup via the per-branch (not per-event)
    // denylist. Each branch must consult the centralised event-type
    // denylist before returning a fragment.
    expect(extractDeltaText({ type: "command_execution", delta: "<<<leak>>>" })).toBeNull();
    expect(extractDeltaText({ type: "command_execution", text: "<<<leak>>>" })).toBeNull();
    expect(extractDeltaText({ type: "command_execution", message: "<<<leak>>>" })).toBeNull();
    expect(extractDeltaText({ type: "system_message", text: "<<<leak>>>" })).toBeNull();
    expect(extractDeltaText({ type: "system_message", delta: "<<<leak>>>" })).toBeNull();
    expect(extractDeltaText({ type: "user_message", text: "<<<leak>>>" })).toBeNull();
    expect(extractDeltaText({ type: "reasoning", text: "<<<leak>>>" })).toBeNull();
    expect(extractDeltaText({ type: "reasoning", delta: "<<<leak>>>" })).toBeNull();
    // The denylist also applies nested under `msg` (forward-compat).
    expect(
      extractDeltaText({ msg: { type: "command_execution", delta: "<<<leak>>>" } })
    ).toBeNull();
    // Sanity: untyped events with content arrays still flow through the
    // legacy fallback so we don't break any pre-typed payload.
    expect(extractDeltaText({ content: [{ type: "text", text: "ok" }] })).toBe("ok");
  });

  it("extractDeltaText denylist matches PascalCase and snake_case interchangeably (normalization)", () => {
    // Codex has shipped at least two casings for the same logical event
    // (e.g. `agent_message` and `AgentMessage`, `reasoning` and
    // `Reasoning`, `user_message` and `UserMessage`). The denylist holds
    // one canonical snake_case entry per logical type; the comparison
    // site normalizes the incoming msg.type before lookup. Both casings
    // must therefore return null even when the event carries leak-shaped
    // top-level `text` / `delta` fields.
    for (const pair of [
      ["agent_message", "AgentMessage"],
      ["reasoning", "Reasoning"],
      ["user_message", "UserMessage"]
    ]) {
      for (const t of pair) {
        expect(extractDeltaText({ type: t, text: "<<<leak>>>" })).toBeNull();
        expect(extractDeltaText({ type: t, delta: "<<<leak>>>" })).toBeNull();
        expect(extractDeltaText({ type: t, message: "<<<leak>>>" })).toBeNull();
        // Same denial under the nested `msg` envelope.
        expect(extractDeltaText({ msg: { type: t, delta: "<<<leak>>>" } })).toBeNull();
      }
    }
  });

  it("end-to-end: codex MCP event stream → assistant text reaches the client without duplicates", async () => {
    const { spawn } = makeSpawnRecorder([
      {
        stdoutLines: [
          mcpFraming({ type: "session_configured", session_id: "thread-1", thread_id: "thread-1" }),
          mcpFraming({ type: "task_started", turn_id: "1" }),
          mcpDelta("hello"),
          mcpDelta(" world"),
          // Terminal envelopes — must NOT replay the text.
          JSON.stringify({
            jsonrpc: "2.0",
            method: "codex/event",
            params: {
              msg: {
                type: "item_completed",
                item: {
                  type: "AgentMessage",
                  content: [{ type: "Text", text: "hello world" }],
                  phase: "final_answer"
                }
              }
            }
          }),
          JSON.stringify({
            jsonrpc: "2.0",
            method: "codex/event",
            params: {
              msg: {
                type: "raw_response_item",
                item: { type: "message", content: [{ type: "output_text", text: "hello world" }] }
              }
            }
          }),
          mcpFraming({ type: "agent_message", message: "hello world" }),
          mcpToolCallResponse("thread-1")
        ]
      }
    ]);
    const codexBackend = createCodexBackend({ spawn });
    const proxy = createProxyServer({ codexBackend });
    const port = await proxy.listen(0);
    try {
      const { status, text } = await postJson(port, "/codex/api/chat", {
        model: "gpt-5.5",
        messages: [{ role: "user", content: "Reply with exactly: hello world" }],
        stream: true
      });
      expect(status).toBe(200);
      const lines = ndjsonLines(text) as {
        done: boolean;
        message?: { content: string };
        done_reason?: string;
      }[];
      const assembled = lines
        .filter((l) => !l.done)
        .map((l) => l.message?.content ?? "")
        .join("");
      // The deltas concatenate to the answer ONCE — terminal envelopes
      // must not replay it.
      expect(assembled).toBe("hello world");
      const terminal = lines.find((l) => l.done);
      expect(terminal?.done_reason).toBe("stop");
    } finally {
      await proxy.close();
    }
  });
});

describe("llm-proxy / ollama passthrough", () => {
  it("forwards POST /ollama/api/chat body verbatim and streams response", async () => {
    const seen: { url: string | null; init: RequestInit | null } = { url: null, init: null };
    const upstreamChunks = [
      `${JSON.stringify({ message: { content: "alpha" }, done: false })}\n`,
      `${JSON.stringify({ message: { content: "beta" }, done: true })}\n`
    ];
    const fakeFetch = (input: string, init?: RequestInit) => {
      seen.url = input;
      seen.init = init ?? null;
      const body = new ReadableStream({
        start(controller) {
          for (const chunk of upstreamChunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        }
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } })
      );
    };
    const ollamaBackend = createOllamaBackend({
      fetch: fakeFetch as unknown as typeof fetch,
      baseUrl: "http://upstream:9999"
    });
    const proxy = createProxyServer({ ollamaBackend });
    const port = await proxy.listen(0);
    try {
      const reqBody = { model: "gemma4:e2b", messages: [{ role: "user", content: "hi" }] };
      const { status, text } = await postJson(port, "/ollama/api/chat", reqBody);
      expect(status).toBe(200);
      expect(seen.url).toBe("http://upstream:9999/api/chat");
      const forwarded = seen.init?.body;
      const forwardedStr = typeof forwarded === "string" ? forwarded : "";
      expect(JSON.parse(forwardedStr)).toEqual(reqBody);
      const lines = ndjsonLines(text) as { message: { content: string }; done: boolean }[];
      expect(lines.map((l) => l.message.content).join("")).toBe("alphabeta");
      expect(lines[lines.length - 1]?.done).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it("ollama upstream fetch failure surfaces a terminal error chunk", async () => {
    const fakeFetch = () => Promise.reject(new Error("ECONNREFUSED"));
    const ollamaBackend = createOllamaBackend({
      fetch: fakeFetch as unknown as typeof fetch,
      baseUrl: "http://nope:1"
    });
    const proxy = createProxyServer({ ollamaBackend });
    const port = await proxy.listen(0);
    try {
      const { text } = await postJson(port, "/ollama/api/chat", {
        model: "x",
        messages: [{ role: "user", content: "hi" }]
      });
      const lines = ndjsonLines(text) as { done: boolean; error?: string }[];
      const terminal = lines.find((l) => l.done);
      expect(terminal?.error).toMatch(/Ollama unreachable/);
    } finally {
      await proxy.close();
    }
  });

  it("GET /ollama/api/tags forwards the upstream JSON response", async () => {
    const fakeFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ models: [{ name: "gemma4:e2b" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    const ollamaBackend = createOllamaBackend({
      fetch: fakeFetch as unknown as typeof fetch,
      baseUrl: "http://upstream:9999"
    });
    const proxy = createProxyServer({ ollamaBackend });
    const port = await proxy.listen(0);
    try {
      const { status, json } = await getJson(port, "/ollama/api/tags");
      expect(status).toBe(200);
      expect(json).toEqual({ models: [{ name: "gemma4:e2b" }] });
    } finally {
      await proxy.close();
    }
  });
});

describe("llm-proxy / tags + routing", () => {
  it("GET /codex/api/tags returns a non-empty list with required Ollama-tag fields", async () => {
    const codexBackend = createCodexBackend({
      spawn: () => {
        throw new Error("not called");
      }
    });
    const proxy = createProxyServer({ codexBackend });
    const port = await proxy.listen(0);
    try {
      const { status, json } = await getJson(port, "/codex/api/tags");
      expect(status).toBe(200);
      const models = (json as { models: { name: string }[] }).models;
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) {
        expect(typeof m.name).toBe("string");
        expect(m.name.length).toBeGreaterThan(0);
      }
    } finally {
      await proxy.close();
    }
  });

  it("GET /api/tags returns a union of codex + ollama models", async () => {
    const codexBackend = createCodexBackend({
      spawn: () => {
        throw new Error("not called");
      }
    });
    const fakeFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ models: [{ name: "llama3.1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    const ollamaBackend = createOllamaBackend({
      fetch: fakeFetch as unknown as typeof fetch,
      baseUrl: "http://upstream:9999"
    });
    const proxy = createProxyServer({ codexBackend, ollamaBackend });
    const port = await proxy.listen(0);
    try {
      const { json } = await getJson(port, "/api/tags");
      const names = (json as { models: { name: string }[] }).models.map((m) => m.name);
      expect(names).toContain("llama3.1");
      // codex defaults include gpt-5.2-codex
      expect(names.some((n) => n.includes("codex"))).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it("unknown route returns 404", async () => {
    const codexBackend = createCodexBackend({
      spawn: () => {
        throw new Error("not called");
      }
    });
    const proxy = createProxyServer({ codexBackend });
    const port = await proxy.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/no/such/route`);
      expect(res.status).toBe(404);
    } finally {
      await proxy.close();
    }
  });

  it("malformed JSON body returns 400", async () => {
    const codexBackend = createCodexBackend({
      spawn: () => {
        throw new Error("not called");
      }
    });
    const proxy = createProxyServer({ codexBackend });
    const port = await proxy.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/codex/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json"
      });
      expect(res.status).toBe(400);
    } finally {
      await proxy.close();
    }
  });

  it("codex backend tolerates non-JSON banner lines on stdout (emits them as deltas)", async () => {
    const { spawn } = makeSpawnRecorder([
      {
        stdoutLines: [
          "codex CLI v1.2.3 — connected as alice@example.com",
          mcpFraming({ type: "session_configured", session_id: "sess-banner" }),
          mcpDelta("OK"),
          mcpToolCallResponse("sess-banner")
        ]
      }
    ]);
    const codexBackend = createCodexBackend({ spawn });
    const proxy = createProxyServer({ codexBackend });
    const port = await proxy.listen(0);
    try {
      const { text } = await postJson(port, "/codex/api/chat", {
        messages: [{ role: "user", content: "hi" }],
        stream: true
      });
      const lines = ndjsonLines(text) as {
        done: boolean;
        message?: { content: string };
      }[];
      const assembled = lines
        .filter((l) => !l.done)
        .map((l) => l.message?.content ?? "")
        .join("");
      // Banner is surfaced (so users can see authentication-related messages)
      // and the actual delta follows.
      expect(assembled).toContain("codex CLI");
      expect(assembled).toContain("OK");
    } finally {
      await proxy.close();
    }
  });
});

describe("llm-proxy / lifecycle", () => {
  let openProxy: { close(): Promise<void> } | null = null;

  beforeEach(() => {
    openProxy = null;
  });

  afterEach(async () => {
    if (openProxy) await openProxy.close();
  });

  it("listen(0) binds to an ephemeral port and responds on /", async () => {
    const codexBackend = createCodexBackend({
      spawn: () => {
        throw new Error("not called");
      }
    });
    const proxy = createProxyServer({ codexBackend });
    openProxy = proxy;
    const port = await proxy.listen(0);
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${String(port)}/`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { routes: string[] };
    expect(json.routes.some((r) => r.includes("/codex/api/chat"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Claude Code CLI backend
// ---------------------------------------------------------------------------

describe("llm-proxy / claude backend", () => {
  it('first turn spawns `claude -p --output-format stream-json --verbose --include-partial-messages --allowedTools ""` and parses session_id', async () => {
    const recorder = makeSpawnRecorder([
      {
        stdoutLines: [
          JSON.stringify({
            type: "result",
            session_id: "11111111-2222-3333-4444-555555555555",
            result: "hello from claude"
          })
        ]
      }
    ]);
    const claudeBackend = createClaudeBackend({ spawn: recorder.spawn });
    const proxy = createProxyServer({ claudeBackend });
    const port = await proxy.listen(0);
    try {
      const { status, text } = await postJson(port, "/claude/api/chat", {
        messages: [{ role: "user", content: "say hi" }],
        stream: false
      });
      expect(status).toBe(200);
      const parsed = JSON.parse(text) as {
        message: { content: string };
        done: boolean;
        done_reason: string;
      };
      expect(parsed.message.content).toBe("hello from claude");
      expect(parsed.done).toBe(true);
      expect(parsed.done_reason).toBe("stop");
      // Wait one tick so the recorder captures the spawn call.
      await new Promise((r) => setImmediate(r));
      expect(recorder.calls.length).toBe(1);
      const args = recorder.calls[0]?.args ?? [];
      // Must use print mode and stream-json output. `--verbose` and
      // `--include-partial-messages` are mandatory for the per-token
      // content_block_delta frames that drive streaming. `--resume` must
      // NOT appear on the first turn (no session_id known yet).
      expect(args).toContain("-p");
      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--verbose");
      expect(args).toContain("--include-partial-messages");
      expect(args).not.toContain("--resume");
      // Session id captured for reuse.
      expect(claudeBackend._sessionMap.size).toBe(1);
      const stored = [...claudeBackend._sessionMap.values()][0];
      expect(stored).toBe("11111111-2222-3333-4444-555555555555");
    } finally {
      await proxy.close();
    }
  });

  it("streaming claude turn emits multiple done:false chunks for a multi-delta upstream", async () => {
    // Drive the backend with three content_block_delta frames and a
    // terminal `assistant` envelope; the proxy must surface ≥2
    // done:false chunks (not buffer all three deltas into one).
    function streamFrame(text: string): string {
      return JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text } }
      });
    }
    const { spawn } = makeSpawnRecorder([
      {
        stdoutLines: [
          JSON.stringify({ type: "system", subtype: "init", session_id: "sess-stream" }),
          streamFrame("alpha "),
          streamFrame("beta "),
          streamFrame("gamma"),
          // The final `assistant` envelope carries the full message; must
          // not double-emit. The `result` envelope in stream-json carries
          // usage metadata only.
          JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "text", text: "alpha beta gamma" }] }
          }),
          JSON.stringify({ type: "result", session_id: "sess-stream", usage: { output_tokens: 3 } })
        ]
      }
    ]);
    const claudeBackend = createClaudeBackend({ spawn });
    const proxy = createProxyServer({ claudeBackend });
    const port = await proxy.listen(0);
    try {
      const { status, text } = await postJson(port, "/claude/api/chat", {
        messages: [{ role: "user", content: "say something multi-token" }],
        stream: true
      });
      expect(status).toBe(200);
      const lines = ndjsonLines(text) as {
        done: boolean;
        message?: { content: string };
        done_reason?: string;
      }[];
      const partials = lines.filter((l) => !l.done);
      expect(partials.length).toBeGreaterThanOrEqual(2);
      const assembled = partials.map((p) => p.message?.content ?? "").join("");
      expect(assembled).toBe("alpha beta gamma");
      const terminal = lines.find((l) => l.done);
      expect(terminal?.done_reason).toBe("stop");
    } finally {
      await proxy.close();
    }
  });

  it("subsequent turn on the same conversation key spawns `claude --resume <id>`", async () => {
    const recorder = makeSpawnRecorder([
      {
        stdoutLines: [
          JSON.stringify({
            type: "result",
            session_id: "sess-claude-multi",
            result: "first"
          })
        ]
      },
      {
        stdoutLines: [
          JSON.stringify({
            type: "result",
            session_id: "sess-claude-multi",
            result: "second"
          })
        ]
      }
    ]);
    const claudeBackend = createClaudeBackend({ spawn: recorder.spawn });
    const proxy = createProxyServer({ claudeBackend });
    const port = await proxy.listen(0);
    try {
      const firstUserContent = "explain quantum tunnelling";
      // Turn 1.
      await postJson(port, "/claude/api/chat", {
        messages: [{ role: "user", content: firstUserContent }],
        stream: false
      });
      // Turn 2 with same first-user-message → resume.
      await postJson(port, "/claude/api/chat", {
        messages: [
          { role: "user", content: firstUserContent },
          { role: "assistant", content: "first" },
          { role: "user", content: "follow-up question" }
        ],
        stream: false
      });
      await new Promise((r) => setImmediate(r));
      expect(recorder.calls.length).toBe(2);
      const firstArgs = recorder.calls[0]?.args ?? [];
      const secondArgs = recorder.calls[1]?.args ?? [];
      expect(firstArgs).not.toContain("--resume");
      // --resume must be followed immediately by the session id.
      const resumeIdx = secondArgs.indexOf("--resume");
      expect(resumeIdx).toBeGreaterThanOrEqual(0);
      expect(secondArgs[resumeIdx + 1]).toBe("sess-claude-multi");
      // Stdin on the resume call must be the latest user message only.
      expect(recorder.calls[1]?.stdin).toBe("follow-up question");
      expect(recorder.calls[0]?.stdin).toBe(firstUserContent);
    } finally {
      await proxy.close();
    }
  });

  it("non-zero claude exit emits a terminal error chunk (BUG-AC8-1 contract, no silent stop)", async () => {
    const { spawn } = makeSpawnRecorder([
      {
        stdoutLines: [],
        stderr: "Error: not authenticated. Run `claude login`.",
        exitCode: 1
      }
    ]);
    const claudeBackend = createClaudeBackend({ spawn });
    const proxy = createProxyServer({ claudeBackend });
    const port = await proxy.listen(0);
    try {
      const { status, text } = await postJson(port, "/claude/api/chat", {
        messages: [{ role: "user", content: "anything" }],
        stream: true
      });
      expect(status).toBe(200);
      const lines = ndjsonLines(text) as {
        done: boolean;
        done_reason?: string;
        error?: string;
      }[];
      const terminal = lines.find((l) => l.done);
      expect(terminal).toBeDefined();
      expect(terminal?.done_reason).toBe("error");
      expect(terminal?.error).toMatch(/not authenticated/);
      // Must NOT silently complete with done_reason:"stop".
      const stopTerminal = lines.find((l) => l.done && l.done_reason === "stop");
      expect(stopTerminal).toBeUndefined();
    } finally {
      await proxy.close();
    }
  });

  it("non-JSON banner lines on stdout surface as raw text deltas", async () => {
    const { spawn } = makeSpawnRecorder([
      {
        stdoutLines: [
          "claude CLI v1.0.42 — logged in as alice@example.com",
          JSON.stringify({ type: "result", session_id: "sess-banner", result: "OK" })
        ]
      }
    ]);
    const claudeBackend = createClaudeBackend({ spawn });
    const proxy = createProxyServer({ claudeBackend });
    const port = await proxy.listen(0);
    try {
      const { text } = await postJson(port, "/claude/api/chat", {
        messages: [{ role: "user", content: "hi" }],
        stream: true
      });
      const lines = ndjsonLines(text) as {
        done: boolean;
        message?: { content: string };
      }[];
      const assembled = lines
        .filter((l) => !l.done)
        .map((l) => l.message?.content ?? "")
        .join("");
      expect(assembled).toContain("claude CLI");
      expect(assembled).toContain("OK");
    } finally {
      await proxy.close();
    }
  });

  it("M8 (claude): SIGTERM grace then SIGKILL escalation when child ignores SIGTERM", async () => {
    const observedSignals: string[] = [];
    function spawn(): unknown {
      const child = new EventEmitter() as EventEmitter & {
        stdout: Readable;
        stderr: Readable;
        stdin: Writable;
        kill: (sig?: string) => void;
      };
      const noopRead = (): void => undefined;
      child.stdout = new Readable({ read: noopRead });
      child.stderr = new Readable({ read: noopRead });
      child.stdin = new Writable({
        write(_chunk, _enc, cb) {
          cb();
        }
      });
      child.kill = (sig?: string) => {
        observedSignals.push(sig ?? "SIGTERM");
        if (sig === "SIGKILL") {
          setImmediate(() => child.emit("close", -1));
        }
      };
      setImmediate(() => {
        child.stdout.push(null);
        child.stderr.push(null);
      });
      return child;
    }
    const claudeBackend = createClaudeBackend({
      spawn,
      idleTimeoutMs: 30,
      hardTimeoutMs: 60,
      sigkillGraceMs: 0
    });
    const proxy = createProxyServer({ claudeBackend });
    const port = await proxy.listen(0);
    try {
      const { text } = await postJson(port, "/claude/api/chat", {
        messages: [{ role: "user", content: "stuck" }],
        stream: true
      });
      const lines = ndjsonLines(text) as {
        done: boolean;
        done_reason?: string;
      }[];
      const terminal = lines.find((l) => l.done);
      expect(terminal?.done_reason).toBe("timeout");
      expect(observedSignals[0]).toBe("SIGTERM");
      expect(observedSignals).toContain("SIGKILL");
    } finally {
      await proxy.close();
    }
  });

  it("idle timeout kills the child and surfaces a timeout terminal chunk", async () => {
    const { spawn } = makeSpawnRecorder([
      {
        stdoutLines: [],
        closeDelayMs: 30_000,
        exitCode: -1
      }
    ]);
    const claudeBackend = createClaudeBackend({
      spawn,
      idleTimeoutMs: 40,
      hardTimeoutMs: 10_000 // ensure idle fires first
    });
    const proxy = createProxyServer({ claudeBackend });
    const port = await proxy.listen(0);
    try {
      const { text } = await postJson(port, "/claude/api/chat", {
        messages: [{ role: "user", content: "slow" }],
        stream: true
      });
      const lines = ndjsonLines(text) as {
        done: boolean;
        done_reason?: string;
      }[];
      const terminal = lines.find((l) => l.done);
      expect(terminal?.done_reason).toBe("timeout");
    } finally {
      await proxy.close();
    }
  });

  it("hard timeout kills the child even when the child stays active", async () => {
    // Drip stdout activity faster than the idle timeout so only the hard
    // timeout can fire. Use a custom spawn that emits a heartbeat line every
    // 10ms until killed, with the script kept alive by closeDelayMs.
    const calls: SpawnCall[] = [];
    function spawn(cmd: string, args: readonly string[]): unknown {
      const { child, getStdin } = makeFakeChild({
        stdoutLines: [],
        closeDelayMs: 10_000,
        exitCode: -1
      });
      // Heartbeat: emit a token every 10ms so the idle clock keeps resetting.
      const heartbeat = setInterval(() => {
        try {
          child.stdout.push(`${JSON.stringify({ type: "ping" })}\n`);
        } catch {
          // closed
        }
      }, 10);
      const origKill = child.kill.bind(child);
      child.kill = (sig?: string) => {
        clearInterval(heartbeat);
        origKill(sig);
      };
      setImmediate(() => {
        calls.push({ cmd, args: [...args], stdin: getStdin() });
      });
      return child;
    }
    const claudeBackend = createClaudeBackend({
      spawn,
      idleTimeoutMs: 1_000, // never fires within the test window
      hardTimeoutMs: 80
    });
    const proxy = createProxyServer({ claudeBackend });
    const port = await proxy.listen(0);
    try {
      const { text } = await postJson(port, "/claude/api/chat", {
        messages: [{ role: "user", content: "keep talking" }],
        stream: true
      });
      const lines = ndjsonLines(text) as {
        done: boolean;
        done_reason?: string;
      }[];
      const terminal = lines.find((l) => l.done);
      expect(terminal?.done_reason).toBe("timeout");
    } finally {
      await proxy.close();
    }
  });

  it('--allowedTools "" appears in spawn argv (chat-only contract, no tool use)', async () => {
    const recorder = makeSpawnRecorder([
      {
        stdoutLines: [JSON.stringify({ type: "result", session_id: "sess-tools", result: "ok" })]
      }
    ]);
    const claudeBackend = createClaudeBackend({ spawn: recorder.spawn });
    const proxy = createProxyServer({ claudeBackend });
    const port = await proxy.listen(0);
    try {
      await postJson(port, "/claude/api/chat", {
        messages: [{ role: "user", content: "anything" }],
        stream: false
      });
      await new Promise((r) => setImmediate(r));
      const args = recorder.calls[0]?.args ?? [];
      const idx = args.indexOf("--allowedTools");
      expect(idx).toBeGreaterThanOrEqual(0);
      // The empty-string allowlist disables ALL tools — must be the literal
      // arg right after the flag, not omitted.
      expect(args[idx + 1]).toBe("");
    } finally {
      await proxy.close();
    }

    // Pure-function check: buildClaudeArgs always emits the empty
    // allowlist AND the stream-json triple (--output-format stream-json,
    // --verbose, --include-partial-messages).
    const noSession = buildClaudeArgs({ sessionId: null });
    expect(noSession).toContain("--allowedTools");
    expect(noSession[noSession.indexOf("--allowedTools") + 1]).toBe("");
    expect(noSession).toContain("--output-format");
    expect(noSession[noSession.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(noSession).toContain("--verbose");
    expect(noSession).toContain("--include-partial-messages");
    const withSession = buildClaudeArgs({ sessionId: "abc", model: "opus" });
    expect(withSession[0]).toBe("--resume");
    expect(withSession[1]).toBe("abc");
    expect(withSession).toContain("--allowedTools");
    expect(withSession[withSession.indexOf("--allowedTools") + 1]).toBe("");
    expect(withSession).toContain("--output-format");
    expect(withSession[withSession.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(withSession).toContain("--verbose");
    expect(withSession).toContain("--include-partial-messages");
    expect(withSession).toContain("--model");
    expect(withSession[withSession.indexOf("--model") + 1]).toBe("opus");
  });

  it("nested session_id (e.g. in `meta` object) is discovered and reused for resume", async () => {
    const recorder = makeSpawnRecorder([
      {
        stdoutLines: [
          JSON.stringify({
            type: "result",
            meta: { session_id: "nested-claude-id" },
            result: "first"
          })
        ]
      },
      {
        stdoutLines: [
          JSON.stringify({
            type: "result",
            session_id: "nested-claude-id",
            result: "second"
          })
        ]
      }
    ]);
    const claudeBackend = createClaudeBackend({ spawn: recorder.spawn });
    const drainedFirst: unknown[] = [];
    const drainedSecond: unknown[] = [];
    await claudeBackend.runTurn({
      messages: [{ role: "user", content: "first" }],
      onEvent: (c) => drainedFirst.push(c)
    });
    expect(drainedFirst.length).toBeGreaterThan(0);
    expect(claudeBackend._sessionMap.size).toBe(1);
    await claudeBackend.runTurn({
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "first" },
        { role: "user", content: "again" }
      ],
      onEvent: (c) => drainedSecond.push(c)
    });
    expect(drainedSecond.length).toBeGreaterThan(0);
    await new Promise((r) => setImmediate(r));
    const secondArgs = recorder.calls[1]?.args ?? [];
    expect(secondArgs).toContain("--resume");
    expect(secondArgs).toContain("nested-claude-id");
  });

  it("extractDeltaText handles result, delta, content[].text shapes and ignores user_message", () => {
    expect(extractClaudeDeltaText({ type: "result", result: "hi" })).toBe("hi");
    expect(extractClaudeDeltaText({ type: "stream", delta: "tok" })).toBe("tok");
    expect(extractClaudeDeltaText({ text: "plain" })).toBe("plain");
    expect(
      extractClaudeDeltaText({
        message: { content: [{ type: "text", text: "abc" }] }
      })
    ).toBe("abc");
    expect(extractClaudeDeltaText({ content: [{ type: "text", text: "xyz" }] })).toBe("xyz");
    expect(extractClaudeDeltaText({ type: "user_message", text: "ignored" })).toBeNull();
    expect(extractClaudeDeltaText({ type: "user", result: "ignored" })).toBeNull();
    expect(extractClaudeDeltaText(null)).toBeNull();
  });

  it("extractDeltaText: stream_event → content_block_delta → text_delta surfaces the chunk", () => {
    expect(
      extractClaudeDeltaText({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hello" }
        }
      })
    ).toBe("hello");
    // A stream_event for a NON content_block_delta (e.g.
    // message_start, content_block_start) must not surface text.
    expect(
      extractClaudeDeltaText({
        type: "stream_event",
        event: { type: "message_start", message: { id: "msg_1" } }
      })
    ).toBeNull();
    // A content_block_delta whose delta type is NOT text_delta (e.g.
    // input_json_delta for tool input) must not surface text.
    expect(
      extractClaudeDeltaText({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: "{" }
        }
      })
    ).toBeNull();
  });

  it("extractDeltaText denies stream-json framing envelopes (system/result/rate_limit_event/assistant)", () => {
    // The `assistant` envelope arrives AFTER all content_block_delta
    // chunks carrying the full message; surfacing it would emit the
    // streamed text a second time into the popup.
    expect(
      extractClaudeDeltaText({
        type: "assistant",
        message: { content: [{ type: "text", text: "full reply" }] }
      })
    ).toBeNull();
    // Framing envelopes from --verbose stream-json carry usage /
    // metadata and never assistant text — must produce no delta even
    // if they incidentally have a `text` or `delta` field on them.
    expect(
      extractClaudeDeltaText({ type: "system", subtype: "init", text: "<<<leak>>>" })
    ).toBeNull();
    expect(extractClaudeDeltaText({ type: "rate_limit_event", text: "<<<leak>>>" })).toBeNull();
    // The `result` envelope in stream-json mode carries usage and
    // session metadata (no `result` string), distinct from the legacy
    // single-shot `{type:"result", result:"…"}` shape that fixtures
    // still rely on. The denylist gates it when no `result` string is
    // present.
    expect(extractClaudeDeltaText({ type: "result", usage: { input_tokens: 10 } })).toBeNull();
  });
});

describe("llm-proxy / claude routing", () => {
  it("GET /claude/api/tags returns a non-empty list with Ollama-tag fields", async () => {
    const claudeBackend = createClaudeBackend({
      spawn: () => {
        throw new Error("not called");
      }
    });
    const proxy = createProxyServer({ claudeBackend });
    const port = await proxy.listen(0);
    try {
      const { status, json } = await getJson(port, "/claude/api/tags");
      expect(status).toBe(200);
      const models = (json as { models: { name: string }[] }).models;
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) {
        expect(typeof m.name).toBe("string");
        expect(m.name.length).toBeGreaterThan(0);
      }
    } finally {
      await proxy.close();
    }
  });

  it("GET /api/tags union includes claude models alongside codex + ollama", async () => {
    const codexBackend = createCodexBackend({
      spawn: () => {
        throw new Error("not called");
      }
    });
    const claudeBackend = createClaudeBackend({
      spawn: () => {
        throw new Error("not called");
      }
    });
    const fakeFetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ models: [{ name: "llama3.1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    const ollamaBackend = createOllamaBackend({
      fetch: fakeFetch as unknown as typeof fetch,
      baseUrl: "http://upstream:9999"
    });
    const proxy = createProxyServer({ codexBackend, claudeBackend, ollamaBackend });
    const port = await proxy.listen(0);
    try {
      const { json } = await getJson(port, "/api/tags");
      const names = (json as { models: { name: string }[] }).models.map((m) => m.name);
      expect(names).toContain("llama3.1");
      expect(names.some((n) => n.includes("codex"))).toBe(true);
      expect(
        names.some((n) => n.includes("claude") || n.includes("opus") || n.includes("sonnet"))
      ).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it("unknown /claude/* route still returns 404", async () => {
    const claudeBackend = createClaudeBackend({
      spawn: () => {
        throw new Error("not called");
      }
    });
    const proxy = createProxyServer({ claudeBackend });
    const port = await proxy.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/claude/api/no-such-thing`);
      expect(res.status).toBe(404);
    } finally {
      await proxy.close();
    }
  });

  it("POST /claude/api/embed returns 501 (embeddings unsupported on chat-only backend)", async () => {
    const claudeBackend = createClaudeBackend({
      spawn: () => {
        throw new Error("not called");
      }
    });
    const proxy = createProxyServer({ claudeBackend });
    const port = await proxy.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/claude/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "hi" })
      });
      expect(res.status).toBe(501);
      const body = (await res.json()) as { error: string };
      expect(body.error.toLowerCase()).toContain("embed");
    } finally {
      await proxy.close();
    }
  });
});

/**
 * Bug B — codex backend live-config discovery.
 *
 * The backend MUST be able to:
 *   - parse the user's `~/.codex/config.toml` (`model = "..."`,
 *     `[tui.model_availability_nux]` keys, `[notice.model_migrations]`
 *     source keys), then merge with the builtin defaults.
 *   - skip discovery entirely when the consent env / force flag is
 *     absent (default behaviour — privacy by default).
 *   - silently degrade when the config is missing, malformed, or
 *     unreadable.
 */
describe("llm-proxy / codex backend live-config discovery (Bug B)", () => {
  const sampleToml = [
    "# user config",
    'model = "gpt-7-preview"',
    "",
    "[tui.model_availability_nux]",
    '"gpt-7-preview" = { tier = "experimental" }',
    'gpt-6-thinking = { tier = "stable" }',
    "",
    "[notice.model_migrations]",
    '"gpt-5.2" = "gpt-5.5"',
    '"gpt-4o" = "gpt-5.5-codex"',
    ""
  ].join("\n");

  it("parseCodexConfigTomlForModels extracts model, NUX table keys, and migration source keys", () => {
    const models = parseCodexConfigTomlForModels(sampleToml);
    // `model = "gpt-7-preview"` and the NUX entry refer to the same name,
    // so the first occurrence wins. The migration source keys + target
    // strings all appear.
    expect(models).toContain("gpt-7-preview");
    expect(models).toContain("gpt-6-thinking");
    expect(models).toContain("gpt-5.2");
    expect(models).toContain("gpt-5.5");
    expect(models).toContain("gpt-4o");
    expect(models).toContain("gpt-5.5-codex");
    // Dedup keeps each name exactly once.
    const counts = new Map<string, number>();
    for (const m of models) counts.set(m, (counts.get(m) ?? 0) + 1);
    for (const [, c] of counts) expect(c).toBe(1);
  });

  it("parseCodexConfigTomlForModels returns [] for empty or whitespace input", () => {
    expect(parseCodexConfigTomlForModels("")).toEqual([]);
    expect(parseCodexConfigTomlForModels("# comments only\n\n")).toEqual([]);
  });

  it("readDiscoveredCodexModels returns [] when the consent env is unset", () => {
    // Construct an environment where the env is explicitly absent.
    const previous = process.env.LLM_PROXY_CONFIG_READ;
    delete process.env.LLM_PROXY_CONFIG_READ;
    try {
      const result = readDiscoveredCodexModels({
        configPath: "/fake/.codex/config.toml",
        existsSync: () => true,
        readFileSync: () => sampleToml
      });
      expect(result).toEqual([]);
    } finally {
      if (previous !== undefined) process.env.LLM_PROXY_CONFIG_READ = previous;
    }
  });

  it("readDiscoveredCodexModels reads + parses when force=true is supplied", () => {
    const result = readDiscoveredCodexModels({
      configPath: "/fake/.codex/config.toml",
      existsSync: () => true,
      readFileSync: () => sampleToml,
      force: true
    });
    expect(result).toContain("gpt-7-preview");
    expect(result).toContain("gpt-6-thinking");
  });

  it("readDiscoveredCodexModels returns [] when the config file does not exist", () => {
    const result = readDiscoveredCodexModels({
      configPath: "/fake/.codex/config.toml",
      existsSync: () => false,
      readFileSync: () => {
        throw new Error("ENOENT");
      },
      force: true
    });
    expect(result).toEqual([]);
  });

  it("backend tags() merges discovered + builtin defaults when forceConfigRead is true", () => {
    const codexBackend = createCodexBackend({
      spawn: () => {
        throw new Error("not called");
      },
      configPath: "/fake/.codex/config.toml",
      existsSync: () => true,
      readFileSync: () => sampleToml,
      forceConfigRead: true
    });
    const names = codexBackend.tags().map((t) => t.name);
    // Discovered name takes priority (first); a builtin still shows up.
    expect(names[0]).toBe("gpt-7-preview");
    expect(names).toContain("gpt-5.5");
    // Builtin defaults survive.
    expect(names.some((n) => n.includes("codex") || n.startsWith("o4"))).toBe(true);
  });

  it("backend tags() defaults remain the builtins when consent is denied", () => {
    const previous = process.env.LLM_PROXY_CONFIG_READ;
    delete process.env.LLM_PROXY_CONFIG_READ;
    try {
      const codexBackend = createCodexBackend({
        spawn: () => {
          throw new Error("not called");
        },
        configPath: "/fake/.codex/config.toml",
        existsSync: () => true,
        readFileSync: () => sampleToml
        // forceConfigRead omitted → behaves as production would
      });
      const names = codexBackend.tags().map((t) => t.name);
      expect(names).not.toContain("gpt-7-preview");
      // Builtins always present.
      expect(names.length).toBeGreaterThan(0);
    } finally {
      if (previous !== undefined) process.env.LLM_PROXY_CONFIG_READ = previous;
    }
  });
});

describe("llm-proxy / claude backend live-config discovery (Bug B)", () => {
  const settingsJson = JSON.stringify({
    model: "claude-opus-4-7",
    defaults: { model: "claude-sonnet-4-7" },
    models: ["claude-haiku-4-7", { id: "claude-opus-4-8-preview" }]
  });

  it("extractModelsFromClaudeConfig walks model / models fields recursively", () => {
    const parsed: unknown = JSON.parse(settingsJson);
    const result = extractModelsFromClaudeConfig(parsed);
    expect(result).toContain("claude-opus-4-7");
    expect(result).toContain("claude-sonnet-4-7");
    expect(result).toContain("claude-haiku-4-7");
    expect(result).toContain("claude-opus-4-8-preview");
  });

  it("extractModelsFromClaudeConfig returns [] for non-object input", () => {
    expect(extractModelsFromClaudeConfig(null)).toEqual([]);
    expect(extractModelsFromClaudeConfig("string")).toEqual([]);
    expect(extractModelsFromClaudeConfig(42)).toEqual([]);
  });

  it("readDiscoveredClaudeModels returns [] when consent is absent", () => {
    const previous = process.env.LLM_PROXY_CONFIG_READ;
    delete process.env.LLM_PROXY_CONFIG_READ;
    try {
      const result = readDiscoveredClaudeModels({
        configPaths: ["/fake/.claude/settings.json"],
        existsSync: () => true,
        readFileSync: () => settingsJson
      });
      expect(result).toEqual([]);
    } finally {
      if (previous !== undefined) process.env.LLM_PROXY_CONFIG_READ = previous;
    }
  });

  it("readDiscoveredClaudeModels reads + parses when force=true", () => {
    const result = readDiscoveredClaudeModels({
      configPaths: ["/fake/.claude/settings.json"],
      existsSync: () => true,
      readFileSync: () => settingsJson,
      force: true
    });
    expect(result).toContain("claude-opus-4-7");
    expect(result).toContain("claude-haiku-4-7");
  });

  it("readDiscoveredClaudeModels skips malformed JSON without throwing", () => {
    const result = readDiscoveredClaudeModels({
      configPaths: ["/fake/.claude/settings.json"],
      existsSync: () => true,
      readFileSync: () => "{ not valid json",
      force: true
    });
    expect(result).toEqual([]);
  });

  it("AC-21: claude backend tags() puts discovered models first, BUILTIN fallback last", () => {
    // AC-21 trimmed BUILTIN_CLAUDE_TAGS from the speculative
    // opus/sonnet/haiku list down to a single conservative fallback.
    // Live discovery is the source of truth when consent is granted.
    const claudeBackend = createClaudeBackend({
      spawn: () => {
        throw new Error("not called");
      },
      configPaths: ["/fake/.claude/settings.json"],
      existsSync: () => true,
      readFileSync: () => settingsJson,
      forceConfigRead: true
    });
    const names = claudeBackend.tags().map((t) => t.name);
    expect(names[0]).toBe("claude-opus-4-7");
    expect(names).toContain("claude-opus-4-8-preview");
    // The single BUILTIN fallback is still in the merged tail.
    expect(names).toContain("claude-sonnet-4-7");
  });
});

/**
 * Bug B2 — surface ENOENT and other spawn failures with actionable
 * messages. The user-visible bug was "codex exited with code -1" with
 * no further information; the real cause on macOS is that the GUI-app
 * PATH doesn't include /opt/homebrew/bin so spawn('codex') fires the
 * `error` event with ENOENT before exec(). These helpers translate the
 * error into something the user can act on.
 */
describe("llm-proxy / describe*Failure (Bug B2)", () => {
  it("describeCodexFailure: ENOENT becomes an install / PROXY_CODEX_BIN message", () => {
    const detail = describeCodexFailure({
      spawnError: Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }),
      stderr: "",
      exitCode: -1,
      codexCommand: "codex"
    });
    expect(detail).toMatch(/codex CLI not found at "codex"/u);
    expect(detail).toMatch(/PROXY_CODEX_BIN/u);
    expect(detail).toMatch(/brew install|npm i -g/u);
  });

  it("describeCodexFailure: EACCES becomes a chmod hint with the resolved path", () => {
    const detail = describeCodexFailure({
      spawnError: Object.assign(new Error("permission denied"), { code: "EACCES" }),
      stderr: "",
      exitCode: -1,
      codexCommand: "/opt/homebrew/bin/codex"
    });
    expect(detail).toContain("/opt/homebrew/bin/codex");
    expect(detail).toMatch(/EACCES|not executable/u);
    expect(detail).toMatch(/chmod \+x \/opt\/homebrew\/bin\/codex/u);
  });

  it("describeCodexFailure: unknown spawn error surfaces the OS code + message verbatim", () => {
    const detail = describeCodexFailure({
      spawnError: Object.assign(new Error("Operation not permitted"), { code: "EPERM" }),
      stderr: "",
      exitCode: -1,
      codexCommand: "codex"
    });
    expect(detail).toContain("EPERM");
    expect(detail).toContain("Operation not permitted");
  });

  it("describeCodexFailure: with stderr, returns the stderr tail (codex ran but errored)", () => {
    const detail = describeCodexFailure({
      spawnError: null,
      stderr: "Error: invalid API key",
      exitCode: 1,
      codexCommand: "/opt/homebrew/bin/codex"
    });
    expect(detail).toBe("Error: invalid API key");
  });

  it("describeCodexFailure: no spawn error AND no stderr → exit code with resolved command", () => {
    const detail = describeCodexFailure({
      spawnError: null,
      stderr: "",
      exitCode: 2,
      codexCommand: "/opt/homebrew/bin/codex"
    });
    expect(detail).toContain("exited with code 2");
    expect(detail).toContain("/opt/homebrew/bin/codex");
  });

  it("describeClaudeFailure: ENOENT message mentions PROXY_CLAUDE_BIN", () => {
    const detail = describeClaudeFailure({
      spawnError: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }),
      stderr: "",
      exitCode: -1,
      claudeCommand: "claude"
    });
    expect(detail).toMatch(/claude CLI not found/u);
    expect(detail).toMatch(/PROXY_CLAUDE_BIN/u);
    expect(detail).toMatch(/@anthropic-ai\/claude-code/u);
  });
});

describe("llm-proxy / /api/diagnostics (Bug B2)", () => {
  // Smoke-test through the public createProxyServer entrypoint: the
  // route must return the binary lookup result + the PATH enrichment
  // diagnostic the plugin renders in the settings dialog.
  function makeStubBackends() {
    // The /api/diagnostics route only exercises listen()/close() and
    // the route handler — never the backends — so the stubs only need
    // to type-check, not actually do anything.
    const codexStub = {
      tags: () => [],
      runTurn: () =>
        Promise.resolve({
          exitCode: 0,
          sessionId: null as string | null,
          fullText: ""
        }),
      _sessionMap: new Map<string, string>()
    };
    const claudeStub = {
      tags: () => [],
      runTurn: () =>
        Promise.resolve({
          exitCode: 0,
          sessionId: null as string | null,
          fullText: ""
        }),
      _sessionMap: new Map<string, string>()
    };
    return {
      codexBackend: codexStub,
      claudeBackend: claudeStub,
      ollamaBackend: { baseUrl: "" }
    };
  }

  it("reports the binary lookup and the enrichment summary (codex review #2: no full PATH leak)", async () => {
    const proxy = createProxyServer({
      ...makeStubBackends(),
      pathEnrichment: {
        source: "shell",
        added: ["/opt/homebrew/bin"],
        finalPath: "/usr/bin:/opt/homebrew/bin",
        shellUsed: "/bin/zsh"
      }
    });
    const port = await proxy.listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${String(port)}/api/diagnostics`);
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        binaries: {
          codex: { path: string | null; searchedCount?: number };
          claude: { path: string | null; searchedCount?: number };
        };
        path: {
          current?: string; // must NOT be present after trim
          enrichment: { source: string; shellUsed: string | null; addedCount: number } | null;
        };
      };
      expect(body.binaries.codex).toHaveProperty("path");
      expect(body.binaries.claude).toHaveProperty("path");
      expect(body.path).not.toHaveProperty("current");
      // No raw `searched` paths exposed — only a count when the binary
      // is missing. Found rows have only `path`.
      if (body.binaries.codex.path === null) {
        expect(typeof body.binaries.codex.searchedCount).toBe("number");
      }
      expect(body.path.enrichment).toEqual({
        source: "shell",
        shellUsed: "/bin/zsh",
        addedCount: 1
      });
    } finally {
      await proxy.close();
    }
  });

  it("returns enrichment=null when createProxyServer was constructed without a pathEnrichment value", async () => {
    const proxy = createProxyServer(makeStubBackends());
    const port = await proxy.listen(0);
    try {
      const r = await fetch(`http://127.0.0.1:${String(port)}/api/diagnostics`);
      const body = (await r.json()) as { path: { enrichment: unknown } };
      expect(body.path.enrichment).toBeNull();
    } finally {
      await proxy.close();
    }
  });
});
