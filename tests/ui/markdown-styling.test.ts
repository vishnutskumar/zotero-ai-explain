/* @vitest-environment jsdom */

/**
 * Adversarial tests for AC-13 — the shared markdown stylesheet applied
 * consistently to BOTH the anchored popup and the sidebar.
 *
 * Plan: `docs/superpowers/plans/2026-05-19-pdf-context-features.md`
 *   AC-13 description          L730-773 (Adv-1 .. Adv-6)
 *   AC-13 interface contract   L1218-1240
 *
 * --------------------------------------------------------------------
 * Fault Localization (Template 4 — AC-13 shared markdown CSS)
 * --------------------------------------------------------------------
 *
 * 1. Spec semantics (premises):
 *    P1.  `src/ui/styles.ts` exports a single shared constant
 *         `MARKDOWN_CSS: string` — the markdown stylesheet.
 *    P2.  `MARKDOWN_CSS` carries rules for the block elements
 *         `renderMarkdown` emits: `h1`-`h4` (the parser caps headings
 *         at level 4, `markdown.ts:97`), `p`, `ul`/`ol`/`li`, inline
 *         and fenced `code`/`pre`, `blockquote`, and `a`.
 *    P3.  Every rule selector is a DESCENDANT selector keyed on one of
 *         the three stable markdown container classes:
 *         `.zotero-ai-explain-popup__body`,
 *         `.zotero-ai-explain-popup__turn-body`,
 *         `.zotero-ai-explain-sidebar__body`. No bare element selector
 *         (`h1 { … }`) — that would leak into Zotero chrome.
 *    P4.  The CSS uses `var(--…, <system-color>)` design tokens — NO
 *         literal `#rrggbb` / `white` / `black` color values (the
 *         `styles.ts:1-6` "never literal white/black" rule).
 *    P5.  The popup's existing `<style>` block (`anchored-popup-view`)
 *         includes `MARKDOWN_CSS` verbatim — no new element.
 *    P6.  The sidebar — which today ships ZERO `<style>` (SP-13.3) —
 *         gains a `<style>` element holding `MARKDOWN_CSS`, created in
 *         `renderSidebarConversation` and appended to the sidebar root.
 *    P7.  Both surfaces share the SAME `MARKDOWN_CSS` — a single source
 *         of truth (reverting `styles.ts` alone breaks both).
 *
 * 2. Code path trace (against the contract — bodies NOT inspected):
 *    - `renderAnchoredPopup(input)` → builds a `<section>` containing a
 *      `<style>` whose textContent includes `MARKDOWN_CSS`.
 *    - `renderSidebarConversation(input)` → builds an `<aside>`
 *      containing a NEW `<style>` whose textContent is `MARKDOWN_CSS`.
 *
 * 3. Divergence analysis (likely bugs the tests target):
 *    D1 [HIGH]   the sidebar still ships zero `<style>` — markdown DOM
 *                gets only UA defaults (the AC-13 root-cause bug).
 *    D2 [HIGH]   the popup and the sidebar use DIFFERENT CSS strings
 *                (no single source of truth) — drift between surfaces.
 *    D3 [HIGH]   a rule is a bare element selector (`code { … }`) →
 *                leaks into Zotero chrome (forms, headers, quote block).
 *    D4 [MEDIUM] `h4` (the deepest emitted heading) has no rule → the
 *                deepest heading renders unstyled.
 *    D5 [MEDIUM] a literal color (`#fff`, `white`, `black`) is used
 *                instead of a design token → ignores the OS theme.
 *    D6 [MEDIUM] `pre` lacks `overflow-x` → long code lines blow out
 *                the popup width.
 *    D7 [LOW]    a rule for `h5`/`h6` (never emitted by the parser) —
 *                harmless but indicates the cap was misread.
 *
 * 4. Test targets (ranked): D1 (sidebar stylesheet) > D2 (shared
 *    constant) > D3 (scoping) > D4 (h4 coverage) > D5 (tokens) >
 *    D6 (pre overflow).
 *
 * --------------------------------------------------------------------
 * COMPILE NOTE: this file depends on the AC-13 `MARKDOWN_CSS` export
 * from `src/ui/styles.ts`. Until the implementer lands it the file
 * fails to COMPILE. The test SOURCE is the authority on the contract
 * (plan L1218-1240).
 * --------------------------------------------------------------------
 */

import { describe, expect, it } from "vitest";

import { renderAnchoredPopup } from "../../src/ui/anchored-popup-view.js";
import { renderSidebarConversation } from "../../src/ui/sidebar-view.js";
import { MARKDOWN_CSS } from "../../src/ui/styles.js";

