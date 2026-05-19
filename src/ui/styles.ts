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
