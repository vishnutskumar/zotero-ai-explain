import { describe, expect, it } from "vitest";

import { createPluginLifecycle } from "../../src/platform/plugin-lifecycle.js";

describe("createPluginLifecycle", () => {
  it("registers startup and shutdown actions in order", async () => {
    const calls: string[] = [];
    const lifecycle = createPluginLifecycle({
      startup: async () => {
        await Promise.resolve();
        calls.push("startup");
      },
      shutdown: async () => {
        await Promise.resolve();
        calls.push("shutdown");
      }
    });

    await lifecycle.startup();
    await lifecycle.shutdown();

    expect(calls).toEqual(["startup", "shutdown"]);
  });
});
