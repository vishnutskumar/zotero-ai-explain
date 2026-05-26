/**
 * Model discovery — fetch the model list a backend exposes so the
 * settings dialog can render a dropdown of installed/available models
 * instead of requiring the user to remember exact names.
 *
 * Backends and endpoints:
 *
 *   - ollama   GET ${url}/api/tags                 → models[].name
 *   - openai   GET ${url}/models  (Bearer auth)    → data[].id
 *   - anthropic GET ${url}/models (x-api-key auth) → data[].id
 *   - gemini   GET ${url}/models?key=${apiKey}     → models[].name (strip "models/")
 *   - proxy    GET ${proxyUrl}/api/tags            → models[].name
 *
 * The plugin uses Ollama's wire format on the proxy routes (codex /
 * claude / ollama), so any URL pointing at the proxy uses the Ollama
 * discovery path regardless of which backend ultimately serves chat.
 *
 * All probes share a 1500ms timeout. Failures return `{ok: false,
 * message}` so the renderer can show a transient error and surface a
 * "Custom..." fallback instead of leaving the dropdown empty.
 */

export type DiscoveryFetch = (
  input: string,
  init?: { readonly signal?: AbortSignal; readonly headers?: Record<string, string> }
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

export type DiscoveryBackendKind = "ollama" | "proxy" | "openai" | "anthropic" | "gemini";

export type DiscoveryRequest = {
  /** Which API style to probe. */
  readonly backend: DiscoveryBackendKind;
  /**
   * Base URL for URL-based backends (ollama/proxy). Direct-API backends
   * use this as the OpenAI/Anthropic/Gemini root; the helper appends
   * the correct path for each style.
   */
  readonly url: string;
  /** API key (empty string == not yet set; the discovery call short-circuits). */
  readonly apiKey?: string;
  readonly fetch: DiscoveryFetch;
  /** Override the per-probe timeout. Tests pass 0 for synchronous. */
  readonly timeoutMs?: number;
  /**
   * Optional accessor for the bundled-proxy bearer header. When the URL
   * targets the local LLM proxy the closure returns an Authorization
   * header; for every other URL (real Ollama daemon, direct OpenAI/
   * Anthropic/Gemini) it returns undefined and the probe sends no bearer.
   * Without this, listing models against the proxy returns 401 because
   * the proxy enforces bearer auth on every route (`/api/tags` included).
   */
  readonly getProxyAuthHeader?: (baseUrl: string) => Record<string, string> | undefined;
};

export type DiscoveryResult =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly message: string };

const DEFAULT_TIMEOUT_MS = 1500;

/**
 * Parse the model list out of a payload. Each branch is duck-typed so
 * a partially-malformed response yields an empty list rather than
 * throwing.
 */
function parseOllamaModels(payload: unknown): readonly string[] {
  if (payload === null || typeof payload !== "object") return [];
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const out: string[] = [];
  for (const entry of models) {
    if (entry === null || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) out.push(name);
  }
  return out;
}

function parseOpenAIModels(payload: unknown): readonly string[] {
  if (payload === null || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const entry of data) {
    if (entry === null || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) out.push(id);
  }
  return out;
}

function parseGeminiModels(payload: unknown): readonly string[] {
  if (payload === null || typeof payload !== "object") return [];
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const out: string[] = [];
  for (const entry of models) {
    if (entry === null || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) {
      // Gemini returns "models/text-embedding-004" — strip the namespace
      // so the dropdown shows the bare identifier the user types
      // into the embedding-model field.
      out.push(name.startsWith("models/") ? name.substring("models/".length) : name);
    }
  }
  return out;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/u, "");
}

/**
 * Discover the model list for a given backend. Returns an array of
 * model identifiers on success, or `{ok: false, message}` on transport
 * failure / non-2xx response / missing API key.
 *
 * The proxy route is identical in payload shape to Ollama, so the same
 * parser handles both — the only difference is how the request is
 * formed (the proxy's `/api/tags` lives at the URL root, exactly like
 * Ollama).
 */
export async function discoverModels(request: DiscoveryRequest): Promise<DiscoveryResult> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const url = trimTrailingSlash(request.url);
    let fetchUrl: string;
    let headers: Record<string, string> | undefined;
    switch (request.backend) {
      case "ollama":
      case "proxy": {
        fetchUrl = `${url}/api/tags`;
        // Apply the bundled-proxy bearer when the URL targets the
        // local proxy. The closure self-gates on hostname/port, so a
        // real-Ollama-daemon URL (e.g. `http://localhost:11434`) gets
        // undefined and no Authorization is sent — the daemon would
        // otherwise reject an unexpected header on its open endpoint.
        // We pass `url` (the trimmed base) so the closure sees the
        // form it was wired for in the chat-adapter path.
        const proxyAuth = request.getProxyAuthHeader?.(url);
        if (proxyAuth !== undefined) {
          headers = proxyAuth;
        }
        break;
      }
      case "openai":
        if ((request.apiKey ?? "").length === 0) {
          return { ok: false, message: "API key required to list models." };
        }
        fetchUrl = `${url}/models`;
        headers = { Authorization: `Bearer ${request.apiKey ?? ""}` };
        break;
      case "anthropic":
        if ((request.apiKey ?? "").length === 0) {
          return { ok: false, message: "API key required to list models." };
        }
        fetchUrl = `${url}/models`;
        headers = {
          "x-api-key": request.apiKey ?? "",
          "anthropic-version": "2023-06-01"
        };
        break;
      case "gemini":
        if ((request.apiKey ?? "").length === 0) {
          return { ok: false, message: "API key required to list models." };
        }
        fetchUrl = `${url}/models?key=${encodeURIComponent(request.apiKey ?? "")}`;
        break;
    }
    const init: { signal: AbortSignal; headers?: Record<string, string> } = {
      signal: controller.signal,
      ...(headers !== undefined ? { headers } : {})
    };
    const response = await request.fetch(fetchUrl, init);
    if (!response.ok) {
      return {
        ok: false,
        message: `Server responded ${String(response.status)} listing models.`
      };
    }
    const payload: unknown = await response.json();
    let models: readonly string[];
    switch (request.backend) {
      case "ollama":
      case "proxy":
        models = parseOllamaModels(payload);
        break;
      case "openai":
      case "anthropic":
        models = parseOpenAIModels(payload);
        break;
      case "gemini":
        models = parseGeminiModels(payload);
        break;
    }
    // Deduplicate + sort for stable rendering. Ollama's `/api/tags`
    // returns models in insertion order; sorting is purely a UX choice.
    const dedup = Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
    return { ok: true, models: dedup };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Cannot reach ${request.url}: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Determine the discovery backend to use for a given chat provider.
 * Direct-API providers map straight to their canonical style; CLI
 * providers route through the proxy.
 */
export type ChatProviderKind = "ollama" | "codex-cli" | "claude-cli" | "codex-api" | "claude-api";
export type EmbedProviderKind = "ollama" | "openai" | "gemini";

export function backendForChatProvider(kind: ChatProviderKind): DiscoveryBackendKind {
  switch (kind) {
    case "ollama":
      return "ollama";
    case "codex-cli":
    case "claude-cli":
      return "proxy";
    case "codex-api":
      return "openai";
    case "claude-api":
      return "anthropic";
  }
}

export function backendForEmbedProvider(kind: EmbedProviderKind): DiscoveryBackendKind {
  switch (kind) {
    case "ollama":
      return "ollama";
    case "openai":
      return "openai";
    case "gemini":
      return "gemini";
  }
}
