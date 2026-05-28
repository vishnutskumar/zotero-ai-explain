import type { IndexingStatus } from "../indexing/indexing-status.js";
import type { OllamaSettings } from "../preferences/ollama-profile.js";
import {
  backendForChatProvider,
  backendForEmbedProvider,
  type DiscoveryBackendKind,
  type DiscoveryFetch,
  type DiscoveryResult,
  discoverModels
} from "../preferences/model-discovery.js";
import {
  PRESET_DESCRIPTORS,
  applyPreset,
  detectPreset,
  type PresetId
} from "../preferences/preset-profiles.js";
import type {
  ChatProviderKind,
  EmbedProviderKind,
  ProviderProfileSettings
} from "../preferences/provider-profile.js";
import { renderIndexControls } from "./index-controls-view.js";
import {
  BUTTON_BASE_STYLE,
  BUTTON_PRIMARY_STYLE,
  BUTTON_ROW_STYLE,
  FG_MUTED,
  FIELD_GROUP_STYLE,
  FIELD_INPUT_STYLE,
  FIELD_LABEL_STYLE,
  FORM_STACK_STYLE,
  MUTED_TEXT_STYLE,
  ROOT_STYLE,
  SECTION_BLOCK_STYLE,
  SECTION_BLURB_STYLE,
  SECTION_DIVIDER_STYLE,
  SECTION_HEADING_STYLE,
  applyFocusRing,
  applyHoverState
} from "./styles.js";

/**
 * Names of the editable inputs in the settings form. Exported so the
 * controller (`wireSettingsView`) and tests share the same source of
 * truth — a typo in either place would otherwise produce a silent no-op.
 *
 * `baseUrl` is retained for legacy callers (the e2e driver scrapes the
 * `[name="baseUrl"]` field for its log output). It is rendered as a
 * hidden input that mirrors `chatBaseUrl`, so any tooling reading it
 * sees a sensible value even though the visible form exposes the two
 * separate URLs.
 */
export const SETTINGS_FIELDS = {
  chatBaseUrl: "chatBaseUrl",
  embedBaseUrl: "embedBaseUrl",
  chatModel: "chatModel",
  embeddingModel: "embeddingModel",
  chatProvider: "chatProvider",
  embedProvider: "embedProvider",
  openaiApiKey: "openaiApiKey",
  anthropicApiKey: "anthropicApiKey",
  geminiApiKey: "geminiApiKey"
} as const;

export type SettingsField = keyof typeof SETTINGS_FIELDS;

/** Sentinel value for the "type a model name manually" dropdown option. */
export const MODEL_DROPDOWN_CUSTOM = "__custom__";

/**
 * Inline error color uses the OS system color so the dialog stays
 * theme-friendly. We never hardcode `red` because Zotero's dark theme
 * already paints CanvasText against a dark Canvas and the system
 * `Mark` / `MarkText` pair are not always available; CSS named `Mark`
 * resolves to a yellow-ish background under user-agent default style.
 * `#d70015` is Apple's "System Red" and renders legibly against both
 * Zotero's light and dark surfaces.
 */
const ERROR_COLOR = "#d70015";
const SUCCESS_COLOR = "var(--accent-green, #1d8348)";
const ERROR_TEXT_STYLE = `margin: 4px 0 0 0; font-size: 12px; color: ${ERROR_COLOR}; line-height: 1.3;`;
const STATUS_TEXT_STYLE = `margin: 0; font-size: 12px; line-height: 1.3; color: ${SUCCESS_COLOR};`;

const STATUS_PILL_BASE_STYLE =
  "display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; " +
  "border-radius: 9999px; font-size: 11px; font-weight: 500; line-height: 1.4;";
const STATUS_PILL_RUNNING_STYLE = `${STATUS_PILL_BASE_STYLE} background: rgba(29, 131, 72, 0.15); color: var(--accent-green, #1d8348);`;
const STATUS_PILL_STOPPED_STYLE = `${STATUS_PILL_BASE_STYLE} background: rgba(127, 127, 127, 0.15); color: ${FG_MUTED};`;

/** Inline-row layout for model input + dropdown + refresh button. */
const MODEL_ROW_STYLE = "display: flex; gap: 6px; align-items: stretch; flex-wrap: wrap;";
const MODEL_SELECT_STYLE = `${FIELD_INPUT_STYLE} flex: 1 1 200px; min-width: 0;`;

function makeField(name: string, labelText: string, value: string, hint?: string): HTMLElement {
  const group = document.createElement("div");
  group.className = "zotero-ai-field";
  group.dataset.field = name;
  group.setAttribute("style", FIELD_GROUP_STYLE);

  const labelId = `zotero-ai-field-${name}`;
  const label = document.createElement("label");
  label.htmlFor = labelId;
  label.textContent = labelText;
  label.setAttribute("style", FIELD_LABEL_STYLE);

  const field = document.createElement("input");
  field.id = labelId;
  field.name = name;
  field.value = value;
  field.type = "text";
  field.spellcheck = false;
  field.setAttribute("style", FIELD_INPUT_STYLE);
  applyFocusRing(field);

  const error = document.createElement("p");
  error.className = "zotero-ai-field__error";
  error.dataset.errorFor = name;
  error.setAttribute("role", "alert");
  error.setAttribute("style", ERROR_TEXT_STYLE);
  // Hidden until validation populates it so the layout doesn't reserve
  // empty space below the input.
  error.hidden = true;

  group.append(label, field);
  if (hint !== undefined && hint.length > 0) {
    const hintEl = document.createElement("p");
    hintEl.className = "zotero-ai-field__hint";
    hintEl.textContent = hint;
    hintEl.setAttribute(
      "style",
      `margin: 2px 0 0 0; font-size: 11px; color: ${FG_MUTED}; line-height: 1.3;`
    );
    group.append(hintEl);
  }
  group.append(error);
  return group;
}

/**
 * Render a model field as `input` + sibling `select` (auto-populated
 * model picker) + Refresh button. The input stays the canonical source
 * of truth — selecting a picker option simply writes into the input.
 * Choosing "Custom..." clears the picker so the user can type freely.
 *
 * The picker starts disabled with a "loading" placeholder; the wiring
 * layer kicks off a discovery fetch after mount and populates it.
 */
function makeModelField(input: {
  readonly name: string;
  readonly labelText: string;
  readonly value: string;
  readonly hint?: string;
  readonly pickerName: string;
}): HTMLElement {
  const group = document.createElement("div");
  group.className = "zotero-ai-field zotero-ai-model-field";
  group.dataset.field = input.name;
  group.setAttribute("style", FIELD_GROUP_STYLE);

  const labelId = `zotero-ai-field-${input.name}`;
  const label = document.createElement("label");
  label.htmlFor = `${labelId}__picker`;
  label.textContent = input.labelText;
  label.setAttribute("style", FIELD_LABEL_STYLE);

  const row = document.createElement("div");
  row.className = "zotero-ai-model-field__row";
  row.setAttribute("style", MODEL_ROW_STYLE);

  const picker = document.createElement("select");
  picker.id = `${labelId}__picker`;
  picker.name = input.pickerName;
  picker.dataset.role = "model-picker";
  picker.dataset.targetInput = input.name;
  picker.setAttribute("style", MODEL_SELECT_STYLE);
  applyFocusRing(picker);
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Loading models...";
  picker.append(placeholder);

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.dataset.action = "refresh-models";
  refresh.dataset.targetInput = input.name;
  refresh.textContent = "Refresh";
  refresh.setAttribute("style", BUTTON_BASE_STYLE);
  applyFocusRing(refresh);
  applyHoverState(refresh);

  row.append(picker, refresh);

  // AC-22: the canonical text input lives BELOW the row and is hidden
  // by default. paintPicker / the picker-change handler reveal it
  // inline when the user picks "Custom..." (or when the persisted
  // value isn't in the discovered model list).
  const field = document.createElement("input");
  field.id = labelId;
  field.name = input.name;
  field.value = input.value;
  field.type = "text";
  field.spellcheck = false;
  field.dataset.role = "model-custom-input";
  // Use FIELD_INPUT_STYLE directly — MODEL_INPUT_STYLE's `flex:1 1 200px`
  // was sized for the picker row (width basis). Inside the parent
  // column flex it would expand to a 200px-tall textarea-shaped box.
  field.setAttribute("style", `${FIELD_INPUT_STYLE} margin-top: 4px;`);
  field.setAttribute("aria-label", `${input.labelText} (custom)`);
  field.hidden = true;
  applyFocusRing(field);

  const error = document.createElement("p");
  error.className = "zotero-ai-field__error";
  error.dataset.errorFor = input.name;
  error.setAttribute("role", "alert");
  error.setAttribute("style", ERROR_TEXT_STYLE);
  error.hidden = true;

  // Non-fatal discovery warning surface (Ollama version-floor advisory).
  // `triggerDiscovery` writes `result.warning` into this element's
  // textContent and toggles `hidden`. Kept separate from the validation
  // error element so an "old Ollama" hint stays visible alongside a
  // successful model list and never blocks Save.
  const warning = document.createElement("p");
  warning.className = "zotero-ai-field__warning";
  warning.dataset.warningFor = input.name;
  warning.setAttribute("role", "status");
  warning.setAttribute(
    "style",
    `margin: 4px 0 0 0; font-size: 11px; color: ${FG_MUTED}; line-height: 1.3; font-style: italic;`
  );
  warning.hidden = true;

  group.append(label, row, field);
  if (input.hint !== undefined && input.hint.length > 0) {
    const hintEl = document.createElement("p");
    hintEl.className = "zotero-ai-field__hint";
    hintEl.textContent = input.hint;
    hintEl.setAttribute(
      "style",
      `margin: 2px 0 0 0; font-size: 11px; color: ${FG_MUTED}; line-height: 1.3;`
    );
    group.append(hintEl);
  }
  group.append(warning, error);
  return group;
}

