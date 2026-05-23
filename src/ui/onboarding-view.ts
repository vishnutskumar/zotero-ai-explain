import {
  BORDER_HAIRLINE,
  BUTTON_BASE_STYLE,
  BUTTON_PRIMARY_STYLE,
  BUTTON_ROW_STYLE,
  FG_MUTED,
  FONT_STACK,
  FORM_STACK_STYLE,
  MUTED_TEXT_STYLE,
  ROOT_STYLE,
  STRIPE_BG,
  applyFocusRing,
  applyHoverState
} from "./styles.js";

/** Detected host platform; "unknown" falls back to a generic download link. */
export type OnboardingPlatform = "macos" | "windows" | "linux" | "unknown";

/** Onboarding state machine — `ready` is only rendered as a transient flash. */
export type OnboardingState = "ollama-missing" | "models-missing" | "ready";

export type OnboardingMissingModels = {
  readonly chat?: string;
  readonly embed?: string;
};

export type OnboardingViewInput = {
  readonly state: OnboardingState;
  readonly platform: OnboardingPlatform;
  readonly missingModels?: OnboardingMissingModels;
  readonly chatModel?: string;
  readonly embeddingModel?: string;
};

export const ONBOARDING_ACTIONS = {
  recheck: "onboarding-recheck",
  skip: "onboarding-skip",
  openSettings: "onboarding-open-settings"
} as const;

const COPY_ACTION_PREFIX = "onboarding-copy-";
const DEFAULT_CHAT_MODEL = "gemma4:e2b";
const DEFAULT_EMBEDDING_MODEL = "embeddinggemma";
const DOWNLOAD_GENERIC = "https://ollama.com/download";
const DOWNLOAD_MAC = "https://ollama.com/download/Ollama-darwin.zip";
const DOWNLOAD_WIN = "https://ollama.com/download/OllamaSetup.exe";

const CODE_BLOCK_STYLE =
  `display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 4px; ` +
  `background: ${STRIPE_BG}; border: 1px solid ${BORDER_HAIRLINE}; ` +
  `font-family: ui-monospace, "SF Mono", "Cascadia Code", "Consolas", monospace; ` +
  `font-size: 12px; line-height: 1.4;`;
const CODE_TEXT_STYLE = `flex: 1 1 auto; white-space: pre-wrap; word-break: break-all;`;
const COPY_BUTTON_STYLE = `${BUTTON_BASE_STYLE} font-size: 11px; padding: 4px 8px;`;
const LINK_STYLE = `color: var(--accent-blue, Highlight); text-decoration: underline; cursor: pointer; font-family: ${FONT_STACK};`;
const SECTION_HEADING = `margin: 0; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: ${FG_MUTED};`;

/**
 * Render the first-run onboarding dialog body. Pure: returns an
 * HTMLElement, no listeners attached. Callers bind clipboard /
 * launchURL / Re-check behaviour via `wireOnboardingView`.
 */
export function renderOnboardingView(input: OnboardingViewInput): HTMLElement {
  const root = document.createElement("section");
  root.className = "zotero-ai-onboarding";
  root.setAttribute("style", `${ROOT_STYLE} ${FORM_STACK_STYLE}`);
  root.dataset.state = input.state;
  root.dataset.platform = input.platform;

  root.append(renderLede(input.state));
  if (input.state === "ollama-missing") {
    root.append(renderInstallPanel(input.platform));
  }
  if (input.state !== "ready") {
    root.append(renderPullPanel(input));
  }
  root.append(renderPrivacyNote(), renderActions(), renderStatusLine());
  return root;
}

function renderLede(state: OnboardingState): HTMLElement {
  const lede = document.createElement("p");
  lede.className = "zotero-ai-onboarding__lede";
  lede.setAttribute("style", "margin: 0; line-height: 1.5;");
  if (state === "ollama-missing") {
    lede.textContent =
      "Zotero AI Explain needs Ollama — a local AI model runner — to summarise highlighted text " +
      "and chat about your library. Install it once and the plugin will keep everything on this " +
      "machine.";
  } else if (state === "models-missing") {
    lede.textContent =
      "Ollama is running, but the models this plugin uses aren't pulled yet. Run the commands " +
      "below to download them; each is a one-time setup step.";
  } else {
    lede.textContent = "Ollama is ready. Closing this dialog…";
  }
  return lede;
}

