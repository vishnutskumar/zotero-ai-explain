import { describe, expect, it } from "vitest";

import { providerDisclosure } from "../../src/ui/privacy-label.js";

describe("providerDisclosure", () => {
  it("identifies remote provider/model before sending selected text", () => {
    expect(
      providerDisclosure({ displayName: "OpenAI", model: "gpt-test", sendMode: "remote" })
    ).toBe("Selected text will be sent to OpenAI using gpt-test.");
  });

  it("identifies local provider/model", () => {
    expect(providerDisclosure({ displayName: "Ollama", model: "llama3", sendMode: "local" })).toBe(
      "Selected text will be processed locally by Ollama using llama3."
    );
  });
});