function makeSelect(
  name: string,
  labelText: string,
  current: string,
  options: readonly { readonly value: string; readonly label: string }[],
  hint?: string
): HTMLElement {
  const group = document.createElement("div");
  group.className = "zotero-ai-field";
  group.dataset.field = name;
  group.setAttribute("style", FIELD_GROUP_STYLE);

  const labelId = `zotero-ai-field-${name}`;
  const label = document.createElement("label");
  label.htmlFor = labelId;
  label.textContent = labelText;
  label.setAttribute("style", FIELD_LABEL_STYLE);

  const select = document.createElement("select");
  select.id = labelId;
  select.name = name;
  select.setAttribute("style", FIELD_INPUT_STYLE);
  applyFocusRing(select);
  for (const opt of options) {
    const option = document.createElement("option");
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === current) {
      option.selected = true;
    }
    select.append(option);
  }

  const error = document.createElement("p");
  error.className = "zotero-ai-field__error";
  error.dataset.errorFor = name;
  error.setAttribute("role", "alert");
  error.setAttribute("style", ERROR_TEXT_STYLE);
  error.hidden = true;

  group.append(label, select);
  if (hint !== undefined && hint.length > 0) {
    const hintEl = document.createElement("p");
    hintEl.className = "zotero-ai-field__hint";
    hintEl.textContent = hint;
    hintEl.setAttribute(
      "style",
      `margin: 2px 0 0 0; font-size: 11px; color: ${FG_MUTED}; line-height: 1.3;`
    );
    group.append(hintEl);
  }
  group.append(error);
  return group;
}

function makePasswordField(
  name: string,
  labelText: string,
  value: string,
  hint?: string
): HTMLElement {
  const group = document.createElement("div");
  group.className = "zotero-ai-field";
  group.dataset.field = name;
  group.setAttribute("style", FIELD_GROUP_STYLE);

  const labelId = `zotero-ai-field-${name}`;
  const label = document.createElement("label");
  label.htmlFor = labelId;
  label.textContent = labelText;
  label.setAttribute("style", FIELD_LABEL_STYLE);

  const field = document.createElement("input");
  field.id = labelId;
  field.name = name;
  field.value = value;
  field.type = "password";
  field.autocomplete = "off";
  field.spellcheck = false;
  field.setAttribute("style", FIELD_INPUT_STYLE);
  applyFocusRing(field);

  const error = document.createElement("p");
  error.className = "zotero-ai-field__error";
  error.dataset.errorFor = name;
  error.setAttribute("role", "alert");
  error.setAttribute("style", ERROR_TEXT_STYLE);
  error.hidden = true;

  group.append(label, field);
  if (hint !== undefined && hint.length > 0) {
    const hintEl = document.createElement("p");
    hintEl.className = "zotero-ai-field__hint";
    hintEl.textContent = hint;
    hintEl.setAttribute(
      "style",
      `margin: 2px 0 0 0; font-size: 11px; color: ${FG_MUTED}; line-height: 1.3;`
    );
    group.append(hintEl);
  }
  group.append(error);
  return group;
}

function makeButton(action: string, label: string, primary: boolean): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = action;
  button.textContent = label;
  button.setAttribute("style", primary ? BUTTON_PRIMARY_STYLE : BUTTON_BASE_STYLE);
  applyFocusRing(button);
  if (!primary) {
    applyHoverState(button);
  }
  return button;
}

/**
 * Wrap children in a `<section>` with a divider, heading, and blurb.
 * Each settings block (Chat Backend / Embedding Backend / Local LLM
 * Proxy / Library Index) uses this for visual separation and
 * self-documenting copy.
 */
function makeSection(input: {
  readonly className: string;
  readonly heading: string;
  readonly blurb: string;
  readonly children: readonly HTMLElement[];
  readonly omitDivider?: boolean;
}): HTMLElement {
  const section = document.createElement("section");
  section.className = input.className;
  const baseStyle = `${SECTION_BLOCK_STYLE} ${input.omitDivider === true ? "" : SECTION_DIVIDER_STYLE}`;
  section.setAttribute("style", baseStyle);

  const heading = document.createElement("h3");
  heading.className = `${input.className}__heading`;
  heading.textContent = input.heading;
  heading.setAttribute("style", SECTION_HEADING_STYLE);

  const blurb = document.createElement("p");
  blurb.className = `${input.className}__blurb`;
  blurb.textContent = input.blurb;
  blurb.setAttribute("style", SECTION_BLURB_STYLE);

  section.append(heading, blurb, ...input.children);
  return section;
}

/**
 * Proxy section data the renderer consumes. Optional — when omitted
 * the dialog renders without the proxy UI (preserves the prior shape
 * for tests / hosts that don't wire the proxy lifecycle).
 */
export type ProxySettingsState = {
  readonly nodeBinaryPath: string;
  readonly serverScriptPath: string;
  readonly port: number;
  readonly running: boolean;
  /** Optional human-facing status string (e.g., last error). */
  readonly statusMessage?: string;
  /**
   * Optional spawn-failure / early-crash diagnostic. Rendered below the
   * status pill in the same red styling used by validation errors so
   * the user can actually see WHY the proxy isn't running (e.g.,
   * EADDRINUSE on port 11400). Cleared by the wiring layer on a
   * successful start.
   */
  readonly lastError?: string;
  /**
   * True iff Node auto-detection failed. Drives whether the
   * "Node binary path" field is rendered (hidden by default; revealed
   * when auto-detect produced nothing). When omitted, defaults to
   * `false` so older callers that don't surface the flag still get
   * the post-Phase-4 "hidden field" UX.
   */
  readonly nodeAutoDetectFailed?: boolean;
  /**
   * True iff the proxy lifecycle detected a foreign process on the
   * configured port and skipped its spawn. The status pill paints
   * a distinct "External" label and the Stop button is disabled (we
   * cannot kill a process we did not spawn).
   */
  readonly externallyManaged?: boolean;
  /**
   * Whether the proxy should start automatically when the plugin loads.
   * Defaults to true at the wiring layer; omitted in legacy test calls.
   */
  readonly autoStart?: boolean;
  /**
   * Optional /api/diagnostics snapshot from the running proxy. When
   * supplied, the renderer paints a "Discovered binaries" block so the
   * user can see whether codex / claude were found and which paths
   * the proxy searched (Bug B2). When undefined the block is hidden.
   */
  readonly diagnostics?: ProxyDiagnostics;
};

/**
 * Subset of the proxy's `/api/diagnostics` JSON the settings dialog
 * renders. Mirrors `ProxyDiagnostics` in wire-proxy-lifecycle but lives
 * here so the renderer doesn't pull a runtime dependency on the wire
 * module (the settings-view tests stand the dialog up on its own).
 * Codex review #2: trimmed to reduce local-info leak — see the wire
 * module for the full rationale.
 */
export type BinaryDiagnostics =
  | { readonly path: string }
  | { readonly path: null; readonly searchedCount: number };

export type ProxyDiagnostics = {
  readonly binaries: {
    readonly codex: BinaryDiagnostics;
    readonly claude: BinaryDiagnostics;
  };
  readonly path: {
    readonly enrichment: {
      readonly source: "shell" | "fallback" | "noop";
      readonly shellUsed: string | null;
      readonly addedCount: number;
    } | null;
  };
};

export type ProxySettingsFormValues = {
  readonly nodeBinaryPath: string;
  readonly serverScriptPath: string;
  readonly port: number;
};

