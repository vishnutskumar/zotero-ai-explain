# ADR 0004 — Bootstrap chrome subprocess

- **Status:** Accepted
- **Date:** 2026-05-17
- **Phase:** real-product-pipeline (Phase 4)

## Context

The LLM proxy (ADR 0001) is a Node HTTP service. For development the user runs it manually with
`npm run proxy:llm`, but the shipped product must be one install action: install the XPI, open
settings, pick a proxy-using preset, click Start. That requires the plugin to (1) locate the bundled
server script from inside the installed XPI, (2) locate a Node binary on the user's system, (3)
spawn the child from chrome-privileged code, (4) signal it on plugin shutdown, and (5) survive
plugin reload without leaving zombies.

Zotero plugins have full Firefox chrome privileges, which gives access to
`resource://gre/modules/Subprocess.sys.mjs` — Mozilla's blessed cross-platform subprocess API.

## Decision

Use chrome `Subprocess.sys.mjs` for the lifecycle, with a narrow `SubprocessLike` seam so unit tests
can use a fake without a chrome environment.

- **Bundling.** `scripts/package-xpi.mjs` stages `scripts/llm-proxy/` into `addon/llm-proxy/`
  (excluding `README.md`) at packaging time, zips, and removes the staged copy in a `finally`.
- **Path resolution.** `addon/bootstrap.js` passes `data.rootURI` (a `file://` URL) into the
  bundle's `startup()`. `src/bootstrap.ts` `resolveBundledServerScriptPath(rootURI)` decodes and
  appends `llm-proxy/server.mjs`; a developer-checkout fallback handles undefined/`jar:` URLs.
- **Node binary discovery.** `wire-proxy-lifecycle.ts` `detectNodeBinaryWithStatus(deps)` cascades:
  `whichRunner("node")`, then a candidate list with `/opt/homebrew/bin/node` first (Apple Silicon
  default), then bare `node` with `autoDetectFailed=true`. The settings dialog reveals a Node binary
  override field only when auto-detection failed.
- **Spawn.** `src/bootstrap.ts` `createSubprocessAdapter(zotero)` imports `Subprocess.sys.mjs` via
  `ChromeUtils.importESModule` and wraps it as a `SubprocessLike`
  (`call → {pid, wait(), kill(signal?)}`). On import failure (jsdom, tests, non-chrome) the helper
  returns null and the proxy section of the dialog is omitted cleanly.
  `src/platform/proxy-lifecycle.ts` is the headless controller owning the one in-flight child + the
  wait() promise + the SIGTERM-then-SIGKILL stop flow (3 s grace).
- **Shutdown.** `src/bootstrap.ts` shuts down the proxy **before** the runtime teardown — the
  integration test `tests/integration/bootstrap-proxy-wiring.test.ts` asserts the ordering.

## Consequences

- **One install action.** Fully self-contained for users with Node installed.
- **Node remains a runtime dependency.** Users without Node see the "Node not found" banner with
  copy-paste instructions. Bundling Node was rejected (XPI size, license, per-platform binaries).
- **Cross-platform via Mozilla.** `Subprocess.sys.mjs` handles macOS/Linux/Windows differences. The
  cross-platform CI matrix validates this on all three OS targets per release.
- **Testable.** Every subprocess call goes through `SubprocessLike`, so the Vitest integration suite
  exercises the full lifecycle with a recording fake.
- **Clean teardown.** SIGTERM with SIGKILL escape; no zombies survive plugin reload.
- **`isRunning()` means "responding to traffic".** A 500 ms GET `/api/tags` probe rather than a
  process-table check — the right answer for a UI deciding whether the user can route requests.

## Alternatives considered

- **Run from the user's terminal.** Pre-Phase-4 development mode. Hostile for the shipped product.
- **Bundle Node binaries in the XPI.** ~40 MB per platform, per-OS XPIs, CVE tracking burden.
- **Native MCP server in the plugin bundle (no subprocess).** Re-implement codex/claude/ollama
  backends in TypeScript without subprocess primitives. ADR 0001 covers why a sibling process is
  preferable.
- **Lazy-spawn on first request.** First request would block on ~500 ms spawn + readiness probe;
  explicit Start gives the user agency over when the resource is held.
