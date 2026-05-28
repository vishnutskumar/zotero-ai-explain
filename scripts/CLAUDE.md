# Scripts

Build, packaging, and runtime automation. Some scripts are invoked by npm scripts (`package.json`);
others are invoked by the plugin at runtime via the bundled subprocess controller.

## Structure

```text
scripts/
  package-xpi.mjs                 # Stage addon/ + bundled llm-proxy/ → zotero-ai-explain.xpi.
                                  # Local build (no tag arg, GITHUB_REF_NAME unset): reads manifest version
                                  # verbatim and cross-checks manifest == package.json. Dev branches
                                  # carry a clean semver one minor (or patch) ahead of the latest
                                  # release; the version-guards regex still tolerates a legacy
                                  # `-dev` suffix for backward compat.
                                  # Release-tag path (tag arg or GITHUB_REF_NAME set): routes through
                                  # validateReleaseVersions for strict clean-semver enforcement.
  list-xpi-contents.mjs           # Diagnostic: dump XPI manifest
  release-version.mjs             # Strict clean-semver parser used by the release-tag path of
                                  # package-xpi.mjs; rejects any non-clean-semver tag (including
                                  # legacy `-dev`-suffixed values) so release artifacts always
                                  # carry a clean MAJOR.MINOR.PATCH.
  precommit-checks.mjs, precommit-universal.mjs  # Pre-commit hook implementations
  sync-agents-from-claude.mjs     # Keep AGENTS.md mirrors in sync with CLAUDE.md
  llm-proxy/                      # Bundled Node HTTP service (see below)
    server.mjs, server.d.mts
    protocol-constants.mjs, protocol-constants.d.mts  # Shared env-var names (LLM_PROXY_AUTH_TOKEN_ENV, LLM_PROXY_MAX_BODY_BYTES_ENV) consumed by both server.mjs and src/platform/wire-proxy-lifecycle.ts
    path-discovery.mjs, path-discovery.d.mts          # Node binary auto-detect helper
    backends/
      codex.mjs, codex.d.mts      # codex mcp-server backend (tools/call codex / codex-reply); spawns in isolated $HOME / $CODEX_HOME tmpdir
      claude.mjs, claude.d.mts    # claude -p stream-json backend; --allowedTools "" + --setting-sources user + --strict-mcp-config + --disable-slash-commands + --system-prompt isolate from user config
      ollama.mjs, ollama.d.mts    # Passthrough to a real Ollama daemon
    README.md                     # Configuration, wire format, auth, smoke tests, troubleshooting
  zotero-e2e/                     # Real-Zotero spawn harness for tests/e2e/
    spawn.mjs, launch.mjs, launch.d.mts
    marionette.mjs, marionette-raw.mjs, marionette-smoke.mjs, marionette.d.mts
    fake-ollama-server.mjs        # In-process Ollama-compatible fixture
    fake-ollama-server.d.mts
    cleanup.mjs, dump-tokens.mjs
```

## The bundled `llm-proxy`

`scripts/llm-proxy/` is a self-contained Node HTTP service that the **plugin auto-spawns at
runtime** via Mozilla's `Subprocess.sys.mjs`. `scripts/package-xpi.mjs` copies the directory into
`addon/llm-proxy/` (excluding `README.md`) during XPI packaging and removes the staged copy in a
`finally` block. At install time, `addon/bootstrap.js` passes the plugin's `rootURI` into the bundle
scope; `src/bootstrap.ts` resolves the bundled `llm-proxy/server.mjs` from there.

For local development you can run the proxy directly out of the source tree:

```bash
npm run proxy:llm   # node scripts/llm-proxy/server.mjs
```

See `scripts/llm-proxy/README.md` for the full configuration / wire-format / troubleshooting
reference and `docs/decisions/0001-llm-proxy-architecture.md` for the design rationale.

## Extending

1. Prefer ESM (`.mjs`) for new scripts; add a sibling `.d.mts` when a script's exports are imported
   by TypeScript files (the llm-proxy uses this pattern so the Vitest suite in
   `tests/scripts/llm-proxy.test.ts` can `import` cleanly).
2. Keep packaging scripts deterministic and safe to run repeatedly. `package-xpi.mjs` is idempotent
   — the staged `addon/llm-proxy/` copy is removed in a `finally` block so a failed run does not
   pollute the source tree.
3. Add npm scripts in `package.json` for commands maintainers should run directly.
4. Scripts invoked at runtime by the plugin (today: only `llm-proxy/server.mjs`) MUST stay free of
   npm dependencies — they ship inside the XPI and run under whatever Node binary the user's system
   has. Pure Node built-ins only.