function renderProxySection(state: ProxySettingsState): HTMLElement {
  const heading = document.createElement("h3");
  heading.className = "zotero-ai-proxy__heading";
  heading.textContent = "Local LLM Proxy";
  heading.setAttribute("style", SECTION_HEADING_STYLE);

  const blurb = document.createElement("p");
  blurb.className = "zotero-ai-proxy__blurb";
  blurb.textContent = "Required for Codex / Claude CLI presets. Skip otherwise.";
  blurb.setAttribute("style", SECTION_BLURB_STYLE);

  const statusRow = document.createElement("div");
  statusRow.className = "zotero-ai-proxy__status-row";
  statusRow.setAttribute("style", "display: flex; align-items: center; gap: 8px; flex-wrap: wrap;");

  const pill = document.createElement("span");
  pill.className = "zotero-ai-proxy__status";
  pill.dataset.role = "proxy-status";
  pill.dataset.running = state.running ? "true" : "false";
  pill.dataset.externallyManaged = state.externallyManaged === true ? "true" : "false";
  pill.textContent = renderProxyPillText(state);
  pill.setAttribute("style", state.running ? STATUS_PILL_RUNNING_STYLE : STATUS_PILL_STOPPED_STYLE);

  const message = document.createElement("p");
  message.className = "zotero-ai-proxy__message";
  message.dataset.role = "proxy-message";
  message.setAttribute("style", `margin: 0; font-size: 11px; color: ${FG_MUTED};`);
  // When the proxy is externally-managed and the wiring didn't supply a
  // statusMessage, paint a default hint explaining why the Stop button
  // is disabled.
  message.textContent =
    state.statusMessage ??
    (state.externallyManaged === true
      ? "Another process is already serving this port. The Stop button is disabled because the plugin did not spawn it."
      : "");
  message.hidden = message.textContent.length === 0;

  statusRow.append(pill, message);

  // Last-error diagnostic: rendered as a separate red paragraph below
  // the status row when the controller surfaces an unexpected-exit
  // stderr blob (Bug C — spawn errors must not be silent). The data-
  // role marker lets `updateProxyStatus` toggle visibility without
  // re-rendering the entire form.
  const errorLine = document.createElement("p");
  errorLine.className = "zotero-ai-proxy__error";
  errorLine.dataset.role = "proxy-error";
  errorLine.setAttribute(
    "style",
    `margin: 4px 0 0; font-size: 11px; color: ${ERROR_COLOR}; line-height: 1.3; white-space: pre-wrap;`
  );
  errorLine.textContent = state.lastError ?? "";
  errorLine.hidden = (state.lastError ?? "").length === 0;

  const buttons = document.createElement("div");
  buttons.className = "zotero-ai-proxy__buttons";
  buttons.setAttribute("style", BUTTON_ROW_STYLE);
  const startBtn = makeButton("start-proxy", "Start", true);
  startBtn.disabled = state.running;
  const stopBtn = makeButton("stop-proxy", "Stop", false);
  // Stop is disabled when nothing is running OR when the proxy is an
  // externally-managed process we didn't spawn (and therefore cannot
  // kill from inside the plugin).
  stopBtn.disabled = !state.running || state.externallyManaged === true;
  buttons.append(startBtn, stopBtn);

  const section = document.createElement("section");
  section.className = "zotero-ai-proxy";
  section.setAttribute("style", `${SECTION_BLOCK_STYLE} ${SECTION_DIVIDER_STYLE}`);
  section.append(heading, blurb, statusRow, errorLine, buttons);

  // AC-20: Node binary path is always visible so the user can see and
  // override the resolved path without first hitting an auto-detect
  // failure. The banner is also ALWAYS rendered (just hidden when
  // detection succeeded) so a later Detect-button click that fails
  // can reveal it — the original conditional render meant the Detect
  // handler's `banner.hidden = false` was a no-op on initial success.
  const banner = document.createElement("p");
  banner.className = "zotero-ai-proxy__node-banner";
  banner.dataset.role = "proxy-node-banner";
  banner.textContent =
    "Node not found. Install Node.js, click Detect to rescan, or paste the absolute path below.";
  banner.setAttribute(
    "style",
    `margin: 0; font-size: 11px; color: ${ERROR_COLOR}; line-height: 1.3;`
  );
  banner.hidden = state.nodeAutoDetectFailed !== true;
  section.append(banner);
  // Custom node-field layout: label on top, then a row of [input, Detect]
  // so the button sits BESIDE the input (not aligned with the label).
  const nodeGroup = document.createElement("div");
  nodeGroup.className = "zotero-ai-field zotero-ai-proxy__node";
  nodeGroup.dataset.field = "proxyNodeBinaryPath";
  nodeGroup.setAttribute("style", FIELD_GROUP_STYLE);

  const nodeLabelId = "zotero-ai-field-proxyNodeBinaryPath";
  const nodeLabel = document.createElement("label");
  nodeLabel.htmlFor = nodeLabelId;
  nodeLabel.textContent = "Node binary path";
  nodeLabel.setAttribute("style", FIELD_LABEL_STYLE);

  const nodeRow = document.createElement("div");
  nodeRow.setAttribute(
    "style",
    "display: flex; gap: 8px; align-items: stretch; flex-wrap: nowrap;"
  );

  const nodeInput = document.createElement("input");
  nodeInput.id = nodeLabelId;
  nodeInput.name = "proxyNodeBinaryPath";
  nodeInput.type = "text";
  nodeInput.value = state.nodeBinaryPath;
  nodeInput.spellcheck = false;
  nodeInput.setAttribute("style", `${FIELD_INPUT_STYLE} flex: 1 1 auto; min-width: 0;`);
  applyFocusRing(nodeInput);

  const detectBtn = makeButton("detect-node", "Detect", false);
  detectBtn.dataset.role = "proxy-detect-node";
  detectBtn.setAttribute("style", `${BUTTON_BASE_STYLE} flex: 0 0 auto;`);

  nodeRow.append(nodeInput, detectBtn);

  const nodeHint = document.createElement("p");
  nodeHint.className = "zotero-ai-field__hint";
  nodeHint.textContent = "Absolute path to a node >= 22 binary. Click Detect to rescan.";
  nodeHint.setAttribute(
    "style",
    `margin: 2px 0 0 0; font-size: 11px; color: ${FG_MUTED}; line-height: 1.3;`
  );

  nodeGroup.append(nodeLabel, nodeRow, nodeHint);
  section.append(nodeGroup);

  // Server-script path: always hidden. It is derived from the plugin's
  // install dir at runtime; users never need to override it. Hidden
  // mirror preserves the read path through `readProxyValues`.
  const hiddenScript = document.createElement("input");
  hiddenScript.type = "hidden";
  hiddenScript.name = "proxyServerScriptPath";
  hiddenScript.value = state.serverScriptPath;
  section.append(hiddenScript);

  section.append(makeField("proxyPort", "Proxy port", String(state.port)));

  // Auto-start toggle. Defaults to checked so the proxy is ready when
  // the user picks a codex/claude preset; unchecking it stops the
  // auto-spawn on plugin load (the user can still hit Start manually).
  const autoStartRow = document.createElement("label");
  autoStartRow.className = "zotero-ai-proxy__autostart";
  autoStartRow.setAttribute(
    "style",
    "display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer;"
  );
  const autoStartBox = document.createElement("input");
  autoStartBox.type = "checkbox";
  autoStartBox.name = "proxyAutoStart";
  autoStartBox.dataset.role = "proxy-autostart";
  autoStartBox.checked = state.autoStart !== false;
  applyFocusRing(autoStartBox);
  const autoStartLabel = document.createElement("span");
  autoStartLabel.textContent = "Start on Zotero launch";
  autoStartRow.append(autoStartBox, autoStartLabel);
  section.append(autoStartRow);

  if (state.diagnostics !== undefined) {
    section.append(renderProxyDiagnostics(state.diagnostics));
  }
  return section;
}

/**
 * Render the "Discovered binaries" block under the proxy section. Shows
 * codex / claude resolved paths (or "not found" with the searched list)
 * plus the PATH-enrichment provenance ("inherited from /bin/zsh login
 * shell" vs "static fallback"). The HTML is fixed shape so
 * `updateProxyDiagnostics` can update it in place after async pushes.
 */
function renderProxyDiagnostics(diagnostics: ProxyDiagnostics): HTMLElement {
  const block = document.createElement("div");
  block.className = "zotero-ai-proxy__diagnostics";
  block.dataset.role = "proxy-diagnostics";
  block.setAttribute(
    "style",
    `margin-top: 12px; padding: 8px 10px; border: 1px solid rgba(127,127,127,0.25); border-radius: 4px;`
  );

  const heading = document.createElement("p");
  heading.setAttribute(
    "style",
    `margin: 0 0 6px 0; font-size: 11px; font-weight: 600; color: ${FG_MUTED};`
  );
  heading.textContent = "Discovered CLI binaries";
  block.append(heading);

  block.append(
    renderBinaryRow("Codex CLI", "codex", diagnostics.binaries.codex, "PROXY_CODEX_BIN")
  );
  block.append(
    renderBinaryRow("Claude CLI", "claude", diagnostics.binaries.claude, "PROXY_CLAUDE_BIN")
  );
  block.append(renderPathEnrichment(diagnostics.path.enrichment));
  return block;
}

function renderBinaryRow(
  label: string,
  kind: "codex" | "claude",
  binary: BinaryDiagnostics,
  envVar: string
): HTMLElement {
  const row = document.createElement("p");
  row.dataset.role = `proxy-binary-${kind}`;
  row.setAttribute(
    "style",
    `margin: 0 0 6px 0; font-size: 11px; line-height: 1.4; color: ${FG_MUTED};`
  );
  if (binary.path !== null) {
    row.dataset.found = "true";
    row.textContent = `✓ ${label}: ${binary.path}`;
    row.style.color = "rgb(40, 130, 60)";
    return row;
  }
  row.dataset.found = "false";
  // Codex review #2: surface a count rather than the absolute paths we
  // searched. The list would otherwise leak $HOME and PATH layout to
  // any local process that could hit the proxy.
  row.textContent =
    `✗ ${label}: not found. Searched ${String(binary.searchedCount)} directories. ` +
    `Install the CLI or set ${envVar} to its absolute path.`;
  row.style.color = ERROR_COLOR;
  row.style.whiteSpace = "pre-wrap";
  return row;
}

function renderPathEnrichment(enrichment: ProxyDiagnostics["path"]["enrichment"]): HTMLElement {
  const row = document.createElement("p");
  row.dataset.role = "proxy-path-source";
  row.setAttribute(
    "style",
    `margin: 4px 0 0 0; font-size: 11px; color: ${FG_MUTED}; line-height: 1.3;`
  );
  if (enrichment === null) {
    row.textContent = "PATH: inherited from proxy launch environment.";
    return row;
  }
  if (enrichment.source === "shell" && typeof enrichment.shellUsed === "string") {
    row.textContent = `PATH: inherited from ${enrichment.shellUsed} login shell (+${String(enrichment.addedCount)} entries).`;
    return row;
  }
  if (enrichment.source === "fallback") {
    row.textContent = `PATH: shell discovery failed; using static fallback (+${String(enrichment.addedCount)} entries).`;
    return row;
  }
  row.textContent = "PATH: already complete, no enrichment needed.";
  return row;
}

const CHAT_PROVIDER_OPTIONS: readonly { value: ChatProviderKind; label: string }[] = [
  { value: "ollama", label: "Ollama (local)" },
  { value: "codex-cli", label: "Codex CLI (via proxy)" },
  { value: "claude-cli", label: "Claude CLI (via proxy)" },
  { value: "codex-api", label: "OpenAI / Codex API (direct)" },
  { value: "claude-api", label: "Anthropic Claude API (direct)" }
];