function renderInstallPanel(platform: OnboardingPlatform): HTMLElement {
  const panel = makeSection("zotero-ai-onboarding__install", "Install Ollama");
  panel.dataset.platform = platform;
  if (platform === "macos") {
    panel.append(
      makeCodeBlock("install", "brew install ollama"),
      makeLinkParagraph("Prefer a notarised installer?", DOWNLOAD_MAC)
    );
  } else if (platform === "linux") {
    panel.append(makeCodeBlock("install", "curl -fsSL https://ollama.com/install.sh | sh"));
  } else if (platform === "windows") {
    panel.append(makeLinkParagraph("Download the Windows installer", DOWNLOAD_WIN));
  } else {
    panel.append(makeLinkParagraph("Choose your platform on ollama.com", DOWNLOAD_GENERIC));
  }
  return panel;
}

function renderPullPanel(input: OnboardingViewInput): HTMLElement {
  const panel = makeSection("zotero-ai-onboarding__pull", "Pull the models");
  const chatModel = input.chatModel ?? DEFAULT_CHAT_MODEL;
  const embedModel = input.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  // When the server is reachable but only some models are missing, scope
  // commands to those models only. When Ollama itself is missing, emit both.
  const showChat = input.state === "ollama-missing" || input.missingModels?.chat !== undefined;
  const showEmbed = input.state === "ollama-missing" || input.missingModels?.embed !== undefined;
  if (showChat) panel.append(makeCodeBlock("chat", `ollama pull ${chatModel}`));
  if (showEmbed) panel.append(makeCodeBlock("embed", `ollama pull ${embedModel}`));
  return panel;
}

function makeSection(className: string, headingText: string): HTMLElement {
  const panel = document.createElement("section");
  panel.className = className;
  panel.setAttribute("style", "display: flex; flex-direction: column; gap: 6px;");
  const heading = document.createElement("h3");
  heading.textContent = headingText;
  heading.setAttribute("style", SECTION_HEADING);
  panel.append(heading);
  return panel;
}

function renderPrivacyNote(): HTMLElement {
  const note = document.createElement("p");
  note.className = "zotero-ai-onboarding__privacy";
  note.setAttribute("style", `${MUTED_TEXT_STYLE} line-height: 1.4;`);
  note.textContent = "Document text stays on your machine; Ollama runs locally.";
  return note;
}

function renderActions(): HTMLElement {
  const row = document.createElement("div");
  row.className = "zotero-ai-onboarding__actions";
  row.setAttribute("style", `${BUTTON_ROW_STYLE} align-items: center;`);
  row.append(
    makeButton(ONBOARDING_ACTIONS.recheck, "Re-check", true),
    makeButton(ONBOARDING_ACTIONS.skip, "Skip for now", false),
    makeButton(ONBOARDING_ACTIONS.openSettings, "Open Settings", false)
  );
  return row;
}

function renderStatusLine(): HTMLElement {
  const status = document.createElement("p");
  status.className = "zotero-ai-onboarding__status";
  status.dataset.role = "onboarding-status";
  status.setAttribute(
    "style",
    `margin: 0; font-size: 12px; line-height: 1.3; color: var(--accent-green, #1d8348);`
  );
  status.hidden = true;
  return status;
}

function makeCodeBlock(key: string, code: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "zotero-ai-onboarding__code";
  wrapper.dataset.codeKey = key;
  wrapper.setAttribute("style", CODE_BLOCK_STYLE);
  const text = document.createElement("code");
  text.className = "zotero-ai-onboarding__code-text";
  text.setAttribute("style", CODE_TEXT_STYLE);
  text.dataset.copyText = code;
  text.textContent = code;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.dataset.action = `${COPY_ACTION_PREFIX}${key}`;
  copy.setAttribute("aria-label", `Copy: ${code}`);
  copy.textContent = "Copy";
  copy.setAttribute("style", COPY_BUTTON_STYLE);
  applyFocusRing(copy);
  applyHoverState(copy);
  wrapper.append(text, copy);
  return wrapper;
}

