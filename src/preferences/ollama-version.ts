/**
 * Minimum supported Ollama daemon version (semver, strict
 * `MAJOR.MINOR.PATCH`).
 *
 * Rationale: the plugin uses modern Ollama features that are only
 * reliable in 0.10.0+ — notably embedding-only models like
 * `embeddinggemma`. Ollama 0.6.6 (CI's prior pin) loaded
 * `embeddinggemma` but the `/api/embed` path rejected it intermittently
 * with `this model does not support embeddings`, surfacing as a flaky
 * release-gate CI failure. 0.10.0 is the conservative cut where the
 * embed engine stabilised for new architectures.
 *
 * Bump this value when the plugin starts depending on a newer Ollama
 * capability. The runtime probe in `checkOllamaVersion` compares the
 * daemon's reported version against this minimum and surfaces a
 * user-actionable warning in settings when it falls below.
 */
export const MIN_OLLAMA_VERSION = "0.10.0";

/**
 * Parsed strict semver triple. We deliberately reject prerelease
 * suffixes and build metadata: Ollama's `/api/version` reports
 * `MAJOR.MINOR.PATCH` (occasionally `MAJOR.MINOR.PATCH-rcN` for
 * release candidates which the plugin treats as `MAJOR.MINOR.PATCH`
 * for ordering — the `-rc` suffix is stripped before parsing).
 */
export type ParsedVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
};

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u;

/**
 * Parse a version string like `0.24.0` / `v0.24.0` / `0.24.0-rc3`.
 * Returns `null` for any input that doesn't match `MAJOR.MINOR.PATCH`
 * after stripping an optional leading `v` and an optional prerelease /
 * build-metadata suffix. Returning `null` (instead of throwing) lets
 * callers degrade to "version unknown" rather than crashing on a
 * malformed daemon response.
 */
export function parseVersion(raw: string): ParsedVersion | null {
  const match = SEMVER_PATTERN.exec(raw.trim());
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * Compare two parsed versions. Returns < 0 if `a < b`, 0 if equal,
 * > 0 if `a > b` — matching the standard comparator shape so callers
 * can drop it into `.sort()` if needed.
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/**
 * `true` when `actual` is at or above `minimum`. Pure semver compare;
 * see `parseVersion` for prerelease handling.
 */
export function isAtLeast(actual: ParsedVersion, minimum: ParsedVersion): boolean {
  return compareVersions(actual, minimum) >= 0;
}

/**
 * Outcome of a `GET /api/version` probe. The three OK shapes let
 * callers render a precise UI:
 *
 *   - `kind: "ok"` — daemon reachable AND at or above MIN_OLLAMA_VERSION.
 *   - `kind: "below-min"` — daemon reachable but reports a version
 *     older than MIN_OLLAMA_VERSION. Includes the reported version and
 *     a pre-formatted user-facing message.
 *   - `kind: "unknown"` — daemon reachable but the version string
 *     could not be parsed. We treat this as non-blocking (don't refuse
 *     the model list) but still surface a hint.
 *   - `kind: "unreachable"` — request errored / non-2xx. The model-
 *     list probe already surfaces this state separately, so this case
 *     is mostly for the unit-test contract; callers in the discovery
 *     flow don't usually need to render it.
 */
export type VersionProbeResult =
  | { readonly kind: "ok"; readonly version: string }
  | {
      readonly kind: "below-min";
      readonly version: string;
      readonly minimum: string;
      readonly message: string;
    }
  | { readonly kind: "unknown"; readonly raw: string; readonly message: string }
  | { readonly kind: "unreachable"; readonly message: string };

/**
 * Narrow fetch shape the probe needs. Mirrors the
 * `DiscoveryFetch` shape so a single fetch implementation in
 * `model-discovery.ts` covers both probes.
 */
export type VersionFetch = (
  input: string,
  init?: { readonly signal?: AbortSignal; readonly headers?: Record<string, string> }
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

/**
 * Probe `${url}/api/version` and compare against `MIN_OLLAMA_VERSION`.
 * Pure transport + parse — no UI, no settings reads. The caller
 * threads the same `fetch` and `AbortSignal` it uses for the
 * `/api/tags` model-list probe so the two probes share a timeout.
 */
export async function checkOllamaVersion(
  url: string,
  fetch: VersionFetch,
  options?: {
    readonly signal?: AbortSignal;
    readonly headers?: Record<string, string>;
  }
): Promise<VersionProbeResult> {
  const trimmed = url.endsWith("/") ? url.slice(0, -1) : url;
  let response: Awaited<ReturnType<VersionFetch>>;
  try {
    response = await fetch(`${trimmed}/api/version`, options);
  } catch (err) {
    return {
      kind: "unreachable",
      message: `Ollama version probe failed: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  if (!response.ok) {
    return {
      kind: "unreachable",
      message: `Ollama version probe returned ${String(response.status)}.`
    };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    return {
      kind: "unreachable",
      message: `Ollama version probe returned non-JSON: ${err instanceof Error ? err.message : String(err)}`
    };
  }
  if (payload === null || typeof payload !== "object") {
    return {
      kind: "unknown",
      raw: "",
      message: "Ollama /api/version returned an unexpected payload shape."
    };
  }
  const versionField = (payload as { version?: unknown }).version;
  if (typeof versionField !== "string" || versionField.length === 0) {
    return {
      kind: "unknown",
      raw: "",
      message: "Ollama /api/version did not include a version string."
    };
  }
  const parsed = parseVersion(versionField);
  if (parsed === null) {
    return {
      kind: "unknown",
      raw: versionField,
      message: `Could not parse Ollama version "${versionField}". Expected MAJOR.MINOR.PATCH.`
    };
  }
  const minimum = parseVersion(MIN_OLLAMA_VERSION);
  if (minimum === null) {
    // Defensive: a malformed MIN_OLLAMA_VERSION constant is a
    // programmer error, not a user error. Don't block the user — fall
    // through as "ok" so settings stays usable.
    return { kind: "ok", version: versionField };
  }
  if (!isAtLeast(parsed, minimum)) {
    return {
      kind: "below-min",
      version: versionField,
      minimum: MIN_OLLAMA_VERSION,
      message:
        `Ollama ${versionField} is older than ${MIN_OLLAMA_VERSION}. ` +
        `Some embedding models (e.g. embeddinggemma) require ${MIN_OLLAMA_VERSION}+ for reliable /api/embed support. ` +
        `Upgrade Ollama to ${MIN_OLLAMA_VERSION} or later for best results.`
    };
  }
  return { kind: "ok", version: versionField };
}