const EMBED_PROVIDER_OPTIONS: readonly { value: EmbedProviderKind; label: string }[] = [
  { value: "ollama", label: "Ollama (local)" },
  { value: "openai", label: "OpenAI (direct)" },
  { value: "gemini", label: "Google Gemini (direct)" }
];

/**
 * Render the preset dropdown at the very top of the dialog. Selecting
 * a preset populates every field below; the dropdown shifts to
 * "Custom" after any manual edit.
 */
function renderPresetSection(currentPreset: PresetId): HTMLElement {
  const heading = document.createElement("h3");
  heading.className = "zotero-ai-preset__heading";
  heading.textContent = "Preset";
  heading.setAttribute("style", SECTION_HEADING_STYLE);

  const blurb = document.createElement("p");
  blurb.className = "zotero-ai-preset__blurb";
  blurb.textContent = "One-click setup. Switches to Custom on any edit.";
  blurb.setAttribute("style", SECTION_BLURB_STYLE);

  const select = makeSelect(
    "preset",
    "Preset",
    currentPreset,
    PRESET_DESCRIPTORS.map((d) => ({ value: d.id, label: d.label }))
  );

  // First section: no top divider so the dialog opens with the preset
  // dropdown flush against the intro copy.
  const section = document.createElement("section");
  section.className = "zotero-ai-preset";
  section.setAttribute("style", SECTION_BLOCK_STYLE);
  section.append(heading, blurb, select);
  return section;
}

/**
 * Render the chat-backend section. Includes the provider selector, URL
 * field, model field with picker, and a place for the conditional
 * OpenAI / Anthropic API-key inputs.
 */
function renderChatSection(ollama: OllamaSettings, profile: ProviderProfileSettings): HTMLElement {
  const chatProvider = makeSelect(
    "chatProvider",
    "Chat backend",
    profile.chatProvider,
    CHAT_PROVIDER_OPTIONS
  );
  const chatUrl = makeField("chatBaseUrl", "Chat URL", ollama.chatBaseUrl);
  const chatModel = makeModelField({
    name: "chatModel",
    labelText: "Chat model",
    value: ollama.chatModel,
    pickerName: "chatModelPicker"
  });

  const openaiKey = makePasswordField(
    "openaiApiKey",
    "OpenAI API key",
    profile.openaiApiKey,
    "Used when chat backend = OpenAI/Codex API or embed backend = OpenAI."
  );
  openaiKey.dataset.providerKeyFor = "openai";

  const anthropicKey = makePasswordField(
    "anthropicApiKey",
    "Anthropic API key",
    profile.anthropicApiKey,
    "Used when chat backend = Claude API."
  );
  anthropicKey.dataset.providerKeyFor = "anthropic";

  return makeSection({
    className: "zotero-ai-chat-section",
    heading: "Chat Backend",
    blurb: "Backend that answers Explain / Ask requests.",
    children: [chatProvider, chatUrl, chatModel, openaiKey, anthropicKey]
  });
}

/**
 * Render the embedding-backend section.
 */
function renderEmbedSection(ollama: OllamaSettings, profile: ProviderProfileSettings): HTMLElement {
  const embedProvider = makeSelect(
    "embedProvider",
    "Embedding backend",
    profile.embedProvider,
    EMBED_PROVIDER_OPTIONS
  );
  const embedUrl = makeField("embedBaseUrl", "Embedding URL", ollama.embedBaseUrl);
  const embedModel = makeModelField({
    name: "embeddingModel",
    labelText: "Embedding model",
    value: ollama.embeddingModel,
    pickerName: "embeddingModelPicker"
  });
  const geminiKey = makePasswordField(
    "geminiApiKey",
    "Google Gemini API key",
    profile.geminiApiKey,
    "Used when embed backend = Gemini."
  );
  geminiKey.dataset.providerKeyFor = "gemini";

  return makeSection({
    className: "zotero-ai-embed-section",
    heading: "Embedding Backend",
    blurb: "Backend that builds and queries the library index.",
    children: [embedProvider, embedUrl, embedModel, geminiKey]
  });
}

/**
 * Legacy provider section — only emitted when `providerProfile` is
 * supplied AND the renderer is in the legacy-flat mode. Phase 4 cleanup
 * routes everything through the new chat / embed sections; this stays
 * exported so the `updateApiKeyVisibility` helper still finds the
 * provider-keyed rows.
 */

export function renderSettingsView(inputData: {
  readonly settings: OllamaSettings;
  readonly indexStatus: IndexingStatus;
  readonly proxy?: ProxySettingsState;
  /**
   * Optional provider profile bundle. When supplied the settings dialog
   * renders the chat/embed backend dropdowns and per-provider API key
   * fields. Omitted callers (legacy tests) get the prior dialog shape.
   */
  readonly providerProfile?: ProviderProfileSettings;
}): HTMLElement {
  const element = document.createElement("form");
  element.className = "zotero-ai-settings";
  element.setAttribute("style", `${ROOT_STYLE} ${FORM_STACK_STYLE}`);

  const intro = document.createElement("p");
  intro.className = "zotero-ai-settings__intro";
  intro.textContent = "Pick a preset for a one-click setup, or fine-tune below.";
  intro.setAttribute("style", `${MUTED_TEXT_STYLE} line-height: 1.4;`);

  const privacy = document.createElement("p");
  privacy.className = "zotero-ai-settings__privacy";
  privacy.textContent = inputData.settings.localOnly
    ? "Local only: document text stays on this machine."
    : "Online embeddings are enabled.";
  privacy.setAttribute(
    "style",
    `margin: 0; font-size: 12px; color: ${FG_MUTED}; line-height: 1.4;`
  );

  // Button row: Save (primary) + Cancel. Status text sits inline so the
  // user sees the Saved/error indicator next to the controls instead of
  // floating at the top of the dialog where the focus has moved away
  // from after a click.
  const actions = document.createElement("div");
  actions.className = "zotero-ai-settings__actions";
  actions.setAttribute("style", `${BUTTON_ROW_STYLE} align-items: center;`);

  const saveButton = makeButton("save-settings", "Save", true);
  const cancelButton = makeButton("cancel-settings", "Cancel", false);

  const status = document.createElement("p");
  status.className = "zotero-ai-settings__status";
  status.dataset.role = "status";
  status.setAttribute("style", STATUS_TEXT_STYLE);
  status.hidden = true;

  actions.append(saveButton, cancelButton, status);

  // Legacy compat: keep a hidden `baseUrl` input mirroring the chat URL
  // so the e2e driver's `[name="baseUrl"]` scrape still resolves and
  // so any external tooling reading the legacy name keeps working.
  const legacyBase = document.createElement("input");
  legacyBase.type = "hidden";
  legacyBase.name = "baseUrl";
  legacyBase.value = inputData.settings.chatBaseUrl;
  legacyBase.dataset.legacy = "true";

  element.append(intro, legacyBase);

  // Phase 4 cleanup: when providerProfile is wired the dialog uses
  // the new sectioned layout (Preset, Chat Backend, Embedding Backend,
  // Library Index, Local LLM Proxy). Legacy callers (settings tests
  // that don't supply providerProfile) get the flat layout for back-
  // compat — those tests assert against `[name="chatBaseUrl"]` /
  // `[name="embeddingModel"]` directly, so the flat layout keeps the
  // selectors valid.
  if (inputData.providerProfile !== undefined) {
    const currentPreset = detectPreset(inputData.providerProfile);
    element.append(renderPresetSection(currentPreset));
    // Proxy sits at the top so its Start/Stop pill is immediately
    // visible — the model dropdowns below read "not available" until
    // the proxy is running, and surfacing the dependency up front
    // avoids that confusion.
    if (inputData.proxy !== undefined) {
      element.append(renderProxySection(inputData.proxy));
    }
    element.append(renderChatSection(inputData.settings, inputData.providerProfile));
    element.append(renderEmbedSection(inputData.settings, inputData.providerProfile));

    const apiWarning = document.createElement("p");
    apiWarning.className = "zotero-ai-providers__warning";
    apiWarning.textContent = "API keys are stored in plain text in Zotero's preferences.";
    apiWarning.setAttribute("style", SECTION_BLURB_STYLE);
    element.append(apiWarning);

    updateApiKeyVisibility(element, {
      chatProvider: inputData.providerProfile.chatProvider,
      embedProvider: inputData.providerProfile.embedProvider
    });
  } else {
    // Legacy flat layout (preserved for tests / e2e harness without a
    // provider profile). No sections, no preset dropdown — just the
    // four flat inputs the old shape exposed.
    element.append(
      makeField("chatBaseUrl", "Chat URL", inputData.settings.chatBaseUrl),
      makeField("embedBaseUrl", "Embedding URL", inputData.settings.embedBaseUrl),
      makeField("chatModel", "Chat model", inputData.settings.chatModel),
      makeField("embeddingModel", "Embedding model", inputData.settings.embeddingModel)
    );
  }

  // Library index section: real CSS divider above. The index controls
  // already render their own heading; wrap them in a section so the
  // divider stays consistent across the dialog.
  const indexSection = document.createElement("section");
  indexSection.className = "zotero-ai-library-index";
  indexSection.setAttribute("style", `${SECTION_BLOCK_STYLE} ${SECTION_DIVIDER_STYLE}`);
  const indexHeading = document.createElement("h3");
  indexHeading.className = "zotero-ai-library-index__heading";
  indexHeading.textContent = "Library Index";
  indexHeading.setAttribute("style", SECTION_HEADING_STYLE);
  const indexBlurb = document.createElement("p");
  indexBlurb.className = "zotero-ai-library-index__blurb";
  indexBlurb.textContent = "Embeds your library for retrieval. Resumes on re-run.";
  indexBlurb.setAttribute("style", SECTION_BLURB_STYLE);
  indexSection.append(indexHeading, indexBlurb, renderIndexControls(inputData.indexStatus));

  element.append(indexSection, actions, privacy);

  // Legacy callers (no providerProfile) keep the historical order —
  // proxy section trails after the index controls. The sectioned-layout
  // branch above already injected it inside the Advanced disclosure.
  if (inputData.providerProfile === undefined && inputData.proxy !== undefined) {
    element.append(renderProxySection(inputData.proxy));
  }

  return element;
}

