import { describe, expect, it } from "vitest";

import type { StringPrefReader, StringPrefWriter } from "../../src/preferences/ollama-profile.js";
import {
  ONBOARDING_SHOWN_PREF,
  clearOnboardingShown,
  markOnboardingShown,
  readOnboardingShown
} from "../../src/preferences/onboarding-state.js";

function makeStore(initial: Record<string, string> = {}): {
  values: Map<string, string>;
  reader: StringPrefReader;
  writer: StringPrefWriter;
} {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    values,
    reader: { get: (name) => values.get(name) },
    writer: {
      set(name, value) {
        values.set(name, value);
      },
      clear(name) {
        values.delete(name);
      }
    }
  };
}

describe("readOnboardingShown", () => {
  it("returns false when the pref is missing", () => {
    expect(readOnboardingShown(makeStore().reader)).toBe(false);
  });

  it("returns true only for the literal string 'true'", () => {
    const store = makeStore({ [ONBOARDING_SHOWN_PREF]: "true" });
    expect(readOnboardingShown(store.reader)).toBe(true);
  });

  it("treats any other value (empty, '1', 'TRUE', legacy garbage) as not-shown", () => {
    for (const value of ["", "1", "TRUE", "yes", "false"]) {
      const store = makeStore({ [ONBOARDING_SHOWN_PREF]: value });
      expect(readOnboardingShown(store.reader)).toBe(false);
    }
  });

  it("swallows reader exceptions and reports false", () => {
    expect(
      readOnboardingShown({
        get() {
          throw new Error("pref tree corrupt");
        }
      })
    ).toBe(false);
  });
});

describe("markOnboardingShown / clearOnboardingShown round-trip", () => {
  it("marks the pref and reads back true", () => {
    const store = makeStore();
    markOnboardingShown(store.writer);
    expect(store.values.get(ONBOARDING_SHOWN_PREF)).toBe("true");
    expect(readOnboardingShown(store.reader)).toBe(true);
  });

  it("clearOnboardingShown removes the pref so the next read returns false", () => {
    const store = makeStore({ [ONBOARDING_SHOWN_PREF]: "true" });
    expect(readOnboardingShown(store.reader)).toBe(true);
    clearOnboardingShown(store.writer);
    expect(readOnboardingShown(store.reader)).toBe(false);
  });

  it("falls back to writing the empty string when writer.clear is absent", () => {
    const values = new Map<string, string>([[ONBOARDING_SHOWN_PREF, "true"]]);
    const writerNoClear: StringPrefWriter = {
      set(name, value) {
        values.set(name, value);
      }
    };
    const reader: StringPrefReader = { get: (name) => values.get(name) };
    clearOnboardingShown(writerNoClear);
    // Empty string is treated as not-shown by `readOnboardingShown`.
    expect(readOnboardingShown(reader)).toBe(false);
    expect(values.get(ONBOARDING_SHOWN_PREF)).toBe("");
  });
});
