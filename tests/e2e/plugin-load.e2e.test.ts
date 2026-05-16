import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PLUGIN_ID,
  REPO_ROOT,
  cleanupProfile,
  startZoteroWithPlugin,
  type ZoteroHandle
} from "../../scripts/zotero-e2e/launch.mjs";

const MARIONETTE_PORT = Number(process.env.ZOTERO_MARIONETTE_PORT ?? "2828");
const XPI_PATH = process.env.ZOTERO_XPI ?? join(REPO_ROOT, "zotero-ai-explain.xpi");

type State = {
  handle: ZoteroHandle | null;
  startupError: Error | null;
};

const state: State = {
  handle: null,
  startupError: null
};

function requireHandle(s: State): ZoteroHandle {
  if (s.handle === null) {
    throw s.startupError ?? new Error("Zotero handle was not initialised");
  }
  return s.handle;
}

beforeAll(async () => {
  if (!existsSync(XPI_PATH)) {
    throw new Error(
      `Plugin XPI not found at ${XPI_PATH}. Build it via 'npm run build && npm run package'.`
    );
  }

  try {
    state.handle = await startZoteroWithPlugin({
      xpiPath: XPI_PATH,
      marionettePort: MARIONETTE_PORT,
      startupTimeoutMs: 90_000,
      quiet: true
    });
  } catch (err) {
    state.startupError = err instanceof Error ? err : new Error(String(err));
  }
}, 180_000);

afterAll(async () => {
  if (state.handle) {
    await state.handle.shutdown({ graceMs: 5_000 });
    cleanupProfile(state.handle.profileDir);
    state.handle = null;
  }
}, 60_000);

describe("Zotero plugin load (e2e)", () => {
  it("starts Zotero successfully and produces a debug log", () => {
    if (state.startupError) {
      throw state.startupError;
    }
    const handle = requireHandle(state);
    expect(handle.getLog().length).toBeGreaterThan(0);
  });

  it("emits the plugin startup line in the Zotero debug log", () => {
    const handle = requireHandle(state);
    expect(handle.getLog()).toContain("Zotero AI Explain startup");
  });

  it("registers the Tools menu item", () => {
    const handle = requireHandle(state);
    expect(handle.getLog()).toMatch(
      /Zotero AI Explain registered menu: Zotero AI Explain Settings/u
    );
  });

  it("does not log a 'could not find the Tools menu popup' warning", () => {
    const handle = requireHandle(state);
    expect(handle.getLog()).not.toContain("could not find the Tools menu popup");
  });

  it("registers the reader text-selection-popup command", () => {
    const handle = requireHandle(state);
    expect(handle.getLog()).toMatch(
      /Zotero AI Explain registered reader command: Explain with AI/u
    );
  });

  it("does not log a bootstrap startup error for our plugin id", () => {
    const handle = requireHandle(state);
    const log = handle.getLog();
    // A failing startup is fatal and would have prevented the registration
    // lines above, but assert explicitly so a future regression is caught.
    expect(log).not.toContain(`Error running bootstrap method 'startup' on ${PLUGIN_ID}`);
  });
});