/**
 * Hide / show the per-provider API key inputs based on the currently
 * selected chat + embed providers. Pure DOM mutation; exported so the
 * wire-up layer can call it on every change event.
 */
export function updateApiKeyVisibility(
  root: ParentNode,
  selection: { chatProvider: ChatProviderKind; embedProvider: EmbedProviderKind }
): void {
  const requires = new Set<string>();
  if (selection.chatProvider === "codex-api") requires.add("openai");
  if (selection.embedProvider === "openai") requires.add("openai");
  if (selection.chatProvider === "claude-api") requires.add("anthropic");
  if (selection.embedProvider === "gemini") requires.add("gemini");

  for (const key of ["openai", "anthropic", "gemini"]) {
    const row = root.querySelector<HTMLElement>(`[data-provider-key-for="${key}"]`);
    if (row === null) continue;
    const show = requires.has(key);
    row.hidden = !show;
    // Also gate input.disabled so a hidden key isn't accidentally
    // collected by readValues() if the styles get reordered.
    const input = row.querySelector<HTMLInputElement>("input");
    if (input !== null) {
      input.disabled = !show;
    }
  }
}

/** Inputs read from the form. */
export type SettingsFormValues = {
  readonly chatBaseUrl: string;
  readonly embedBaseUrl: string;
  readonly chatModel: string;
  readonly embeddingModel: string;
  /** Phase 4 direct-API: provider selectors. Optional so legacy callers
   * that don't render the provider section still type-check. */
  readonly chatProvider?: ChatProviderKind;
  readonly embedProvider?: EmbedProviderKind;
  readonly openaiApiKey?: string;
  readonly anthropicApiKey?: string;
  readonly geminiApiKey?: string;
};

/** Per-field validation error. Empty `errors` array means the values are valid. */
export type SettingsValidationFailure = {
  readonly field: SettingsField | "global";
  readonly message: string;
};

export type SettingsValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly SettingsValidationFailure[] };

/**
 * Asynchronous validator. Receives the values the user typed; returns
 * an OK result or a list of per-field error messages. Validation runs
 * on every Save click — there's no debounce because the user already
 * committed when they clicked.
 */
export type SettingsValidator = (values: SettingsFormValues) => Promise<SettingsValidationResult>;

export type SettingsViewHandle = {
  detach(): void;
};

/**
 * Callbacks the host wires up when the dialog includes a proxy section.
 *
 * The renderer doesn't know how to spawn a subprocess; it only paints
 * the Start/Stop buttons and surfaces user clicks. The host (the
 * `wire-proxy-lifecycle` module in production) hands these callbacks
 * to `wireSettingsView` so each click drives the real
 * `ProxyLifecycle`.
 */
export type ProxyLifecycleCallbacks = {
  /** Read the current Node / script / port values from the form. */
  readonly readValues: () => ProxySettingsFormValues;
  readonly start: (values: ProxySettingsFormValues) => Promise<void>;
  readonly stop: () => Promise<void>;
  /**
   * Re-run Node binary detection. The wiring layer updates the form's
   * `proxyNodeBinaryPath` input with the resolved path; if detection
   * fails the input stays empty and the banner above it surfaces a
   * "still not found" hint.
   */
  readonly detect?: () => { readonly path: string; readonly autoDetectFailed: boolean };
  /**
   * Persist the autostart preference. Called on every change of the
   * "Start on Zotero launch" checkbox; the change does not spawn or
   * kill the running proxy — it only affects the next plugin load.
   */
  readonly setAutoStart?: (enabled: boolean) => void;
};

/**
 * Optional discovery callbacks for the model dropdowns. When supplied,
 * the wiring layer kicks off a fetch on mount + when the relevant URL
 * or API key changes (debounced) + on Refresh-button click. The
 * dropdown is populated from the result; `customLabel` controls the
 * trailing "type a name manually" entry.
 */
export type ModelDiscoveryCallbacks = {
  /** Fired with discovery context whenever a fetch should be issued. */
  readonly discover: (context: ModelDiscoveryContext) => Promise<DiscoveryResult>;
  /** Debounce window for URL/key change-triggered refreshes. */
  readonly debounceMs?: number;
  /** Override the global setTimeout used for debounce; tests pass a synchronous fake. */
  readonly setTimeout?: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
};

export type ModelDiscoveryContext = {
  readonly target: "chatModel" | "embeddingModel";
  readonly backend: DiscoveryBackendKind;
  readonly url: string;
  readonly apiKey: string;
};

/**
 * Wire the Save/Cancel buttons in a rendered settings view. Returns a
 * `detach()` that removes every listener so the dialog teardown leaves
 * no dangling handlers on the (about-to-be-removed) DOM tree.
 *
 * Behavior:
 *   - Save → read inputs → call `validate(values)` →
 *       on `{ok: true}`: call `onSave(values)`, flash "Saved" for `flashMs`,
 *         then invoke `close()` so the dialog disappears.
 *       on `{ok: false}`: render inline errors below the offending fields
 *         (or as a status line for `field: "global"`), keep dialog open.
 *   - Cancel → call `close()` directly. No pref writes.
 *
 * The button is disabled while validation is in flight so the user
 * can't double-submit (and so the click during the 1s flash doesn't
 * re-trigger validation against an empty form).
 */
