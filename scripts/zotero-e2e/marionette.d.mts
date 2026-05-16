export class MarionetteError extends Error {
  readonly payload: unknown;
  constructor(message: string, payload: unknown);
}

export class MarionetteClient {
  constructor();
  connect(host: string, port: number, options?: { timeoutMs?: number }): Promise<unknown>;
  newSession(capabilities?: Record<string, unknown>): Promise<unknown>;
  deleteSession(): Promise<unknown>;
  setContext(context: "chrome" | "content"): Promise<unknown>;
  executeAsyncScript(script: string, args?: unknown[]): Promise<unknown>;
  executeScript(script: string, args?: unknown[]): Promise<unknown>;
  send(command: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export function withMarionetteSession<T>(
  host: string,
  port: number,
  fn: (client: MarionetteClient) => Promise<T>,
  options?: { timeoutMs?: number }
): Promise<T>;