const POPUP_BODY_CLASS = ".zotero-ai-explain-popup__body";
const POPUP_TURN_BODY_CLASS = ".zotero-ai-explain-popup__turn-body";
const SIDEBAR_BODY_CLASS = ".zotero-ai-explain-sidebar__body";

/** Collect the concatenated textContent of every `<style>` in `root`. */
function allStyleText(root: Element): string {
  return Array.from(root.querySelectorAll("style"))
    .map((s) => s.textContent)
    .join("\n");
}

function popupRoot(): HTMLElement {
  return renderAnchoredPopup({
    disclosure: "AI-generated.",
    text: "# Heading\n\nSome body text.",
    anchor: { left: 10, top: 10, width: 80, height: 16 }
  });
}

function sidebarRoot(): HTMLElement {
  return renderSidebarConversation({
    quote: "Dense passage.",
    sourceLabel: "Paper, p. 4",
    messages: [
      { role: "user", content: "Explain." },
      { role: "assistant", content: "## Sub\n\n- a\n- b\n\n`code`" }
    ]
  });
}

// ====================================================================
// MARKDOWN_CSS — the shared constant covers every emitted block element
// ====================================================================

describe("AC-13 MARKDOWN_CSS — covers the markdown block elements", () => {
  it("is a non-empty string export", () => {
    expect(typeof MARKDOWN_CSS).toBe("string");
    expect(MARKDOWN_CSS.length).toBeGreaterThan(0);
  });

  it("Adv-5: provides rules for every heading level the parser can emit (h1..h4)", () => {
    for (const tag of ["h1", "h2", "h3", "h4"]) {
      // D4: the deepest emitted heading (h4) must be styled. A rule for
      // each level is required somewhere in the stylesheet.
      expect(MARKDOWN_CSS, `missing rule for ${tag}`).toMatch(new RegExp(`\\b${tag}\\b`, "u"));
    }
  });

  it("Adv-5: does NOT bother styling h5/h6 — the parser caps headings at level 4", () => {
    // markdown.ts:97 — `#{1,4}` — h5/h6 are never emitted. A rule for
    // them is dead CSS; flag it so the cap is not misread.
    expect(MARKDOWN_CSS).not.toMatch(/\bh5\b/u);
    expect(MARKDOWN_CSS).not.toMatch(/\bh6\b/u);
  });

  it("covers list elements ul, ol, and li", () => {
    expect(MARKDOWN_CSS).toMatch(/\bul\b/u);
    expect(MARKDOWN_CSS).toMatch(/\bol\b/u);
    expect(MARKDOWN_CSS).toMatch(/\bli\b/u);
  });

  it("covers inline code, fenced pre, and blockquote", () => {
    expect(MARKDOWN_CSS).toMatch(/\bcode\b/u);
    expect(MARKDOWN_CSS).toMatch(/\bpre\b/u);
    expect(MARKDOWN_CSS).toMatch(/\bblockquote\b/u);
  });

  it("Adv-6 corollary: `pre` gets overflow-x so long code lines do not blow out the width", () => {
    // D6: a fenced code block with a long line must scroll, not stretch
    // the popup. The stylesheet must give `pre` an `overflow-x` rule.
    expect(MARKDOWN_CSS).toMatch(/overflow-x\s*:/u);
  });

  it("Adv-3: uses var(--…) design tokens — no literal #rrggbb / white / black colors", () => {
    // D5 — mirrors the styles.ts:1-6 "never literal white/black" rule.
    expect(MARKDOWN_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
    // A literal `white`/`black` as a CSS color value (e.g. `: white;`).
    expect(MARKDOWN_CSS).not.toMatch(/:\s*white\b/u);
    expect(MARKDOWN_CSS).not.toMatch(/:\s*black\b/u);
    // It DOES reference at least one design token.
    expect(MARKDOWN_CSS).toMatch(/var\(--[a-z-]+/u);
  });

  it("Adv-4: every selector is scoped to a markdown container class — no bare element selector", () => {
    // D3: split into rule blocks and assert each selector list mentions
    // one of the three container classes. A bare `h1 { … }` would leak
    // into Zotero chrome.
    const ruleBlocks = MARKDOWN_CSS.split("}")
      .map((b) => b.trim())
      .filter((b) => b.includes("{"));
    expect(ruleBlocks.length).toBeGreaterThan(0);
    for (const block of ruleBlocks) {
      const selectorPart = block.slice(0, block.indexOf("{"));
      // A scoped rule may carry several comma-separated selectors; each
      // must be anchored under a markdown container class.
      const selectors = selectorPart
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith("@") && !s.startsWith("/*"));
      for (const selector of selectors) {
        const scoped =
          selector.includes("zotero-ai-explain-popup__body") ||
          selector.includes("zotero-ai-explain-popup__turn-body") ||
          selector.includes("zotero-ai-explain-sidebar__body");
        expect(scoped, `unscoped markdown selector leaks into chrome: "${selector}"`).toBe(true);
      }
    }
  });

  it("Adv-4: names all three markdown container classes the contract scopes under", () => {
    expect(MARKDOWN_CSS).toContain("zotero-ai-explain-popup__body");
    expect(MARKDOWN_CSS).toContain("zotero-ai-explain-popup__turn-body");
    expect(MARKDOWN_CSS).toContain("zotero-ai-explain-sidebar__body");
  });
});

// ====================================================================
// Adv-1 — the sidebar gains a <style> with the markdown rules
// ====================================================================

describe("AC-13 Adv-1 — the sidebar ships a markdown stylesheet", () => {
  it("renderSidebarConversation output contains at least one <style> element", () => {
    // D1: before the fix the sidebar has ZERO <style> tags (SP-13.3).
    const view = sidebarRoot();
    expect(view.querySelectorAll("style").length).toBeGreaterThan(0);
  });

  it("the sidebar <style> includes rules for h1/code/pre/blockquote/ul scoped under __body", () => {
    const view = sidebarRoot();
    const css = allStyleText(view);
    expect(css).toContain("zotero-ai-explain-sidebar__body");
    for (const tag of ["h1", "code", "pre", "blockquote", "ul"]) {
      expect(css, `sidebar markdown CSS missing ${tag}`).toMatch(new RegExp(`\\b${tag}\\b`, "u"));
    }
  });

  it("the sidebar embeds the shared MARKDOWN_CSS verbatim", () => {
    const view = sidebarRoot();
    expect(allStyleText(view)).toContain(MARKDOWN_CSS);
  });
});

// ====================================================================
// Adv-2 — the popup carries the SAME rules (single source of truth)
// ====================================================================

describe("AC-13 Adv-2 — the popup carries the identical MARKDOWN_CSS", () => {
  it("the popup <style> block includes the shared MARKDOWN_CSS verbatim", () => {
    const view = popupRoot();
    expect(allStyleText(view)).toContain(MARKDOWN_CSS);
  });

  it("the popup markdown rules are scoped under __body and __turn-body", () => {
    const view = popupRoot();
    const css = allStyleText(view);
    expect(css).toContain("zotero-ai-explain-popup__body");
    expect(css).toContain("zotero-ai-explain-popup__turn-body");
  });

  it("Adv-2: popup and sidebar embed the EXACT same shared constant", () => {
    // D2: both surfaces must reference one constant. We assert the
    // identical substring is present in both rendered trees.
    const popupCss = allStyleText(popupRoot());
    const sidebarCss = allStyleText(sidebarRoot());
    expect(popupCss).toContain(MARKDOWN_CSS);
    expect(sidebarCss).toContain(MARKDOWN_CSS);
  });
});

// ====================================================================
// Adv-6 — the live-update sidebar body class matches the styled selector
// ====================================================================

describe("AC-13 Adv-6 — the streamed sidebar row body is covered by the scoped rule", () => {
  it("rendered assistant message bodies carry the .zotero-ai-explain-sidebar__body class", () => {
    // The runtime live-update subscription repaints into a row whose
    // body reuses `.zotero-ai-explain-sidebar__body`. If the assistant
    // body did NOT carry that class, the scoped rule would never apply
    // to streamed deltas.
    const view = sidebarRoot();
    const bodies = view.querySelectorAll(SIDEBAR_BODY_CLASS);
    expect(bodies.length).toBeGreaterThan(0);
  });

  it("the markdown container classes used by the views are exactly the classes the CSS scopes under", () => {
    // Cross-check: the popup body element class and the sidebar body
    // element class must MATCH the selectors the stylesheet keys on,
    // otherwise the scoped rule covers nothing.
    const popup = popupRoot();
    const sidebar = sidebarRoot();
    expect(popup.querySelector(POPUP_BODY_CLASS)).not.toBeNull();
    expect(sidebar.querySelector(SIDEBAR_BODY_CLASS)).not.toBeNull();
    // The popup-turn-body class is a scoping target the multi-turn
    // thread uses; the constant must still reference it (asserted in the
    // MARKDOWN_CSS suite). Here we only assert the two always-rendered
    // body containers exist with the styled class.
    void POPUP_TURN_BODY_CLASS;
  });
});