export function wireSettingsView(input: {
  readonly view: HTMLElement;
  readonly validate: SettingsValidator;
  readonly onSave: (values: SettingsFormValues) => void;
  readonly close: () => void;
  readonly flashMs?: number;
  readonly proxy?: ProxyLifecycleCallbacks;
  /**
   * Optional clock injection. Tests pass a synchronous fake so the
   * "Saved" flash window doesn't keep them waiting; production wires
   * this to `window.setTimeout` via the host's main window.
   */
  readonly setTimeout?: (handler: () => void, ms: number) => unknown;
  /**
   * Optional model-discovery wiring. Activates the live model picker
   * + Refresh button + debounced re-fetch on URL/key changes.
   */
  readonly modelDiscovery?: ModelDiscoveryCallbacks;
}): SettingsViewHandle {
  const flashMs = input.flashMs ?? 1000;
  const scheduleClose = input.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));

  const root = input.view;
  const saveButton = root.querySelector<HTMLButtonElement>('[data-action="save-settings"]');
  const cancelButton = root.querySelector<HTMLButtonElement>('[data-action="cancel-settings"]');
  const statusEl = root.querySelector<HTMLElement>('[data-role="status"]');

  const legacyBaseInput = root.querySelector<HTMLInputElement>('[name="baseUrl"]');

  const inputs = {
    chatBaseUrl: root.querySelector<HTMLInputElement>('[name="chatBaseUrl"]'),
    embedBaseUrl: root.querySelector<HTMLInputElement>('[name="embedBaseUrl"]'),
    chatModel: root.querySelector<HTMLInputElement>('[name="chatModel"]'),
    embeddingModel: root.querySelector<HTMLInputElement>('[name="embeddingModel"]'),
    openaiApiKey: root.querySelector<HTMLInputElement>('[name="openaiApiKey"]'),
    anthropicApiKey: root.querySelector<HTMLInputElement>('[name="anthropicApiKey"]'),
    geminiApiKey: root.querySelector<HTMLInputElement>('[name="geminiApiKey"]')
  } as const;

  const selects = {
    chatProvider: root.querySelector<HTMLSelectElement>('[name="chatProvider"]'),
    embedProvider: root.querySelector<HTMLSelectElement>('[name="embedProvider"]'),
    preset: root.querySelector<HTMLSelectElement>('[name="preset"]')
  } as const;

  const errorEls = {
    chatBaseUrl: root.querySelector<HTMLElement>('[data-error-for="chatBaseUrl"]'),
    embedBaseUrl: root.querySelector<HTMLElement>('[data-error-for="embedBaseUrl"]'),
    chatModel: root.querySelector<HTMLElement>('[data-error-for="chatModel"]'),
    embeddingModel: root.querySelector<HTMLElement>('[data-error-for="embeddingModel"]'),
    chatProvider: root.querySelector<HTMLElement>('[data-error-for="chatProvider"]'),
    embedProvider: root.querySelector<HTMLElement>('[data-error-for="embedProvider"]'),
    openaiApiKey: root.querySelector<HTMLElement>('[data-error-for="openaiApiKey"]'),
    anthropicApiKey: root.querySelector<HTMLElement>('[data-error-for="anthropicApiKey"]'),
    geminiApiKey: root.querySelector<HTMLElement>('[data-error-for="geminiApiKey"]')
  } as const;

  const clearErrors = (): void => {
    for (const key of Object.keys(errorEls) as SettingsField[]) {
      const el = errorEls[key];
      if (el !== null) {
        el.textContent = "";
        el.hidden = true;
      }
    }
    if (statusEl !== null) {
      statusEl.textContent = "";
      statusEl.hidden = true;
      // Reset to the success color in case a previous error painted it red.
      statusEl.style.color = SUCCESS_COLOR;
    }
  };

  const showErrors = (errors: readonly SettingsValidationFailure[]): void => {
    for (const err of errors) {
      if (err.field === "global") {
        if (statusEl !== null) {
          statusEl.textContent = err.message;
          statusEl.hidden = false;
          statusEl.style.color = ERROR_COLOR;
        }
        continue;
      }
      const el = errorEls[err.field];
      if (el !== null) {
        el.textContent = err.message;
        el.hidden = false;
      }
    }
  };

  const readValues = (): SettingsFormValues => {
    const base = {
      chatBaseUrl: inputs.chatBaseUrl?.value.trim() ?? "",
      embedBaseUrl: inputs.embedBaseUrl?.value.trim() ?? "",
      chatModel: inputs.chatModel?.value.trim() ?? "",
      embeddingModel: inputs.embeddingModel?.value.trim() ?? ""
    };
    const optional: {
      chatProvider?: ChatProviderKind;
      embedProvider?: EmbedProviderKind;
      openaiApiKey?: string;
      anthropicApiKey?: string;
      geminiApiKey?: string;
    } = {};
    if (selects.chatProvider !== null) {
      optional.chatProvider = selects.chatProvider.value as ChatProviderKind;
    }
    if (selects.embedProvider !== null) {
      optional.embedProvider = selects.embedProvider.value as EmbedProviderKind;
    }
    if (inputs.openaiApiKey !== null) {
      optional.openaiApiKey = inputs.openaiApiKey.value.trim();
    }
    if (inputs.anthropicApiKey !== null) {
      optional.anthropicApiKey = inputs.anthropicApiKey.value.trim();
    }
    if (inputs.geminiApiKey !== null) {
      optional.geminiApiKey = inputs.geminiApiKey.value.trim();
    }
    return { ...base, ...optional };
  };

  const onSaveClick = (event: Event): void => {
    event.preventDefault();
    if (saveButton?.disabled === true) {
      return;
    }
    clearErrors();
    const values = readValues();
    // Cheap synchronous required-field check so we don't fire a network
    // request for an obviously empty form. Only the URL fields can be
    // skipped when a direct-API provider is selected — model names are
    // always required because every backend takes one.
    const missing: SettingsValidationFailure[] = [];
    const chatUrlNeeded = values.chatProvider === undefined || values.chatProvider === "ollama";
    const embedUrlNeeded = values.embedProvider === undefined || values.embedProvider === "ollama";
    if (chatUrlNeeded && values.chatBaseUrl.length === 0) {
      missing.push({ field: "chatBaseUrl", message: "Chat URL is required." });
    }
    if (embedUrlNeeded && values.embedBaseUrl.length === 0) {
      missing.push({ field: "embedBaseUrl", message: "Embedding URL is required." });
    }
    if (values.chatModel.length === 0) {
      missing.push({ field: "chatModel", message: "Chat model is required." });
    }
    if (values.embeddingModel.length === 0) {
      missing.push({ field: "embeddingModel", message: "Embedding model is required." });
    }
    // API-key gate: when a direct-API provider is selected, the
    // corresponding key field must be non-empty.
    if (values.chatProvider === "codex-api" && (values.openaiApiKey ?? "").length === 0) {
      missing.push({ field: "openaiApiKey", message: "OpenAI API key is required." });
    }
    if (values.chatProvider === "claude-api" && (values.anthropicApiKey ?? "").length === 0) {
      missing.push({ field: "anthropicApiKey", message: "Anthropic API key is required." });
    }
    if (values.embedProvider === "openai" && (values.openaiApiKey ?? "").length === 0) {
      missing.push({ field: "openaiApiKey", message: "OpenAI API key is required." });
    }
    if (values.embedProvider === "gemini" && (values.geminiApiKey ?? "").length === 0) {
      missing.push({ field: "geminiApiKey", message: "Gemini API key is required." });
    }
    if (missing.length > 0) {
      showErrors(missing);
      return;
    }
    // Mirror chat URL into the legacy hidden field so any external
    // tooling that scrapes `[name="baseUrl"]` (the e2e driver) sees the
    // value the user just confirmed.
    if (legacyBaseInput !== null) {
      legacyBaseInput.value = values.chatBaseUrl;
    }
    if (saveButton !== null) {
      saveButton.disabled = true;
    }
    void (async (): Promise<void> => {
      try {
        const result = await input.validate(values);
        if (!result.ok) {
          showErrors(result.errors);
          if (saveButton !== null) {
            saveButton.disabled = false;
          }
          return;
        }
        input.onSave(values);
        if (statusEl !== null) {
          statusEl.textContent = "Saved";
          statusEl.hidden = false;
          statusEl.style.color = SUCCESS_COLOR;
        }
        scheduleClose(() => {
          input.close();
        }, flashMs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        showErrors([{ field: "global", message: `Save failed: ${message}` }]);
        if (saveButton !== null) {
          saveButton.disabled = false;
        }
      }
    })();
  };

  const onCancelClick = (event: Event): void => {
    event.preventDefault();
    input.close();
  };

  // -----------------------------------------------------------------
  // Preset dropdown wiring. Selecting a preset overwrites every field
  // below (URLs, models, providers). Any subsequent manual edit shifts
  // the dropdown back to "custom".
  // -----------------------------------------------------------------
  const presetListeners: { el: HTMLElement; event: string; handler: EventListener }[] = [];
  const presetSelect = selects.preset;
  const onPresetChange: EventListener = () => {
    if (presetSelect === null) return;
    const id = presetSelect.value as PresetId;
    if (id === "custom") return;
    // Build a snapshot from current form fields so applyPreset can
    // preserve unrelated state (e.g. API keys the user has typed).
    const current = snapshotProfileFromForm(root);
    const next = applyPreset(id, current);
    writeProfileToForm(root, next);
    // After a preset write we must NOT shift back to Custom — the
    // applyPreset() call landed values that exactly match the preset.
    presetSelect.value = id;
    if (selects.chatProvider !== null && selects.embedProvider !== null) {
      updateApiKeyVisibility(root, {
        chatProvider: selects.chatProvider.value as ChatProviderKind,
        embedProvider: selects.embedProvider.value as EmbedProviderKind
      });
    }
    triggerDiscovery("chatModel");
    triggerDiscovery("embeddingModel");
  };
  if (presetSelect !== null) {
    presetSelect.addEventListener("change", onPresetChange);
    presetListeners.push({ el: presetSelect, event: "change", handler: onPresetChange });
  }

  /**
   * Flip the preset dropdown back to "custom" when the user edits any
   * preset-driven field. We do not call this for API-key edits — those
   * are preset-independent.
   */
  const markPresetCustom = (): void => {
    if (presetSelect !== null && presetSelect.value !== "custom") {
      presetSelect.value = "custom";
    }
  };

  // Typing into any field clears that field's inline error so the user
  // sees their next attempt has a clean slate.
  const inputListeners: { input: HTMLInputElement; handler: EventListener }[] = [];
  for (const key of Object.keys(inputs) as (keyof typeof inputs)[]) {
    const el = inputs[key];
    if (el === null) {
      continue;
    }
    const errEl = errorEls[key];
    const handler: EventListener = () => {
      if (errEl !== null && !errEl.hidden) {
        errEl.hidden = true;
        errEl.textContent = "";
      }
      // URL / model edits shift the preset to Custom. API-key edits
      // do not (they don't change which preset matches).
      if (
        key === "chatBaseUrl" ||
        key === "embedBaseUrl" ||
        key === "chatModel" ||
        key === "embeddingModel"
      ) {
        markPresetCustom();
      }
      // URL or API-key change → schedule a debounced model refresh.
      if (key === "chatBaseUrl" || key === "openaiApiKey" || key === "anthropicApiKey") {
        scheduleDiscovery("chatModel");
      }
      if (key === "embedBaseUrl" || key === "openaiApiKey" || key === "geminiApiKey") {
        scheduleDiscovery("embeddingModel");
      }
    };
    el.addEventListener("input", handler);
    inputListeners.push({ input: el, handler });
  }

  // Change listeners on the provider selectors so the API-key
  // visibility tracks live selections and so we clear stale errors.
  const selectListeners: { select: HTMLSelectElement; handler: EventListener }[] = [];
  const onSelectChange: EventListener = () => {
    const chatVal = (selects.chatProvider?.value ?? "ollama") as ChatProviderKind;
    const embedVal = (selects.embedProvider?.value ?? "ollama") as EmbedProviderKind;
    updateApiKeyVisibility(root, { chatProvider: chatVal, embedProvider: embedVal });
    markPresetCustom();
    triggerDiscovery("chatModel");
    triggerDiscovery("embeddingModel");
  };
  if (selects.chatProvider !== null) {
    selects.chatProvider.addEventListener("change", onSelectChange);
    selectListeners.push({ select: selects.chatProvider, handler: onSelectChange });
  }
  if (selects.embedProvider !== null) {
    selects.embedProvider.addEventListener("change", onSelectChange);
    selectListeners.push({ select: selects.embedProvider, handler: onSelectChange });
  }

  saveButton?.addEventListener("click", onSaveClick);
  cancelButton?.addEventListener("click", onCancelClick);

  // -----------------------------------------------------------------
  // Model discovery wiring (Fix 2).
  // -----------------------------------------------------------------
  const discovery = input.modelDiscovery;
  const debounceMs = discovery?.debounceMs ?? 500;
  const scheduleTimeout = discovery?.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  const cancelTimeout =
    discovery?.clearTimeout ??
    ((handle): void => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    });
  const pendingTimers = new Map<"chatModel" | "embeddingModel", unknown>();
  const pickerListeners: { el: HTMLElement; event: string; handler: EventListener }[] = [];

  function discoveryContextFor(
    target: "chatModel" | "embeddingModel"
  ): ModelDiscoveryContext | null {
    if (target === "chatModel") {
      const providerKind = (selects.chatProvider?.value ?? "ollama") as ChatProviderKind;
      const backend = backendForChatProvider(providerKind);
      const url = inputs.chatBaseUrl?.value.trim() ?? "";
      const apiKey =
        backend === "anthropic"
          ? (inputs.anthropicApiKey?.value.trim() ?? "")
          : backend === "openai"
            ? (inputs.openaiApiKey?.value.trim() ?? "")
            : "";
      return { target, backend, url, apiKey };
    }
    const providerKind = (selects.embedProvider?.value ?? "ollama") as EmbedProviderKind;
    const backend = backendForEmbedProvider(providerKind);
    const url = inputs.embedBaseUrl?.value.trim() ?? "";
    const apiKey =
      backend === "gemini"
        ? (inputs.geminiApiKey?.value.trim() ?? "")
        : backend === "openai"
          ? (inputs.openaiApiKey?.value.trim() ?? "")
          : "";
    return { target, backend, url, apiKey };
  }

  function paintPicker(
    target: "chatModel" | "embeddingModel",
    state:
      | { kind: "loading" }
      | { kind: "models"; models: readonly string[] }
      | { kind: "error"; message: string }
  ): void {
    const picker = root.querySelector<HTMLSelectElement>(
      `[data-role="model-picker"][data-target-input="${target}"]`
    );
    if (picker === null) return;
    picker.innerHTML = "";
    const currentValue = inputs[target]?.value.trim() ?? "";
    if (state.kind === "loading") {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Loading models...";
      picker.append(placeholder);
      picker.disabled = true;
      return;
    }
    if (state.kind === "error") {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = state.message;
      picker.append(placeholder);
      const customOpt = document.createElement("option");
      customOpt.value = MODEL_DROPDOWN_CUSTOM;
      customOpt.textContent = "Custom...";
      picker.append(customOpt);
      picker.disabled = false;
      return;
    }
    // models branch
    const valueIsKnown = state.models.includes(currentValue);
    if (state.models.length === 0) {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "No models discovered";
      picker.append(placeholder);
    } else {
      const heading = document.createElement("option");
      heading.value = "";
      heading.textContent = "Pick a model...";
      picker.append(heading);
      for (const m of state.models) {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m;
        if (m === currentValue) {
          opt.selected = true;
        }
        picker.append(opt);
      }
    }
    const customOpt = document.createElement("option");
    customOpt.value = MODEL_DROPDOWN_CUSTOM;
    customOpt.textContent = "Custom...";
    if (!valueIsKnown && currentValue.length > 0) {
      customOpt.selected = true;
    }
    picker.append(customOpt);
    picker.disabled = false;
    // AC-22: reveal the custom-text input when the persisted value
    // isn't in the discovered model list, so the user can see (and
    // edit) what's actually wired without diving into "Custom...".
    syncCustomInputVisibility(target);
  }

  /**
   * AC-22: show the canonical text input only when the picker is on
   * "Custom..." or holds an empty selection — otherwise the dropdown
   * value IS the canonical value and the input is redundant.
   */
  function syncCustomInputVisibility(target: "chatModel" | "embeddingModel"): void {
    const picker = root.querySelector<HTMLSelectElement>(
      `[data-role="model-picker"][data-target-input="${target}"]`
    );
    const field = inputs[target];
    if (picker === null || field === null) return;
    const showInput = picker.value === MODEL_DROPDOWN_CUSTOM || picker.value === "";
    field.hidden = !showInput;
  }

  function triggerDiscovery(target: "chatModel" | "embeddingModel"): void {
    if (discovery === undefined) return;
    // Skip when the layout has no model picker for this target. The
    // legacy flat layout omits pickers entirely; firing discovery
    // anyway would pollute the test fetch spy and cost a network probe.
    const picker = root.querySelector<HTMLSelectElement>(
      `[data-role="model-picker"][data-target-input="${target}"]`
    );
    if (picker === null) return;
    const ctx = discoveryContextFor(target);
    if (ctx === null) return;
    paintPicker(target, { kind: "loading" });
    // Clear any stale warning from a prior probe before the new probe lands.
    setDiscoveryWarning(target, undefined);
    void (async () => {
      try {
        const result = await discovery.discover(ctx);
        if (result.ok) {
          paintPicker(target, { kind: "models", models: result.models });
          setDiscoveryWarning(target, result.warning);
        } else {
          paintPicker(target, { kind: "error", message: result.message });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        paintPicker(target, { kind: "error", message });
      }
    })();
  }

  /**
   * Toggle the per-field warning element. Called from the discovery
   * pipeline with `result.warning` so the user sees a version-floor
   * advisory (e.g. "Ollama 0.6.6 is older than 0.10.0…") near the
   * model picker without blocking Save. Passing `undefined` clears any
   * stale message.
   */
  function setDiscoveryWarning(
    target: "chatModel" | "embeddingModel",
    message: string | undefined
  ): void {
    const el = root.querySelector<HTMLParagraphElement>(`[data-warning-for="${target}"]`);
    if (el === null) return;
    if (message === undefined || message.length === 0) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.textContent = message;
    el.hidden = false;
  }

  function scheduleDiscovery(target: "chatModel" | "embeddingModel"): void {
    if (discovery === undefined) return;
    const existing = pendingTimers.get(target);
    if (existing !== undefined) {
      cancelTimeout(existing);
    }
    const timer = scheduleTimeout(() => {
      pendingTimers.delete(target);
      triggerDiscovery(target);
    }, debounceMs);
    pendingTimers.set(target, timer);
  }

  // Refresh-button click handlers.
  for (const target of ["chatModel", "embeddingModel"] as const) {
    const refreshBtn = root.querySelector<HTMLButtonElement>(
      `[data-action="refresh-models"][data-target-input="${target}"]`
    );
    if (refreshBtn === null) continue;
    const handler: EventListener = (event) => {
      event.preventDefault();
      triggerDiscovery(target);
    };
    refreshBtn.addEventListener("click", handler);
    pickerListeners.push({ el: refreshBtn, event: "click", handler });
  }

  // Picker-change handler: selecting a non-empty, non-Custom option
  // writes the value into the canonical input. Custom option clears
  // the input + focuses it so the user can type.
  for (const target of ["chatModel", "embeddingModel"] as const) {
    const picker = root.querySelector<HTMLSelectElement>(
      `[data-role="model-picker"][data-target-input="${target}"]`
    );
    if (picker === null) continue;
    const targetInput = inputs[target];
    if (targetInput === null) continue;
    const handler: EventListener = () => {
      const v = picker.value;
      if (v === MODEL_DROPDOWN_CUSTOM) {
        targetInput.hidden = false;
        targetInput.value = "";
        targetInput.focus();
        markPresetCustom();
        return;
      }
      if (v === "") {
        // Heading row picked back — keep the input visible so user
        // can see / edit the canonical value while no option is chosen.
        targetInput.hidden = false;
        return;
      }
      targetInput.value = v;
      targetInput.hidden = true;
      // Manually-picked models invalidate the preset selection.
      markPresetCustom();
    };
    picker.addEventListener("change", handler);
    pickerListeners.push({ el: picker, event: "change", handler });
  }

  // Kick off the initial discovery pass when wiring mounts.
  if (discovery !== undefined) {
    triggerDiscovery("chatModel");
    triggerDiscovery("embeddingModel");
  }

  // -------------------------------------------------------------------------
  // Proxy section wiring. Only active when the renderer included it AND
  // the caller supplied lifecycle callbacks.
  // -------------------------------------------------------------------------
  const proxyButtons = {
    start: root.querySelector<HTMLButtonElement>('[data-action="start-proxy"]'),
    stop: root.querySelector<HTMLButtonElement>('[data-action="stop-proxy"]'),
    detect: root.querySelector<HTMLButtonElement>('[data-action="detect-node"]')
  };
  const proxyStatusEl = root.querySelector<HTMLElement>('[data-role="proxy-status"]');
  const proxyMessageEl = root.querySelector<HTMLElement>('[data-role="proxy-message"]');

  const setProxyStatus = (state: { running: boolean; port: number; message?: string }): void => {
    if (proxyStatusEl !== null) {
      proxyStatusEl.dataset.running = state.running ? "true" : "false";
      proxyStatusEl.textContent = state.running
        ? `Running on :${String(state.port)}`
        : "Not running";
      proxyStatusEl.setAttribute(
        "style",
        state.running ? STATUS_PILL_RUNNING_STYLE : STATUS_PILL_STOPPED_STYLE
      );
    }
    if (proxyButtons.start !== null) {
      proxyButtons.start.disabled = state.running;
    }
    if (proxyButtons.stop !== null) {
      proxyButtons.stop.disabled = !state.running;
    }
    if (proxyMessageEl !== null) {
      const msg = state.message ?? "";
      proxyMessageEl.textContent = msg;
      proxyMessageEl.hidden = msg.length === 0;
    }
  };

  const readProxyValues = (): ProxySettingsFormValues => {
    if (input.proxy !== undefined) {
      const fromCaller = input.proxy.readValues();
      // Caller may layer in defaults; trust their values for paths but
      // re-read the port from the live form so user edits propagate.
      const portInput = root.querySelector<HTMLInputElement>('[name="proxyPort"]');
      const portText = (portInput?.value ?? String(fromCaller.port)).trim();
      const port = Number.parseInt(portText, 10);
      return {
        nodeBinaryPath:
          root.querySelector<HTMLInputElement>('[name="proxyNodeBinaryPath"]')?.value.trim() ??
          fromCaller.nodeBinaryPath,
        serverScriptPath:
          root.querySelector<HTMLInputElement>('[name="proxyServerScriptPath"]')?.value.trim() ??
          fromCaller.serverScriptPath,
        port: Number.isFinite(port) && port > 0 ? port : fromCaller.port
      };
    }
    return {
      nodeBinaryPath: "",
      serverScriptPath: "",
      port: 0
    };
  };

  const onStartProxy = (event: Event): void => {
    event.preventDefault();
    if (input.proxy === undefined) return;
    const values = readProxyValues();
    if (proxyButtons.start !== null) {
      proxyButtons.start.disabled = true;
    }
    if (proxyMessageEl !== null) {
      proxyMessageEl.textContent = "Starting...";
      proxyMessageEl.hidden = false;
    }
    void (async () => {
      try {
        await input.proxy?.start(values);
        // Codex review #4: don't optimistically overwrite to
        // `running:true` here. The wire layer's onStateChange will
        // call `updateProxyStatus` with the AUTHORITATIVE snapshot —
        // including the externally-managed flag, the discovered-
        // binaries diagnostics, and the External pill label — and a
        // local "running:true" overwrite would briefly clobber all
        // three. The "Starting..." message remains visible until the
        // authoritative push lands.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setProxyStatus({ running: false, port: values.port, message: `Start failed: ${message}` });
      }
    })();
  };

  const onStopProxy = (event: Event): void => {
    event.preventDefault();
    if (input.proxy === undefined) return;
    const values = readProxyValues();
    if (proxyButtons.stop !== null) {
      proxyButtons.stop.disabled = true;
    }
    if (proxyMessageEl !== null) {
      proxyMessageEl.textContent = "Stopping...";
      proxyMessageEl.hidden = false;
    }
    void (async () => {
      try {
        await input.proxy?.stop();
        // Same reasoning as onStartProxy — authoritative state comes
        // through onStateChange. "Stopping..." stays visible until
        // the push lands.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setProxyStatus({ running: true, port: values.port, message: `Stop failed: ${message}` });
      }
    })();
  };

  const autoStartCheckbox = root.querySelector<HTMLInputElement>('[data-role="proxy-autostart"]');
  const onAutoStartToggle = (): void => {
    if (autoStartCheckbox === null || input.proxy?.setAutoStart === undefined) return;
    input.proxy.setAutoStart(autoStartCheckbox.checked);
  };
  autoStartCheckbox?.addEventListener("change", onAutoStartToggle);

  const onDetectNode = (event: Event): void => {
    event.preventDefault();
    const detect = input.proxy?.detect;
    if (detect === undefined) return;
    const result = detect();
    const nodeInput = root.querySelector<HTMLInputElement>('[name="proxyNodeBinaryPath"]');
    if (nodeInput !== null) {
      // On miss the wired layer returns "node"; the field reads better
      // empty so the user knows nothing was found.
      nodeInput.value = result.autoDetectFailed ? "" : result.path;
    }
    const banner = root.querySelector<HTMLElement>('[data-role="proxy-node-banner"]');
    if (banner !== null) {
      banner.hidden = !result.autoDetectFailed;
    }
  };

  proxyButtons.start?.addEventListener("click", onStartProxy);
  proxyButtons.stop?.addEventListener("click", onStopProxy);
  proxyButtons.detect?.addEventListener("click", onDetectNode);

  return {
    detach() {
      saveButton?.removeEventListener("click", onSaveClick);
      cancelButton?.removeEventListener("click", onCancelClick);
      for (const { input: el, handler } of inputListeners) {
        el.removeEventListener("input", handler);
      }
      for (const { select, handler } of selectListeners) {
        select.removeEventListener("change", handler);
      }
      for (const { el, event, handler } of presetListeners) {
        el.removeEventListener(event, handler);
      }
      for (const { el, event, handler } of pickerListeners) {
        el.removeEventListener(event, handler);
      }
      for (const handle of pendingTimers.values()) {
        cancelTimeout(handle);
      }
      pendingTimers.clear();
      proxyButtons.start?.removeEventListener("click", onStartProxy);
      proxyButtons.stop?.removeEventListener("click", onStopProxy);
      proxyButtons.detect?.removeEventListener("click", onDetectNode);
      autoStartCheckbox?.removeEventListener("change", onAutoStartToggle);
    }
  };
}

