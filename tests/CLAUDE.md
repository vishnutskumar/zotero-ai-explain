# Tests

Vitest test suite. Adversarial, black-box, source-public-interface only.

## Structure

```text
tests/
  addon/                # Tests that assert against the built bundle / addon assets
  conversation/         # Per-selection + library conversation store tests
  docs/                 # Docs-folder assertions
  e2e/                  # Real Zotero + fake-Ollama end-to-end suite (runs in CI)
  e2e-local/            # Real Zotero + real Ollama suite (auto-skips when Ollama is offline)
  fixtures/             # Test data (incl. sample.pdf for the real-PDF e2e harness)
  indexing/             # Library crawler, chunker, storage, search, controller tests
  integration/          # Cross-module integration (settings flow, library chat, proxy wiring)
  platform/             # Zotero adapter, e2e driver, proxy lifecycle, runtime tests
  preferences/          # Provider profiles, presets, model discovery, onboarding state
  providers/            # Chat + embed adapter tests
  scripts/              # Tests for scripts/ (llm-proxy server + backends)
  secrets/, selection/, ui/
```

## Categories

- **Unit + integration (`npm run test`)** — `tests/*.test.ts` other than `e2e/` and `e2e-local/`.
  Runs in CI on every commit. Fast (~3 s for ~600 tests).
- **Real-Zotero e2e (`npm run test:e2e`)** — `tests/e2e/`. Spawns a real Zotero binary against a
  fake Ollama HTTP server and the committed `tests/fixtures/sample.pdf`. Runs in CI on Linux under
  Xvfb and via the cross-platform release-gate workflow on macOS + Windows. See
  `tests/fixtures/README.md` for the sample PDF provenance.
- **Real-Ollama e2e (`npm run test:e2e:local`)** — `tests/e2e-local/`. Same harness as above but
  routes the plugin at a real Ollama daemon. **Auto-skips in CI** (no Ollama available); also
  auto-skips when the daemon is offline or the required models (`gemma4:e4b` / `embeddinggemma`)
  aren't pulled. Used as the final release smoke-test against a live model.
- **Version-guard + packaging tests** — `tests/addon/version-guards.test.ts` reads
  `addon/manifest.json` and `package.json` at test time and asserts both declare a string version of
  shape `/^\d+\.\d+\.\d+(?:-dev)?$/`, that the two values agree, and that the dev-suffix state is
  symmetric across both files (catches half-strip mistakes during release prep).
  `tests/scripts/package-xpi-local-build.test.mjs` spawns `node scripts/package-xpi.mjs` with
  `GITHUB_REF_NAME` scrubbed and asserts the local-build path reads the manifest version verbatim
  (including any `-dev` suffix), writes the dist XPI + latest-alias, and emits a matching
  `updates.json`. Skips on hosts without `zip`/`7z` on PATH.
- **LLM proxy tests (`tests/scripts/llm-proxy.test.ts`)** — full HTTP-surface coverage of the
  bundled `scripts/llm-proxy/` server. Mocks `spawn` and `fetch` so the suite never spawns real
  `codex` / `claude` or hits real Ollama. Includes the BUG-AC8-1 contract test that asserts errors
  surface as `done_reason: "error"` terminal chunks rather than silent empty completions, and the
  `auth + host + origin gate` block (A1–A12) covering bearer-token auth, Host/Origin gating, the 1
  MiB body cap, the `LLM_PROXY_AUTH_TOKEN` unset → no-auth-mode canary path, and the bearer
  carve-outs for `POST /api/shutdown` + `GET /`. The plugin-side bearer wiring is covered in
  `tests/providers/adapters/ollama.test.ts` (B1/B2: `getProxyAuthHeader` dep is honoured and
  omitted-dep stays backward-compatible) and `tests/platform/wire-proxy-lifecycle.test.ts` (C1–C6:
  per-spawn UUID rotation, parent/child env round-trip through the shared `LLM_PROXY_AUTH_TOKEN_ENV`
  constant, and `diagnosticsFetch` bearer).

## Extending

1. Write adversarial black-box tests against public interfaces.
2. Do not assert on private implementation details.
3. Cover provider failures, selection edge cases, conversation handoff, indexing pause/resume,
   provider switching, and per-(provider, model) index file naming.
4. Real-provider e2e tests go in `tests/e2e-local/` and must auto-skip when their dependency (Ollama
   daemon, network) is unavailable so contributors without the dependency installed never see false
   negatives.
5. Use the helpers in `tests/indexing/controller-test-helpers.ts` and `tests/indexing/contracts.ts`
   rather than re-deriving fixtures across the indexing test files.
