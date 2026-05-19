export type FakeOllamaRequest = {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly bodyRaw: string;
  readonly bodyParsed: unknown;
  readonly receivedAt: number;
};

export type FakeOllamaChunk = {
  readonly message: { readonly content: string };
  readonly done: boolean;
};

export type FakeOllamaOptions = {
  readonly chatChunks?: readonly FakeOllamaChunk[];
  readonly chatChunkCount?: number;
  readonly firstChunkDelayMs?: number;
  readonly chunkDelayMs?: number;
  readonly errorResponse?: boolean;
};

export type FakeOllamaServer = {
  start(): Promise<string>;
  stop(): Promise<void>;
  setOptions(next: FakeOllamaOptions): void;
  readonly requests: readonly FakeOllamaRequest[];
  clearRequests(): void;
};

export function createFakeOllamaServer(options?: FakeOllamaOptions): FakeOllamaServer;