/**
 * Read the live form into a ProviderProfileSettings snapshot. Used by
 * the preset dropdown to seed `applyPreset(id, current)` so unrelated
 * fields (API keys) survive the preset write.
 */
function snapshotProfileFromForm(root: ParentNode): ProviderProfileSettings {
  const get = (name: string): string =>
    root.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value.trim() ?? "";
  const getSel = (name: string): string =>
    root.querySelector<HTMLSelectElement>(`[name="${name}"]`)?.value ?? "";
  const chat = (getSel("chatProvider") || "ollama") as ChatProviderKind;
  const embed = (getSel("embedProvider") || "ollama") as EmbedProviderKind;
  const chatBaseUrl = get("chatBaseUrl");
  const embedBaseUrl = get("embedBaseUrl");
  return {
    ollama: {
      baseUrl: chatBaseUrl,
      chatBaseUrl,
      embedBaseUrl,
      chatModel: get("chatModel"),
      embeddingModel: get("embeddingModel"),
      localOnly: true
    },
    chatProvider: chat,
    embedProvider: embed,
    openaiApiKey: get("openaiApiKey"),
    anthropicApiKey: get("anthropicApiKey"),
    geminiApiKey: get("geminiApiKey")
  };
}

/**
 * Write a ProviderProfileSettings snapshot into the live form. Used by
 * the preset dropdown after `applyPreset` resolves so every URL /
 * model / provider field reflects the chosen preset in one click.
 *
 * API keys are NOT overwritten — `applyPreset` carries them through
 * unchanged.
 */
