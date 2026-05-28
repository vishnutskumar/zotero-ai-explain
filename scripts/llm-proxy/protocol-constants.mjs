/**
 * Shared protocol constants for the bundled llm-proxy.
 *
 * Single source of truth for string literals that appear on BOTH sides
 * of the parent/child boundary. Today only the auth-token env-var name
 * lives here (it's the rendezvous between `src/platform/wire-proxy-lifecycle.ts`
 * setting the child's environment and `scripts/llm-proxy/server.mjs`
 * reading it). A typo on either side would silently downgrade to
 * no-auth mode; centralizing the literal lets a round-trip test catch
 * a drift in either consumer.
 *
 * Keep this file dependency-free (built-ins only) — it ships inside
 * the XPI alongside server.mjs.
 */

/** Env-var name the proxy child reads to enable bearer-token auth. */
export const LLM_PROXY_AUTH_TOKEN_ENV = "LLM_PROXY_AUTH_TOKEN";

/** Env-var name the proxy child reads to override the per-request body cap. */
export const LLM_PROXY_MAX_BODY_BYTES_ENV = "LLM_PROXY_MAX_BODY_BYTES";