function makeLinkParagraph(label: string, href: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "zotero-ai-onboarding__link";
  p.setAttribute("style", "margin: 0; font-size: 12px; line-height: 1.4;");
  const link = document.createElement("a");
  link.dataset.action = "onboarding-link";
  link.dataset.href = href;
  link.href = href;
  link.textContent = label;
  link.setAttribute("style", LINK_STYLE);
  applyFocusRing(link);
  p.append(link);
  return p;
}

function makeButton(action: string, label: string, primary: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = action;
  button.textContent = label;
  button.setAttribute("style", primary ? BUTTON_PRIMARY_STYLE : BUTTON_BASE_STYLE);
  applyFocusRing(button);
  if (!primary) applyHoverState(button);
  return button;
}

/** Outcome of one Ollama probe. */
export type OllamaProbeResult =
  | { readonly state: "ready" }
  | { readonly state: "ollama-missing"; readonly reason: string }
  | { readonly state: "models-missing"; readonly missing: OnboardingMissingModels };

/**
 * GET ${baseUrl}/api/tags with `timeoutMs` (default 1500). Parses the
 * `{ models: [{ name }] }` payload; missing entries become `missing.chat`
 * / `missing.embed`. Returns "ready" only when both models are present.
 */
export async function probeOllamaForOnboarding(input: {
  readonly baseUrl: string;
  readonly chatModel: string;
  readonly embeddingModel: string;
  readonly fetch: (
    url: string,
    init?: { readonly signal?: AbortSignal }
  ) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;
  readonly timeoutMs?: number;
}): Promise<OllamaProbeResult> {
  const timeoutMs = input.timeoutMs ?? 1500;
  let url: string;
  try {
    url = new URL("/api/tags", input.baseUrl).toString();
  } catch {
    return { state: "ollama-missing", reason: "invalid-base-url" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  let payload: unknown;
  try {
    const response = await input.fetch(url, { signal: controller.signal });
    if (!response.ok)
      return { state: "ollama-missing", reason: `status ${String(response.status)}` };
    payload = await response.json();
  } catch (err) {
    return { state: "ollama-missing", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
  const names = extractModelNames(payload);
  const chatMissing = !names.includes(input.chatModel);
  const embedMissing = !names.includes(input.embeddingModel);
  if (!chatMissing && !embedMissing) return { state: "ready" };
  const missing: OnboardingMissingModels = {
    ...(chatMissing ? { chat: input.chatModel } : {}),
    ...(embedMissing ? { embed: input.embeddingModel } : {})
  };
  return { state: "models-missing", missing };
}

function extractModelNames(payload: unknown): readonly string[] {
  if (payload === null || typeof payload !== "object") return [];
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const out: string[] = [];
  for (const entry of models) {
    if (entry === null || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) out.push(name);
  }
  return out;
}

/**
 * Detect host platform via Services.appinfo.OS (Darwin / WINNT / Linux)
 * with fallbacks to Zotero.oscpu and Zotero.platformVersion. "unknown"
 * if no signal can be classified.
 */
export function detectPlatform(host: {
  readonly Zotero?: { readonly platformVersion?: unknown; readonly oscpu?: unknown };
  readonly Services?: { readonly appinfo?: { readonly OS?: unknown } };
}): OnboardingPlatform {
  try {
    for (const source of [
      host.Services?.appinfo?.OS,
      host.Zotero?.oscpu,
      host.Zotero?.platformVersion
    ]) {
      const str = typeof source === "string" && source.length > 0 ? source : null;
      if (str === null) continue;
      const classified = classify(str);
      if (classified !== "unknown") return classified;
    }
  } catch {
    return "unknown";
  }
  return "unknown";
}

function classify(raw: string): OnboardingPlatform {
  const v = raw.toLowerCase();
  if (v.includes("darwin") || v.includes("mac")) return "macos";
  if (v.includes("winnt") || v.includes("windows") || v.includes("win32")) return "windows";
  if (v.includes("linux")) return "linux";
  return "unknown";
}

export type OnboardingSideEffects = {
  readonly copyToClipboard: (text: string) => Promise<void>;
  readonly launchUrl: (url: string) => void;
  readonly recheck: () => Promise<OllamaProbeResult>;
  readonly close: () => void;
  readonly openSettings: () => void;
  readonly setTimeout?: (handler: () => void, ms: number) => unknown;
  readonly readyFlashMs?: number;
};

export type OnboardingViewHandle = { detach(): void };

/**
 * Bind the three primary action buttons + every copy button + every
 * external link in a rendered view to its side effects. On a Re-check
 * that returns `models-missing`, the view is rebuilt in place so the
 * user keeps the same dialog frame.
 */
export function wireOnboardingView(input: {
  readonly view: HTMLElement;
  readonly effects: OnboardingSideEffects;
}): OnboardingViewHandle {
  const { effects, view } = input;
  const cleanup: (() => void)[] = [];
  const bind = (target: HTMLElement | null, event: string, handler: EventListener): void => {
    if (target === null) return;
    target.addEventListener(event, handler);
    cleanup.push(() => {
      target.removeEventListener(event, handler);
    });
  };
  const schedule = (handler: () => void, ms: number): unknown =>
    (effects.setTimeout ?? ((h, m) => setTimeout(h, m)))(handler, ms);

  for (const button of Array.from(
    view.querySelectorAll<HTMLButtonElement>('[data-action^="onboarding-copy-"]')
  )) {
    bind(button, "click", (event) => {
      event.preventDefault();
      const codeEl = button.parentElement?.querySelector<HTMLElement>(
        ".zotero-ai-onboarding__code-text"
      );
      const code = codeEl?.dataset.copyText ?? codeEl?.textContent ?? "";
      void effects
        .copyToClipboard(code)
        .then(() => {
          button.textContent = "Copied";
          schedule(() => {
            button.textContent = "Copy";
          }, 1500);
        })
        .catch(() => undefined);
    });
  }

  for (const link of Array.from(
    view.querySelectorAll<HTMLAnchorElement>('[data-action="onboarding-link"]')
  )) {
    const href = link.dataset.href ?? link.href;
    bind(link, "click", (event) => {
      event.preventDefault();
      effects.launchUrl(href);
    });
  }

  const recheck = view.querySelector<HTMLButtonElement>(
    `[data-action="${ONBOARDING_ACTIONS.recheck}"]`
  );
  const skip = view.querySelector<HTMLButtonElement>(`[data-action="${ONBOARDING_ACTIONS.skip}"]`);
  const settings = view.querySelector<HTMLButtonElement>(
    `[data-action="${ONBOARDING_ACTIONS.openSettings}"]`
  );
  const status = view.querySelector<HTMLElement>('[data-role="onboarding-status"]');

  bind(skip, "click", (event) => {
    event.preventDefault();
    effects.close();
  });
  bind(settings, "click", (event) => {
    event.preventDefault();
    effects.openSettings();
  });
  bind(recheck, "click", (event) => {
    event.preventDefault();
    if (recheck?.disabled === true) return;
    if (recheck !== null) recheck.disabled = true;
    if (status !== null) {
      status.textContent = "Re-checking…";
      status.hidden = false;
    }
    void effects
      .recheck()
      .then((result) => {
        if (result.state === "ready") {
          if (status !== null) {
            status.textContent = "Ready!";
            status.hidden = false;
          }
          schedule(() => {
            effects.close();
          }, effects.readyFlashMs ?? 800);
          return;
        }
        const platform = (view.dataset.platform as OnboardingPlatform | undefined) ?? "unknown";
        const nextView = renderOnboardingView({
          state: result.state,
          platform,
          ...(result.state === "models-missing" ? { missingModels: result.missing } : {})
        });
        view.replaceChildren(...Array.from(nextView.children));
        view.dataset.state = result.state;
        for (const dispose of cleanup) dispose();
        cleanup.length = 0;
        const rewired = wireOnboardingView({ view, effects });
        cleanup.push(() => {
          rewired.detach();
        });
      })
      .catch(() => {
        if (status !== null) {
          status.textContent = "Could not reach Ollama. Try again.";
          status.hidden = false;
        }
      })
      .finally(() => {
        if (recheck !== null) recheck.disabled = false;
      });
  });

  return {
    detach() {
      for (const dispose of cleanup) dispose();
      cleanup.length = 0;
    }
  };
}
