/**
 * Passthrough backend that forwards Ollama-compatible requests to a real
 * Ollama daemon (default http://localhost:11434).
 */

const DEFAULT_BASE_URL = "http://localhost:11434";

function normalizeBaseUrl(url) {
  return (url || DEFAULT_BASE_URL).replace(/\/+$/u, "");
}

export function createOllamaBackend(deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const baseUrl = normalizeBaseUrl(deps.baseUrl);

  if (typeof fetchImpl !== "function") {
    throw new Error("createOllamaBackend: no fetch implementation available");
  }

  /**
   * Forward a chat request and stream the response body back via `onChunk`.
   *
   * @param {object} args
   * @param {string} args.bodyRaw   raw NDJSON-friendly request body to forward
   * @param {(chunk: Buffer|string) => void} args.onChunk
   * @param {() => void} args.onEnd
   * @param {(err: Error) => void} args.onError
   * @param {AbortSignal} [args.signal]
   */
  async function forwardChat(args) {
    const url = `${baseUrl}/api/chat`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: args.bodyRaw,
        signal: args.signal
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Emit an Ollama-format terminal error chunk so the plugin sees a parsable
      // line instead of an HTTP-layer error mid-stream.
      const created = new Date().toISOString();
      args.onChunk(
        `${JSON.stringify({
          model: "",
          created_at: created,
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: "error",
          error: `Ollama unreachable at ${baseUrl}: ${message}`
        })}\n`
      );
      args.onEnd();
      return { status: 502, ok: false };
    }

    if (!response.body) {
      // Some fetch polyfills return undefined body on error responses — read
      // the text and emit it as one error chunk.
      const text = await response.text().catch(() => "");
      args.onChunk(
        `${JSON.stringify({
          model: "",
          created_at: new Date().toISOString(),
          message: { role: "assistant", content: "" },
          done: true,
          done_reason: response.ok ? "stop" : "error",
          error: response.ok ? undefined : text || `HTTP ${String(response.status)}`
        })}\n`
      );
      args.onEnd();
      return { status: response.status, ok: response.ok };
    }

    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) args.onChunk(Buffer.from(value));
      }
    } catch (err) {
      args.onError(err instanceof Error ? err : new Error(String(err)));
      return { status: response.status, ok: false };
    }
    args.onEnd();
    return { status: response.status, ok: response.ok };
  }

  async function tags() {
    const url = `${baseUrl}/api/tags`;
    try {
      const response = await fetchImpl(url, { method: "GET" });
      if (!response.ok) {
        return { models: [] };
      }
      const json = await response.json();
      if (json && typeof json === "object") return json;
      return { models: [] };
    } catch {
      return { models: [] };
    }
  }

  return {
    forwardChat,
    tags,
    get baseUrl() {
      return baseUrl;
    }
  };
}

export const ollamaDefaults = {
  baseUrl: DEFAULT_BASE_URL
};
