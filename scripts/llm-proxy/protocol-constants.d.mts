/**
 * Declaration sidecar for protocol-constants.mjs so TypeScript callers
 * (today: src/platform/wire-proxy-lifecycle.ts and the Vitest suites)
 * can import the shared env-var names under NodeNext module resolution.
 */
export const LLM_PROXY_AUTH_TOKEN_ENV: "LLM_PROXY_AUTH_TOKEN";
export const LLM_PROXY_MAX_BODY_BYTES_ENV: "LLM_PROXY_MAX_BODY_BYTES";
