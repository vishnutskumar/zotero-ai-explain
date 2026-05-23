/**
 * Shared style constants for plugin views. Tokens come from the live
 * Zotero 9 dump (`.forge/phases/zotero-e2e-harness/zotero9-tokens.json`);
 * every fallback is a CSS system color (Canvas, CanvasText, GrayText,
 * ButtonFace, ButtonBorder, Highlight, HighlightText) that adapts to the
 * OS theme. We never fall back to literal `white` / `black`.
 *
 * Spacing scale is fixed (4 / 8 / 12 / 16) because Zotero 9 ships no
 * `--space-*` tokens. Typography inherits from the host surface; we set a
 * native system font stack on each root container so labels and buttons
 * track the OS UI font.
 */

export const FONT_STACK = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;

export const FG = "var(--fill-primary, CanvasText)";
export const FG_MUTED = "var(--fill-secondary, GrayText)";
export const SURFACE_BG = "var(--material-background, Canvas)";
export const TOOLBAR_BG = "var(--material-toolbar, ButtonFace)";
export const STRIPE_BG = "var(--color-stripe, ButtonFace)";
export const BORDER_HAIRLINE = "var(--fill-quarternary, ButtonBorder)";
export const ACCENT = "var(--accent-blue, Highlight)";
export const ACCENT_FG = "var(--accent-white, HighlightText)";
export const BUTTON_BG = "var(--material-button, ButtonFace)";

/** Reset the host theme bleed-through onto a root element. */
export const ROOT_STYLE = `font-family: ${FONT_STACK}; font-size: 13px; line-height: 1.45; color: ${FG};`;

export const FIELD_GROUP_STYLE = "display: flex; flex-direction: column; gap: 4px;";
export const FIELD_LABEL_STYLE = `font-size: 12px; font-weight: 500; color: ${FG_MUTED};`;
export const FIELD_INPUT_STYLE =
  `appearance: none; padding: 6px 8px; border-radius: 4px; ` +
  `border: 1px solid ${BORDER_HAIRLINE}; background: ${SURFACE_BG}; color: ${FG}; ` +
  `font-family: ${FONT_STACK}; font-size: 13px; line-height: 1.45;`;
export const FIELD_TEXTAREA_STYLE = `${FIELD_INPUT_STYLE} min-height: 64px; resize: vertical;`;

export const FORM_STACK_STYLE = "display: flex; flex-direction: column; gap: 12px;";

export const BUTTON_BASE_STYLE =
  `appearance: none; cursor: pointer; padding: 6px 12px; border-radius: 4px; ` +
  `border: 1px solid ${BORDER_HAIRLINE}; background: ${BUTTON_BG}; color: ${FG}; ` +
  `font-family: ${FONT_STACK}; font-size: 12px; font-weight: 500; line-height: 1.2;`;
export const BUTTON_PRIMARY_STYLE =
  `appearance: none; cursor: pointer; padding: 6px 12px; border-radius: 4px; ` +
  `border: 1px solid ${ACCENT}; background: ${ACCENT}; color: ${ACCENT_FG}; ` +
  `font-family: ${FONT_STACK}; font-size: 12px; font-weight: 600; line-height: 1.2;`;

export const BUTTON_ROW_STYLE = "display: flex; gap: 8px; flex-wrap: wrap;";

export const SECTION_HEADING_STYLE =
  `margin: 0; font-size: 12px; font-weight: 600; text-transform: uppercase; ` +
  `letter-spacing: 0.04em; color: ${FG_MUTED};`;

export const MUTED_TEXT_STYLE = `margin: 0; font-size: 12px; color: ${FG_MUTED};`;

/**
 * Real CSS section divider. Settings-view sections use this on every
 * heading row so the dialog reads as a stack of named blocks instead
 * of a flat form. The `border-top` paints a hairline using the same
 * token as the input border (BORDER_HAIRLINE) so the divider tracks
 * the host theme.
 */
export const SECTION_DIVIDER_STYLE = `border-top: 1px solid ${BORDER_HAIRLINE}; padding-top: 12px;`;

/** Container style for one settings section (heading + blurb + fields). */
export const SECTION_BLOCK_STYLE = "display: flex; flex-direction: column; gap: 8px;";

/** Explanatory copy directly under a section heading. */
export const SECTION_BLURB_STYLE = `margin: 0; font-size: 11px; color: ${FG_MUTED}; line-height: 1.4;`;

/**
 * Shared markdown stylesheet (AC-13). Styles the block elements
 * `renderMarkdown` emits — `h1`–`h4` (the parser caps headings at level
 * 4, `markdown.ts:97`), `p`, `ul`/`ol`/`li`, inline and fenced
 * `code`/`pre`, `blockquote`, and `a` — so the anchored popup and the
 * sidebar render identical markdown typography from a single source of
 * truth.
 *
 * Every rule is a DESCENDANT selector keyed on one of the three stable
 * markdown container classes (`.zotero-ai-explain-popup__body`,
 * `.zotero-ai-explain-popup__turn-body`,
 * `.zotero-ai-explain-sidebar__body`) so the rules style markdown
 * content WITHOUT bleeding into non-markdown chrome (headers, forms,
 * quote blocks). Colors are design tokens with CSS system-color
 * fallbacks — never literal `white` / `black` — so the typography
 * tracks the OS theme.
 *
 * Callers append this constant verbatim into a `<style>` block; the
 * selectors carry their own scoping prefixes so no caller-side wrapping
 * is required.
 */
