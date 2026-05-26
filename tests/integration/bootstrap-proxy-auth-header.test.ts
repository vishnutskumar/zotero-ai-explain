/**
 * Regression tests for `buildProxyAuthHeader` — the host/port match
 * policy the bootstrap `getProxyAuthHeader` closure delegates to.
 *
 * The original bug: a raw `startsWith("http://127.0.0.1:<port>")`
 * silently dropped the bearer header for the `http://localhost:<port>`
 * form the Codex Proxy / Claude Proxy presets ship. Both presets shipped
 * with `localhost`-form URLs; the proxy server's allowed-hosts Set
 * accepts both `127.0.0.1` AND `localhost`, but the plugin-side closure
 * accepted only the former, so every proxy-preset user saw a 401
 * ("missing bearer") on the very first Explain-with-AI call.
 *
 * These tests pin the new URL-parsed policy so the regression cannot
 * reappear: both hostname forms must produce a header, and every other
 * URL shape (different host, different port, malformed URL, missing
 * token) must yield undefined so the request stays unauthenticated
 * (which is what real-Ollama-daemon callers rely on).
 */

import { describe, expect, it } from "vitest";

import { buildProxyAuthHeader } from "../../src/bootstrap.js";

const PROXY_PORT = 11400;
const TOKEN = "test-uuid-aaaa-bbbb-cccc";

describe("buildProxyAuthHeader — host/port policy", () => {
  it("returns the bearer header for the 127.0.0.1 form at the proxy port", () => {
    const header = buildProxyAuthHeader({
      requestBaseUrl: "http://127.0.0.1:11400/codex",
      token: TOKEN,
      proxyPort: PROXY_PORT
    });
    expect(header).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("returns the bearer header for the localhost form at the proxy port (the regression fix)", () => {
    // This is the exact URL string the Codex Proxy preset writes —
    // before the fix this returned undefined and the user saw 401.
    const header = buildProxyAuthHeader({
      requestBaseUrl: "http://localhost:11400/codex",
      token: TOKEN,
      proxyPort: PROXY_PORT
    });
    expect(header).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("returns the bearer header for the Claude Proxy preset URL", () => {
    const header = buildProxyAuthHeader({
      requestBaseUrl: "http://localhost:11400/claude",
      token: TOKEN,
      proxyPort: PROXY_PORT
    });
    expect(header).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("returns the bearer header for a bare proxy URL with no path suffix", () => {
    const header = buildProxyAuthHeader({
      requestBaseUrl: "http://localhost:11400",
      token: TOKEN,
      proxyPort: PROXY_PORT
    });
    expect(header).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("returns undefined for a non-proxy host (real Ollama daemon)", () => {
    const header = buildProxyAuthHeader({
      requestBaseUrl: "http://other-host:11400/codex",
      token: TOKEN,
      proxyPort: PROXY_PORT
    });
    expect(header).toBeUndefined();
  });

  it("returns undefined when the port does not match the proxy's port", () => {
    // localhost is allowed, but 11434 is the canonical Ollama daemon
    // port — leaking the proxy bearer there would expose the token to
    // any local process listening on that port.
    const header = buildProxyAuthHeader({
      requestBaseUrl: "http://localhost:11434",
      token: TOKEN,
      proxyPort: PROXY_PORT
    });
    expect(header).toBeUndefined();
  });

  it("returns undefined for a malformed URL (parse failure)", () => {
    const header = buildProxyAuthHeader({
      requestBaseUrl: "not a real url",
      token: TOKEN,
      proxyPort: PROXY_PORT
    });
    expect(header).toBeUndefined();
  });

  it("returns undefined when the token is null (proxy not yet spawned or stopped)", () => {
    const header = buildProxyAuthHeader({
      requestBaseUrl: "http://localhost:11400/codex",
      token: null,
      proxyPort: PROXY_PORT
    });
    expect(header).toBeUndefined();
  });

  it("returns undefined for a remote API URL (OpenAI, Anthropic) at a different host", () => {
    // Belt-and-suspenders: a direct-API URL must NEVER get the proxy
    // bearer leaked into its headers.
    expect(
      buildProxyAuthHeader({
        requestBaseUrl: "https://api.openai.com/v1",
        token: TOKEN,
        proxyPort: PROXY_PORT
      })
    ).toBeUndefined();
    expect(
      buildProxyAuthHeader({
        requestBaseUrl: "https://api.anthropic.com/v1",
        token: TOKEN,
        proxyPort: PROXY_PORT
      })
    ).toBeUndefined();
  });

  it("tracks a port change when the proxy is rebound (snapshot.port semantics)", () => {
    // Simulate the user editing the proxy port in settings — the helper
    // resolves the port at call time, so the new port immediately
    // gates the bearer at the new host:port pair.
    const headerOldPort = buildProxyAuthHeader({
      requestBaseUrl: "http://localhost:11400/codex",
      token: TOKEN,
      proxyPort: 11500
    });
    expect(headerOldPort).toBeUndefined();
    const headerNewPort = buildProxyAuthHeader({
      requestBaseUrl: "http://localhost:11500/codex",
      token: TOKEN,
      proxyPort: 11500
    });
    expect(headerNewPort).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });
});
