import type { ChatRequest, ProviderProfile } from "../../../src/providers/provider-types.js";

export const testProfile = (
  kind: ProviderProfile["kind"],
  baseUrl: string | null = "http://localhost:11434"
): ProviderProfile => ({
  id: kind,
  displayName: kind,
  kind,
  baseUrl,
  model: "test-model",
  secret: { kind: "none" },
  sendMode: baseUrl?.startsWith("http://localhost") === true ? "local" : "remote",
  enabled: true
});

export const testRequest = (
  kind: ProviderProfile["kind"],
  baseUrl: string | null = "http://localhost:11434"
): ChatRequest => ({
  selection: {
    quote: "Quote",
    source: {
      itemKey: null,
      itemTitle: null,
      attachmentKey: null,
      pageLabel: null,
      location: null
    },
    anchor: null
  },
  messages: [{ role: "user", content: "Explain" }],
  profile: testProfile(kind, baseUrl)
});