function writeProfileToForm(root: ParentNode, profile: ProviderProfileSettings): void {
  const setInput = (name: string, value: string): void => {
    const el = root.querySelector<HTMLInputElement>(`[name="${name}"]`);
    if (el !== null) el.value = value;
  };
  const setSelect = (name: string, value: string): void => {
    const el = root.querySelector<HTMLSelectElement>(`[name="${name}"]`);
    if (el !== null) el.value = value;
  };
  setInput("chatBaseUrl", profile.ollama.chatBaseUrl);
  setInput("embedBaseUrl", profile.ollama.embedBaseUrl);
  setInput("chatModel", profile.ollama.chatModel);
  setInput("embeddingModel", profile.ollama.embeddingModel);
  setSelect("chatProvider", profile.chatProvider);
  setSelect("embedProvider", profile.embedProvider);
  // Legacy hidden baseUrl mirror tracks chat URL.
  setInput("baseUrl", profile.ollama.chatBaseUrl);
}

/**
 * Reflect a new proxy lifecycle state into an already-rendered settings
 * view. Used by `wire-proxy-lifecycle` to push asynchronous status
 * updates (process crashed, restarted) into the dialog without
 * re-rendering the form.
 */
export function updateProxyStatus(
  root: ParentNode,
  state: {
    running: boolean;
    port: number;
    message?: string;
    /** Error from the lifecycle (unexpected exit stderr). */
    lastError?: string;
    /** True iff the running proxy is a foreign process we didn't spawn. */
    externallyManaged?: boolean;
    /** Optional /api/diagnostics snapshot (Bug B2). */
    diagnostics?: ProxyDiagnostics;
  }
): void {
  const pill = root.querySelector<HTMLElement>('[data-role="proxy-status"]');
  const startBtn = root.querySelector<HTMLButtonElement>('[data-action="start-proxy"]');
  const stopBtn = root.querySelector<HTMLButtonElement>('[data-action="stop-proxy"]');
  const message = root.querySelector<HTMLElement>('[data-role="proxy-message"]');
  const errorLine = root.querySelector<HTMLElement>('[data-role="proxy-error"]');
  if (pill !== null) {
    pill.dataset.running = state.running ? "true" : "false";
    pill.dataset.externallyManaged = state.externallyManaged === true ? "true" : "false";
    pill.textContent = renderProxyPillText({
      running: state.running,
      port: state.port,
      ...(state.externallyManaged === true ? { externallyManaged: true } : {})
    });
    pill.setAttribute(
      "style",
      state.running ? STATUS_PILL_RUNNING_STYLE : STATUS_PILL_STOPPED_STYLE
    );
  }
  if (startBtn !== null) {
    startBtn.disabled = state.running;
  }
  if (stopBtn !== null) {
    stopBtn.disabled = !state.running || state.externallyManaged === true;
  }
  if (message !== null) {
    const msg =
      state.message ??
      (state.externallyManaged === true
        ? "Another process is already serving this port. The Stop button is disabled because the plugin did not spawn it."
        : "");
    message.textContent = msg;
    message.hidden = msg.length === 0;
  }
  if (errorLine !== null) {
    // Successful start clears the error; an unexpected exit (Bug C)
    // populates it. Either way the renderer mirrors the snapshot.
    const err = state.running ? "" : (state.lastError ?? "");
    errorLine.textContent = err;
    errorLine.hidden = err.length === 0;
  }
  // Diagnostics block: paint or replace under the proxy section. When
  // `diagnostics` is absent (no fetch supplied, or fetch failed) we
  // remove any prior block so the dialog never shows stale data.
  const proxySection = root.querySelector<HTMLElement>(".zotero-ai-proxy");
  const existingDiag = root.querySelector<HTMLElement>('[data-role="proxy-diagnostics"]');
  if (state.diagnostics === undefined) {
    existingDiag?.remove();
  } else if (proxySection !== null) {
    const next = renderProxyDiagnostics(state.diagnostics);
    if (existingDiag !== null) {
      existingDiag.replaceWith(next);
    } else {
      proxySection.append(next);
    }
  }
}

function renderProxyPillText(state: {
  readonly running: boolean;
  readonly port: number;
  readonly externallyManaged?: boolean;
}): string {
  if (!state.running) return "Not running";
  if (state.externallyManaged === true) return `External on :${String(state.port)}`;
  return `Running on :${String(state.port)}`;
}

/**
 * Re-export the discoverModels helper so callers wiring the dialog
 * don't have to import from two modules.
 */
export { discoverModels };
export type { DiscoveryFetch };
