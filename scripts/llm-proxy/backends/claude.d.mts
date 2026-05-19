export type ClaudeChatMessage = {
  readonly role: string;
  readonly content: string;
};

export type ClaudeNdjsonChunk = {
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

export type ClaudeTag = {
  readonly name: string;
  readonly model: string;
  readonly modified_at: string;
  readonly size: number;
};

export type ClaudeTurnResult = {
  readonly exitCode: number;
  readonly sessionId: string | null;
  readonly fullText: string;
  readonly createdAt?: string;
};

export type ClaudeBackend = {
  tags(): ClaudeTag[];
  runTurn(args: {
    readonly messages: ReadonlyArray<ClaudeChatMessage>;
    readonly model?: string;
    readonly onEvent: (chunk: ClaudeNdjsonChunk) => void;
    readonly signal?: AbortSignal;
  }): Promise<ClaudeTurnResult>;
  readonly _sessionMap: Map<string, string>;
};

export type ClaudeBackendDeps = {
  readonly spawn?: (cmd: string, args: readonly string[], opts?: object) => unknown;
  readonly claudeCommand?: string;
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
  /** Test override: candidate config paths to scan. */
  readonly configPaths?: readonly string[];
  /** Test override: sync exists check. */
  readonly existsSync?: (path: string) => boolean;
  /** Test override: sync file reader. */
  readonly readFileSync?: (path: string, encoding: string) => string;
  /** Test override: home directory used to build default candidates. */
  readonly home?: string;
  /** Test override: bypass the `LLM_PROXY_CONFIG_READ=allow` env gate. */
  readonly forceConfigRead?: boolean;
};

export function createClaudeBackend(deps?: ClaudeBackendDeps): ClaudeBackend;

export function extractDeltaText(event: unknown): string | null;
export function buildClaudeArgs(input: {
  readonly sessionId: string | null;
  readonly model?: string;
}): string[];

export function describeClaudeFailure(input: {
  readonly spawnError: NodeJS.ErrnoException | Error | null | undefined;
  readonly stderr: string;
  readonly exitCode: number;
  readonly claudeCommand: string;
}): string;

export function extractModelsFromClaudeConfig(value: unknown): string[];
export function readDiscoveredClaudeModels(opts?: {
  readonly configPaths?: readonly string[];
  readonly existsSync?: (path: string) => boolean;
  readonly readFileSync?: (path: string, encoding: string) => string;
  readonly home?: string;
  readonly force?: boolean;
}): string[];

export const claudeDefaults: {
  readonly model: string;
  readonly idleTimeoutMs: number;
  readonly hardTimeoutMs: number;
  readonly tags: readonly string[];
};