export const MARKDOWN_CSS = `
  .zotero-ai-explain-popup__body h1,
  .zotero-ai-explain-popup__turn-body h1,
  .zotero-ai-explain-sidebar__body h1 {
    margin: 0.4em 0 0.3em; font-size: 1.3em; font-weight: 600; line-height: 1.3;
  }
  .zotero-ai-explain-popup__body h2,
  .zotero-ai-explain-popup__turn-body h2,
  .zotero-ai-explain-sidebar__body h2 {
    margin: 0.4em 0 0.3em; font-size: 1.18em; font-weight: 600; line-height: 1.3;
  }
  .zotero-ai-explain-popup__body h3,
  .zotero-ai-explain-popup__turn-body h3,
  .zotero-ai-explain-sidebar__body h3 {
    margin: 0.4em 0 0.25em; font-size: 1.08em; font-weight: 600; line-height: 1.3;
  }
  .zotero-ai-explain-popup__body h4,
  .zotero-ai-explain-popup__turn-body h4,
  .zotero-ai-explain-sidebar__body h4 {
    margin: 0.4em 0 0.25em; font-size: 1em; font-weight: 600; line-height: 1.3;
  }
  .zotero-ai-explain-popup__body p,
  .zotero-ai-explain-popup__turn-body p,
  .zotero-ai-explain-sidebar__body p {
    margin: 0.35em 0;
  }
  .zotero-ai-explain-popup__body ul,
  .zotero-ai-explain-popup__turn-body ul,
  .zotero-ai-explain-sidebar__body ul,
  .zotero-ai-explain-popup__body ol,
  .zotero-ai-explain-popup__turn-body ol,
  .zotero-ai-explain-sidebar__body ol {
    margin: 0.35em 0; padding-left: 1.4em;
  }
  .zotero-ai-explain-popup__body ul,
  .zotero-ai-explain-popup__turn-body ul,
  .zotero-ai-explain-sidebar__body ul {
    list-style: disc;
  }
  .zotero-ai-explain-popup__body ol,
  .zotero-ai-explain-popup__turn-body ol,
  .zotero-ai-explain-sidebar__body ol {
    list-style: decimal;
  }
  .zotero-ai-explain-popup__body li,
  .zotero-ai-explain-popup__turn-body li,
  .zotero-ai-explain-sidebar__body li {
    margin: 0.15em 0;
  }
  .zotero-ai-explain-popup__body code,
  .zotero-ai-explain-popup__turn-body code,
  .zotero-ai-explain-sidebar__body code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.92em; padding: 0.1em 0.3em; border-radius: 3px;
    background: var(--fill-quarternary, ButtonFace);
  }
  .zotero-ai-explain-popup__body pre,
  .zotero-ai-explain-popup__turn-body pre,
  .zotero-ai-explain-sidebar__body pre {
    margin: 0.4em 0; padding: 8px 10px; border-radius: 4px;
    background: var(--fill-quarternary, ButtonFace);
    overflow-x: auto;
  }
  .zotero-ai-explain-popup__body pre code,
  .zotero-ai-explain-popup__turn-body pre code,
  .zotero-ai-explain-sidebar__body pre code {
    padding: 0; border-radius: 0; background: transparent;
  }
  .zotero-ai-explain-popup__body blockquote,
  .zotero-ai-explain-popup__turn-body blockquote,
  .zotero-ai-explain-sidebar__body blockquote {
    margin: 0.4em 0; padding: 0.2em 0.8em;
    border-left: 3px solid var(--accent-blue, Highlight);
    color: var(--fill-secondary, GrayText);
  }
  .zotero-ai-explain-popup__body a,
  .zotero-ai-explain-popup__turn-body a,
  .zotero-ai-explain-sidebar__body a {
    color: var(--accent-blue, Highlight); text-decoration: underline;
  }
`;

/**
 * Wire a focus ring to an interactive element. CSS `:focus-visible` is
 * inconsistent across Zotero's chrome contexts, so we paint the outline
 * directly via focus/blur listeners.
 */
export function applyFocusRing(element: HTMLElement, color: string = ACCENT): void {
  element.addEventListener("focus", () => {
    element.style.outline = `2px solid ${color}`;
    element.style.outlineOffset = "2px";
  });
  element.addEventListener("blur", () => {
    element.style.outline = "";
    element.style.outlineOffset = "";
  });
}

/**
 * Apply hover affordance to a non-primary button. Subtle: lift the border
 * to the accent on hover, restore on leave. Native macOS / Windows
 * controls behave this way.
 */
export function applyHoverState(button: HTMLElement): void {
  button.addEventListener("mouseenter", () => {
    button.style.borderColor = ACCENT;
  });
  button.addEventListener("mouseleave", () => {
    button.style.borderColor = "";
  });
}
