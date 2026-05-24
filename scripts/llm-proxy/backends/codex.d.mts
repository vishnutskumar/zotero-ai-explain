export type CodexChatMessage = {
  readonly role: string;
  readonly content: string;
};

export type CodexNdjsonChunk = {
  readonly model: string;
  readonly created_at: string;
  readonly message?: {
    readonly role: "assistant";
    readonly content: string;
  };
  readonly done: boolean;
  readonly done_reason?: string;
  readonly error?: string;
};

export type CodexTag = {
  readonly name: string;
  readonly model: string;
  readonly modified_at: string;
  readonly size: number;
};

export type CodexTurnResult = {
  readonly exitCode: number;
  readonly sessionId: string | null;
  readonly fullText: string;
  readonly createdAt?: string;
};

export type CodexBackend = {
  tags(): CodexTag[];
  runTurn(args: {
    readonly messages: ReadonlyArray<CodexChatMessage>;
    readonly model?: string;
    readonly onEvent: (chunk: CodexNdjsonChunk) => void;
    readonly signal?: AbortSignal;
  }): Promise<CodexTurnResult>;
  readonly _sessionMap: Map<string, string>;
};

export type CodexBackendDeps = {
  readonly spawn?: (cmd: string, args: readonly string[], opts?: object) => unknown;
  readonly fs?: typeof import("node:fs").promises;
  readonly codexCommand?: string;
  readonly sessionsDir?: string;
  readonly defaultModel?: string;
  readonly idleTimeoutMs?: number;
  readonly hardTimeoutMs?: number;
  /**
   * Milliseconds to wait after SIGTERM before escalating to SIGKILL.
   * Defaults to 3000. Tests pass 0 so the escalation fires immediately.
   * Mirrors the grace used by src/platform/proxy-lifecycle.ts (M8 fix).
   */
  readonly sigkillGraceMs?: number;
  readonly now?: () => number;
  readonly sessionMap?: Map<string, string>;
  /** Test override: path to a fake `~/.codex/config.toml`. */
  readonly configPath?: string;
  /** Test override: injected sync exists check. */
  readonly existsSync?: (path: string) => boolean;
  /** Test override: injected sync file reader. */
  readonly readFileSync?: (path: string, encoding: string) => string;
  /** Test override: bypass the `LLM_PROXY_CONFIG_READ=allow` env gate. */
  readonly forceConfigRead?: boolean;
};

export function createCodexBackend(deps?: CodexBackendDeps): CodexBackend;

export function extractDeltaText(event: unknown): string | null;
export function buildCodexMcpArgs(input?: { readonly model?: string }): string[];

export function describeCodexFailure(input: {
  readonly spawnError: NodeJS.ErrnoException | Error | null | undefined;
  readonly stderr: string;
  readonly exitCode: number;
  readonly codexCommand: string;
}): string;

export function parseCodexConfigTomlForModels(text: string): string[];
export function readDiscoveredCodexModels(opts?: {
  readonly configPath?: string;
  readonly existsSync?: (path: string) => boolean;
  readonly readFileSync?: (path: string, encoding: string) => string;
  readonly force?: boolean;
}): string[];

export const codexDefaults: {
  readonly model: string;
  readonly idleTimeoutMs: number;
  readonly hardTimeoutMs: number;
  readonly tags: readonly string[];
};
