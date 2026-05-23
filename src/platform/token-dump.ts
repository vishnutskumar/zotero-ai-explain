/**
 * Diagnostic helper that reads computed CSS custom properties from the
 * Zotero main window's :root and reports which design tokens actually
 * exist in the running build. The output is consumed by the
 * `scripts/zotero-e2e/dump-tokens.mjs` harness, which parses the JSON
 * tail of `Zotero AI Explain token dump:` log lines and saves it under
 * `.forge/phases/zotero-e2e-harness/zotero9-tokens.json`.
 *
 * Pure: takes a window-like object, returns a plain JSON-serializable
 * record. No side effects, no DOM mutation.
 */

export const TOKEN_NAMES: readonly string[] = [
  "--material-background",
  "--material-toolbar",
  "--material-color",
  "--material-mix-quinary",
  "--material-mix-quaternary",
  "--material-mix-tertiary",
  "--material-button",
  "--material-control-panel",
  "--material-panedivider",
  "--material-tabline",
  "--material-sidepane",
  "--material-menu",
  "--material-tabs",
  "--material-border",
  "--material-border-quarternary",
  "--material-border-quinary",
  "--fill-primary",
  "--fill-secondary",
  "--fill-tertiary",
  "--fill-quarternary",
  "--fill-quinary",
  "--color-accent",
  "--color-foreground",
  "--color-background",
  "--color-stripe",
  "--accent-blue",
  "--accent-red",
  "--accent-yellow",
  "--accent-green",
  "--accent-azure",
  "--accent-white",
  "--font-size-h1",
  "--font-size-h2",
  "--font-size-h3",
  "--font-size-h4",
  "--font-size-h5",
  "--font-size-large",
  "--font-size-base",
  "--font-size-small",
  "--font-family-zotero",
  "--font-family",
  "--space-min",
  "--space-sm",
  "--space-md",
  "--space-lg",
  "--space-xl",
  "--radius-small",
  "--radius-medium",
  "--radius-large"
];

export type TokenDump = {
  readonly tokens: Readonly<Record<string, string | null>>;
  readonly meta: {
    readonly colorScheme: string | null;
    readonly prefersDark: boolean;
    readonly bodyBg: string | null;
    readonly bodyColor: string | null;
  };
};

type WindowLike = {
  readonly document: Document;
  matchMedia?(query: string): { readonly matches: boolean };
  getComputedStyle?(element: Element): CSSStyleDeclaration;
};

function readToken(
  getStyle: (element: Element) => CSSStyleDeclaration,
  root: Element,
  name: string
): string | null {
  const value = getStyle(root).getPropertyValue(name).trim();
  return value === "" ? null : value;
}

export function dumpZoteroTokens(mainWindow: WindowLike): TokenDump {
  const document = mainWindow.document;
  const root = document.documentElement;
  // Prefer the window's own getComputedStyle; falling back to globalThis
  // keeps tests on jsdom happy where window === globalThis is implicit.
  // The lib.dom types declare getComputedStyle as non-optional on Window,
  // but in a chrome / XUL context the platform may not expose it on the
  // sub-window we receive, so we runtime-check it.
  const candidate = (mainWindow as { getComputedStyle?: typeof getComputedStyle }).getComputedStyle;
  const getStyle =
    typeof candidate === "function"
      ? candidate.bind(mainWindow as unknown as Window)
      : typeof (globalThis as { getComputedStyle?: typeof getComputedStyle }).getComputedStyle ===
          "function"
        ? (
            globalThis as typeof globalThis & {
              getComputedStyle: typeof getComputedStyle;
            }
          ).getComputedStyle.bind(globalThis)
        : null;
  if (getStyle === null) {
    throw new Error("dumpZoteroTokens: getComputedStyle is unavailable on the main window");
  }
  const tokens: Record<string, string | null> = {};
  for (const name of TOKEN_NAMES) {
    tokens[name] = readToken(getStyle, root, name);
  }
  // `document.body` is typed as HTMLElement (non-null) by lib.dom, but at
  // runtime during chrome init it can be null. Use an unknown cast to
  // express the runtime nullability without lying to the type checker
  // about the lib.dom contract.
  const body = document.body as unknown as HTMLElement | null;
  const bodyStyle = body === null ? null : getStyle(body);
  const rootStyle = getStyle(root);
  const colorSchemeRaw = (rootStyle.colorScheme as string | undefined)?.trim() ?? "";
  return {
    tokens,
    meta: {
      colorScheme: colorSchemeRaw === "" ? null : colorSchemeRaw,
      prefersDark: mainWindow.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
      bodyBg: bodyStyle?.backgroundColor ?? null,
      bodyColor: bodyStyle?.color ?? null
    }
  };
}
