export type OllamaForwardArgs = {
  readonly bodyRaw: string;
  readonly onChunk: (chunk: Buffer | string) => void;
  readonly onEnd: () => void;
  readonly onError: (err: Error) => void;
  readonly signal?: AbortSignal;
};

export type OllamaForwardResult = {
  readonly status: number;
  readonly ok: boolean;
};

export type OllamaTagsResponse = {
  readonly models?: ReadonlyArray<unknown>;
  readonly [key: string]: unknown;
};

export type OllamaBackend = {
  forwardChat(args: OllamaForwardArgs): Promise<OllamaForwardResult>;
  tags(): Promise<OllamaTagsResponse>;
  readonly baseUrl: string;
};

export type OllamaBackendDeps = {
  readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly baseUrl?: string;
};

export function createOllamaBackend(deps?: OllamaBackendDeps): OllamaBackend;

export const ollamaDefaults: {
  readonly baseUrl: string;
};
