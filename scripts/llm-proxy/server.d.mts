import type { ClaudeBackend } from "./backends/claude.d.mts";
import type { CodexBackend } from "./backends/codex.d.mts";
import type { OllamaBackend } from "./backends/ollama.d.mts";
import type { PathEnrichmentResult } from "./path-discovery.d.mts";

export type ProxyServerDeps = {
  // The shapes here are partial so tests can pass minimal stubs; the
  // server itself only invokes `tags()` / `runTurn()` / `forwardChat()`
  // on whatever's supplied and trusts the caller.
  readonly codexBackend?: Partial<CodexBackend> & {
    tags?: CodexBackend["tags"];
    runTurn?: CodexBackend["runTurn"];
  };
  readonly claudeBackend?: Partial<ClaudeBackend> & {
    tags?: ClaudeBackend["tags"];
    runTurn?: ClaudeBackend["runTurn"];
  };
  readonly ollamaBackend?: Partial<OllamaBackend> & { baseUrl?: string };
  /**
   * Optional pre-computed PATH enrichment result. When present, the
   * `/api/diagnostics` route reports it back to the plugin so the
   * settings dialog can render "PATH inherited from /bin/zsh".
   */
  readonly pathEnrichment?: PathEnrichmentResult;
};

export type ProxyServer = {
  readonly server: import("node:http").Server;
  readonly codexBackend: CodexBackend;
  readonly claudeBackend: ClaudeBackend;
  readonly ollamaBackend: OllamaBackend;
  listen(port: number): Promise<number>;
  close(): Promise<void>;
};

export function createProxyServer(deps?: ProxyServerDeps): ProxyServer;
