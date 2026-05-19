/* @vitest-environment jsdom */

/**
 * Adversarial integration tests for the reader -> popup flow.
 *
 * Each test drives the *registered* `renderTextSelectionPopup` handler
 * (the seam Zotero invokes when the user selects text in the reader),
 * the same way Zotero would: synthesize a `ReaderEvent` whose `append`
 * captures the button the handler injects, click the captured button at
 * a known screen-space rect, then assert against the live DOM produced
 * by the plugin.
 *
 * This is the seam the existing `src/platform/e2e-driver.ts` legacy flow
 * intentionally bypasses (it constructs a `SelectionContext` directly).
 * Tests here cover the user-visible bugs that bypass let through:
 *
 *   AC1 - popup is anchored within 250px (Manhattan) of the click button.
 *   AC2 - popup is closable (Escape, outside click, OR explicit close button).
 *   AC3 - popup body is scrollable when content exceeds max-height.
 *   AC4 - loading indicator visible BEFORE first streaming delta.
 *   AC5 - inline follow-up: textarea + submit + a second `/api/chat`.
 *   AC6 - settings dialog does not surface "Phase 2" / "not yet implemented".
 *   AC7 - immediate visual feedback on click (disabled, label, or busy element).
 *
 * Tests are intentionally tolerant of multiple acceptable selectors so the
 * sibling agent has design freedom; tolerance never widens to admit the
 * broken behaviour described in each AC.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConversationStore } from "../../src/conversation/conversation-store.js";
import { createIndexingController } from "../../src/indexing/indexing-controller.js";
import { controllerStubDeps } from "../indexing/controller-test-helpers.js";
import { createZoteroRuntime } from "../../src/platform/zotero-runtime.js";
import { createZoteroUiAdapter, type ZoteroGlobal } from "../../src/platform/zotero-ui-adapter.js";
import {
  createDefaultOllamaSettings,
  ollamaSettingsToProfile
} from "../../src/preferences/ollama-profile.js";
import type { ChatEvent, ModelProvider } from "../../src/providers/provider-types.js";
import { createPopupController } from "../../src/ui/popup-controller.js";
import type { SidebarController } from "../../src/ui/sidebar-controller.js";

type ReaderEvent = {
  readonly doc: Document;
  readonly params: { readonly annotation: { readonly text: string } };
  readonly reader?: { readonly _iframe?: { getBoundingClientRect(): DOMRect } };
  append(content: HTMLElement | { readonly label: string; readonly onCommand: () => void }): void;
};

type CapturedListener = {
  readonly type: string;
  readonly handler: (event: ReaderEvent) => void;
  readonly pluginID: string;
};

type FakeReader = NonNullable<ZoteroGlobal["Reader"]>;

function expectPresent<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be present`);
  }
  return value;
}

function createFakeReader(): {
  readonly listeners: CapturedListener[];
  readonly reader: FakeReader;
} {
  const listeners: CapturedListener[] = [];
  const reader = {
    registerEventListener(
      type: string,
      // The adapter declares ReaderEvent with optional `params`; we narrow
      // it here without sniffing through the adapter's internal type.
      handler: (event: unknown) => void,
      pluginID: string
    ): void {
      const narrowed = handler as unknown as (e: ReaderEvent) => void;
      listeners.push({ type, handler: narrowed, pluginID });
    },
    unregisterEventListener(type: string, handler: (event: unknown) => void): void {
      const narrowed = handler as unknown as (e: ReaderEvent) => void;
      const idx = listeners.findIndex((l) => l.type === type && l.handler === narrowed);
      if (idx >= 0) {
        listeners.splice(idx, 1);
      }
    }
  } as unknown as FakeReader;
  return { listeners, reader };
}

function findHandler(
  listeners: readonly CapturedListener[],
  type: string
): (event: ReaderEvent) => void {
  const entry = listeners.find((l) => l.type === type);
  if (entry === undefined) {
    throw new Error(`no listener registered for type ${type}`);
  }
  return entry.handler;
}

type AppendResult = {
  readonly append: ReaderEvent["append"];
  readonly button: () => HTMLElement;
};

function buildSyntheticAppend(doc: Document, container: HTMLElement): AppendResult {
  let captured: HTMLElement | null = null;
  const win = doc.defaultView;
  if (win === null) {
    throw new Error("synthetic append: document has no defaultView");
  }
  const append: ReaderEvent["append"] = (content) => {
    if (content instanceof win.HTMLElement) {
      captured = content;
      container.append(content);
      return;
    }
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = content.label;
    button.addEventListener("click", () => {
      content.onCommand();
    });
    captured = button;
    container.append(button);
  };
  return {
    append,
    button: () => {
      if (captured === null) {
        throw new Error("synthetic append: no button captured");
      }
      return captured;
    }
  };
}

function positionElement(
  element: HTMLElement,
  rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  }
): DOMRect {
  element.style.position = "fixed";
  element.style.left = `${String(rect.left)}px`;
  element.style.top = `${String(rect.top)}px`;
  element.style.width = `${String(rect.width)}px`;
  element.style.height = `${String(rect.height)}px`;
  const domRect: DOMRect = {
    left: rect.left,
    top: rect.top,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    width: rect.width,
    height: rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({})
  };
  (element as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    domRect;
  return domRect;
}

function manhattan(a: DOMRect, b: DOMRect): number {
  return Math.abs(a.left - b.left) + Math.abs(a.top - b.top);
}

// `Element.textContent` is typed `string | null` but strict-type-checked
// lint considers it `string` after element-narrowing. Use tiny helpers so
// every call site reads consistently without per-line `?? ""` lint noise.
function textOf(el: { readonly textContent: string | null } | null): string {
  if (el === null) return "";
  const t: string | null = el.textContent;
  return t ?? "";
}

function styleOf(el: { getAttribute(name: string): string | null } | null): string {
  if (el === null) return "";
  const v: string | null = el.getAttribute("style");
  return v ?? "";
}

function findPopupWrapper(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".zotero-ai-popup-wrapper");
}

function findScrollableInPopup(wrapper: HTMLElement): HTMLElement {
  const body = wrapper.querySelector<HTMLElement>(
    "[class*='body'], [class*='Body'], .zotero-ai-explain-popup__body"
  );
  return body ?? wrapper;
}

function isVisible(el: HTMLElement): boolean {
  if (el.hasAttribute("hidden")) {
    return false;
  }
  const style = styleOf(el);
  if (/display:\s*none/iu.test(style)) {
    return false;
  }
  if (/visibility:\s*hidden/iu.test(style)) {
    return false;
  }
  return true;
}

function findLoadingIndicator(wrapper: HTMLElement): HTMLElement | null {
  const candidates = Array.from(
    wrapper.querySelectorAll<HTMLElement>(
      "[data-state='loading'], [role='status'], .zotero-ai-explain-popup__loading"
    )
  );
  for (const candidate of candidates) {
    if (isVisible(candidate)) {
      return candidate;
    }
  }
  const body = wrapper.querySelector<HTMLElement>(
    "[class*='body'], [class*='Body'], .zotero-ai-explain-popup__body"
  );
  const bodyText = textOf(body).trim();
  if (
    body !== null &&
    isVisible(body) &&
    bodyText.length > 0 &&
    /^(loading|…|\.\.\.)/iu.test(bodyText)
  ) {
    return body;
  }
  return null;
}

function findCloseAffordance(wrapper: HTMLElement): HTMLElement | null {
  return wrapper.querySelector<HTMLElement>(
    "[data-action='close-popup'], [aria-label='Close'], .zotero-ai-explain-popup__close"
  );
}

function findFollowUpTextarea(wrapper: HTMLElement): HTMLTextAreaElement | null {
  return wrapper.querySelector<HTMLTextAreaElement>(
    "textarea[name='followUp'], [data-action='popup-followup'], textarea"
  );
}

function findFollowUpSubmit(wrapper: HTMLElement): HTMLButtonElement | null {
  const explicit = wrapper.querySelector<HTMLButtonElement>(
    "[data-action='submit-followup'], [data-action='popup-followup-submit']"
  );
  if (explicit !== null) {
    return explicit;
  }
  // Fall back to the form's submit button (the runtime ergonomic is
  // `<button type='submit'>`).
  return wrapper.querySelector<HTMLButtonElement>(
    "form button[type='submit'], button[type='submit']"
  );
}

type Harness = {
  readonly listeners: readonly CapturedListener[];
  readonly runtime: ReturnType<typeof createZoteroRuntime>;
};

function buildHarness(input?: {
  readonly provider?: ModelProvider;
  readonly sidebarController?: SidebarController;
}): Harness {
  const fake = createFakeReader();
  const debug = vi.fn();
  const zotero: ZoteroGlobal = {
    debug,
    Reader: fake.reader,
    getMainWindow: () => window
  };
  const ui = createZoteroUiAdapter({ Zotero: zotero, pluginId: "test-plugin" });
  const store = createConversationStore();
  const indexingController = createIndexingController({
    logger: { debug: () => undefined },
    ...controllerStubDeps()
  });
  const settings = createDefaultOllamaSettings();
  const profile = ollamaSettingsToProfile(settings);

  const providerImpl: ModelProvider = input?.provider ?? defaultProvider();
  const popupController = createPopupController({ store, provider: providerImpl });
  const sidebarController: SidebarController = input?.sidebarController ?? {
    sendFollowUp: vi.fn(async () => Promise.resolve())
  };

  const runtime = createZoteroRuntime({
    settings,
    indexingController,
    ui,
    store,
    profile: () => profile,
    popupController,
    sidebarController,
    disclosure: () => `Sending to ${profile.displayName}`
  });

  return {
    listeners: fake.listeners,
    runtime
  };
}

function defaultProvider(): ModelProvider {
  return {
    id: "ollama",
    displayName: "Ollama",
    streamChat() {
      return (async function* gen(): AsyncGenerator<ChatEvent> {
        await Promise.resolve();
        yield { type: "message_start", providerId: "ollama", model: "test" };
        yield { type: "delta", text: "Hello " };
        yield { type: "delta", text: "world" };
        yield { type: "message_end" };
      })();
    }
  };
}

function delayedProvider(firstChunkDelayMs: number, lines: number): ModelProvider {
  return {
    id: "ollama",
    displayName: "Ollama",
    streamChat() {
      return (async function* gen(): AsyncGenerator<ChatEvent> {
        yield { type: "message_start", providerId: "ollama", model: "test" };
        await new Promise((resolveDelay) => setTimeout(resolveDelay, firstChunkDelayMs));
        for (let i = 1; i <= lines; i++) {
          yield { type: "delta", text: `line ${String(i)}\n` };
        }
        yield { type: "message_end" };
      })();
    }
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolveWait) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolveWait(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolveWait(false);
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function mountPopupViaReaderHandler(
  harness: Harness,
  options?: {
    readonly buttonRect?: {
      readonly left: number;
      readonly top: number;
      readonly width: number;
      readonly height: number;
    };
    readonly quote?: string;
    readonly skipClick?: boolean;
  }
): Promise<{ readonly button: HTMLElement; readonly buttonRect: DOMRect }> {
  await harness.runtime.startup();
  const handler = findHandler(harness.listeners, "renderTextSelectionPopup");
  const synth = buildSyntheticAppend(document, document.body);
  handler({
    doc: document,
    params: { annotation: { text: options?.quote ?? "Adversarial selection." } },
    // Plumb a synthetic reader whose chrome-side `_iframe` rect is the document
    // body — keeps the production handler's chrome-coord math sane in jsdom
    // (codex review redo: was previously using HTML frameElement, which now
    // bails out to anchor:null without this injection).
    reader: {
      _iframe: { getBoundingClientRect: () => document.body.getBoundingClientRect() }
    },
    append: synth.append
  });
  const button = synth.button();
  const rect = options?.buttonRect ?? { left: 500, top: 300, width: 120, height: 24 };
  const buttonRect = positionElement(button, rect);
  if (options?.skipClick !== true) {
    button.click();
  }
  return { button, buttonRect };
}

describe("registered reader handler -> popup flow (integration)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("AC1: popup anchors near the clicked selection button (not top-center)", async () => {
    const harness = buildHarness();
    const { buttonRect } = await mountPopupViaReaderHandler(harness, {
      buttonRect: { left: 500, top: 300, width: 120, height: 24 }
    });
    const ok = await waitFor(() => findPopupWrapper() !== null, 2000);
    expect(ok).toBe(true);
    const wrapper = expectPresent(findPopupWrapper(), "popup wrapper");
    const popupRect = wrapper.getBoundingClientRect();
    // The popup MUST land within 250px (Manhattan) of the button rect.
    // Hard-coded `top: 80px; left: 50%` places the popup at roughly
    // (window.innerWidth / 2, 80) — fails by hundreds of pixels at (500, 300).
    const distance = manhattan(popupRect, buttonRect);
    expect(distance).toBeLessThanOrEqual(250);
    await harness.runtime.shutdown();
  });

  it("AC1 (counterexample): popup wrapper is NOT pinned to top-center via inline style", async () => {
    const harness = buildHarness();
    await mountPopupViaReaderHandler(harness, {
      buttonRect: { left: 800, top: 600, width: 120, height: 24 }
    });
    await waitFor(() => findPopupWrapper() !== null, 2000);
    const wrapper = findPopupWrapper();
    const style = styleOf(wrapper);
    const hasHardcodedTop = /top:\s*80px/iu.test(style);
    const hasHardcodedLeftCenter = /left:\s*50%/iu.test(style);
    expect(hasHardcodedTop && hasHardcodedLeftCenter).toBe(false);
    await harness.runtime.shutdown();
  });

  it("AC2: pressing Escape closes the popup", async () => {
    const harness = buildHarness();
    await mountPopupViaReaderHandler(harness);
    await waitFor(() => findPopupWrapper() !== null, 2000);
    expect(findPopupWrapper()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const gone = await waitFor(() => findPopupWrapper() === null, 1000);
    expect(gone).toBe(true);
    await harness.runtime.shutdown();
  });

  it("AC2: clicking a close affordance removes the popup", async () => {
    const harness = buildHarness();
    await mountPopupViaReaderHandler(harness);
    await waitFor(() => findPopupWrapper() !== null, 2000);
    const wrapper = expectPresent(findPopupWrapper(), "popup wrapper");
    const closeEl = expectPresent(findCloseAffordance(wrapper), "close affordance");
    closeEl.click();
    const gone = await waitFor(() => findPopupWrapper() === null, 1000);
    expect(gone).toBe(true);
    await harness.runtime.shutdown();
  });

  it("AC3: popup body is scrollable when content exceeds the max-height", async () => {
    vi.useRealTimers();
    const harness = buildHarness({ provider: delayedProvider(0, 80) });
    await mountPopupViaReaderHandler(harness);
    await waitFor(() => findPopupWrapper() !== null, 2000);
    const wrapper = expectPresent(findPopupWrapper(), "popup wrapper");
    // Wait until enough content has streamed in.
    await waitFor(() => textOf(wrapper).includes("line 70"), 4000);
    const scrollable = findScrollableInPopup(wrapper);
    const wrapperStyle = styleOf(wrapper);
    const stylesMaxHeight = /max-height:\s*\d+(?:vh|px|%)/iu.test(wrapperStyle);
    const measuredOverflow = scrollable.scrollHeight > scrollable.clientHeight;
    const contentLength = textOf(scrollable).length;
    // jsdom doesn't run layout, so scrollHeight/clientHeight are both 0.
    // Accept the documented-overflow path: wrapper has a max-height AND
    // the text content is long enough that a real browser would overflow.
    const documentedOverflowPath = stylesMaxHeight && contentLength > 400;
    expect(measuredOverflow || documentedOverflowPath).toBe(true);
    // The scroll surface MUST be marked overflow-auto/scroll/overlay so the
    // user can actually scroll it.
    const scrollableStyle = styleOf(scrollable);
    const surfaceStyle = scrollableStyle.length > 0 ? scrollableStyle : wrapperStyle;
    expect(/overflow(?:-y)?:\s*(auto|scroll|overlay)/iu.test(surfaceStyle)).toBe(true);
    await harness.runtime.shutdown();
  });

  it("AC4: loading indicator visible before first streaming delta, gone after", async () => {
    vi.useRealTimers();
    const harness = buildHarness({ provider: delayedProvider(300, 2) });
    await mountPopupViaReaderHandler(harness);
    const popupOk = await waitFor(() => findPopupWrapper() !== null, 1000);
    expect(popupOk).toBe(true);
    const wrapper = expectPresent(findPopupWrapper(), "popup wrapper");
    // Sample within the 300ms window before the first delta arrives.
    const sawLoading = await waitFor(() => findLoadingIndicator(wrapper) !== null, 250);
    expect(sawLoading).toBe(true);
    // Wait for the response to settle.
    await waitFor(() => textOf(wrapper).includes("line 2"), 4000);
    const afterText = textOf(wrapper);
    expect(afterText).toMatch(/line 1/u);
    const stillLoading = findLoadingIndicator(wrapper);
    // The body now has assistant text; "line 1/2" don't trigger the
    // text-based fallback. The indicator must therefore resolve to null.
    expect(stillLoading).toBeNull();
    await harness.runtime.shutdown();
  });

  it("AC5: popup hosts a follow-up textarea + submit and the runtime processes it", async () => {
    const sentMessages: string[] = [];
    const sidebarController: SidebarController = {
      sendFollowUp: vi.fn(async (_id: string, message: string) => {
        sentMessages.push(message);
        return Promise.resolve();
      })
    };
    const harness = buildHarness({ sidebarController });
    await mountPopupViaReaderHandler(harness);
    await waitFor(() => findPopupWrapper() !== null, 2000);
    const wrapper = expectPresent(findPopupWrapper(), "popup wrapper");
    // Wait for the initial assistant turn.
    await waitFor(() => textOf(wrapper).includes("Hello world"), 2000);
    const textarea = expectPresent(findFollowUpTextarea(wrapper), "follow-up textarea");
    const submit = expectPresent(findFollowUpSubmit(wrapper), "follow-up submit");
    textarea.value = "What about edge cases?";
    submit.click();
    const form = textarea.closest("form");
    if (form !== null) {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }
    // The user's typed text MUST either appear as a new turn in the popup
    // body OR (the fallback design) be routed through the sidebar controller.
    const handled = await waitFor(() => {
      if (textOf(wrapper).includes("What about edge cases?")) return true;
      if (sentMessages.includes("What about edge cases?")) return true;
      return false;
    }, 2000);
    expect(handled).toBe(true);
    await harness.runtime.shutdown();
  });

  it("AC7: clicking the reader button surfaces immediate feedback (before popup mounts)", async () => {
    // Provider's first event is delayed so the popup MAY not be mounted at
    // the time we sample. AC7 says SOMETHING must change within 50ms of the
    // click.
    const harness = buildHarness({ provider: delayedProvider(200, 1) });
    const { button } = await mountPopupViaReaderHandler(harness, { skipClick: true });
    const labelBefore = textOf(button);
    const disabledBefore = button instanceof HTMLButtonElement ? button.disabled : false;
    button.click();
    // Sample immediately. Either: button label/disabled changed, OR a busy
    // element exists in the document, OR the popup has mounted with a
    // loading indicator. ANY of these satisfies AC7.
    const labelAfter = textOf(button);
    const disabledAfter = button instanceof HTMLButtonElement ? button.disabled : false;
    const hasBusyEl = document.querySelector("[aria-busy='true']") !== null;
    const popup = findPopupWrapper();
    const loadingIndicator = popup !== null ? findLoadingIndicator(popup) : null;
    const labelChanged = labelBefore !== labelAfter || disabledBefore !== disabledAfter;
    expect(labelChanged || hasBusyEl || loadingIndicator !== null).toBe(true);
    await harness.runtime.shutdown();
  });
});

describe("settings dialog (integration)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("AC6: settings dialog does not surface 'Phase 2' or 'not yet implemented'", async () => {
    // Prepare a Tools menu popup the adapter will mount into.
    const toolsPopup = document.createElement("menupopup");
    toolsPopup.id = "menu_ToolsPopup";
    document.body.append(toolsPopup);

    const fake = createFakeReader();
    const debug = vi.fn();
    const zotero: ZoteroGlobal = {
      debug,
      Reader: fake.reader,
      getMainWindow: () => window
    };
    const ui = createZoteroUiAdapter({ Zotero: zotero, pluginId: "test-plugin" });
    const store = createConversationStore();
    const indexingController = createIndexingController({
      logger: { debug: () => undefined },
      ...controllerStubDeps()
    });
    const settings = createDefaultOllamaSettings();
    const profile = ollamaSettingsToProfile(settings);
    const popupController = createPopupController({
      store,
      provider: defaultProvider()
    });
    const sidebarController: SidebarController = {
      sendFollowUp: vi.fn(async () => Promise.resolve())
    };
    const runtime = createZoteroRuntime({
      settings,
      indexingController,
      ui,
      store,
      profile: () => profile,
      popupController,
      sidebarController,
      disclosure: () => "x"
    });
    await runtime.startup();

    const menuItem = expectPresent(
      toolsPopup.querySelector("[label='Zotero AI Explain Settings']"),
      "settings menu item"
    );
    menuItem.dispatchEvent(new Event("command", { bubbles: true }));
    const dialog = expectPresent(
      document.querySelector<HTMLElement>(".zotero-ai-dialog"),
      "settings dialog"
    );
    const dialogText = textOf(dialog);
    expect(/Phase ?2/iu.test(dialogText)).toBe(false);
    expect(/not yet implemented/iu.test(dialogText)).toBe(false);
    await runtime.shutdown();
  });
});
