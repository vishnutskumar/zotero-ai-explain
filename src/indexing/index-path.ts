/**
 * Per-embedding-provider index file naming (Phase 4 direct-API).
 *
 * The persisted IndexFile shape is identical across providers, but the
 * vector dimensions differ:
 *   ollama / embeddinggemma            — 768
 *   openai / text-embedding-3-large    — 3072
 *   openai / text-embedding-3-small    — 1536
 *   gemini / text-embedding-004        — 768
 *
 * Mixing vectors from different providers in one file would silently
 * corrupt cosine-similarity scores. Instead each (provider, model) pair
 * gets its own file:
 *
 *   <dataDir>/zotero-ai-explain-index-ollama-embeddinggemma.json
 *   <dataDir>/zotero-ai-explain-index-openai-3-large.json
 *   <dataDir>/zotero-ai-explain-index-openai-3-small.json
 *   <dataDir>/zotero-ai-explain-index-gemini-004.json
 *
 * Switching providers in settings flips the active path; the previously
 * persisted index files stay on disk so the user can switch back
 * without re-indexing. The legacy `zotero-ai-explain-index.json` name
 * is preserved as a back-compat alias for "ollama / embeddinggemma" so
 * existing installs don't lose their indexed library.
 */

export type EmbedProviderKind = "ollama" | "openai" | "gemini";

export type IndexPathInput = {
  readonly provider: EmbedProviderKind;
  /** Raw model identifier as it appears in settings. */
  readonly model: string;
};

const FILE_PREFIX = "zotero-ai-explain-index";
const LEGACY_FILE_NAME = `${FILE_PREFIX}.json`;

/**
 * Reduce verbose model strings to a stable short slug. Keeps filenames
 * readable on disk and avoids leaking characters that are unsafe on
 * Windows (`:` from Ollama's `name:tag` notation).
 *
 * Rules:
 *   - Strip the `text-embedding-` / `embedding-` / `models/` prefixes
 *     (they're redundant given the provider is already in the filename).
 *   - Strip an Ollama `:tag` suffix (the model is enough; users rarely
 *     switch tags in the same install).
 *   - Lower-case + replace any non-[a-z0-9-] run with a single dash.
 */
export function slugifyModel(model: string): string {
  const trimmed = model.trim();
  if (trimmed.length === 0) return "default";
  let result = trimmed.toLowerCase();
  // Strip noisy prefixes.
  result = result.replace(/^models\//u, "");
  result = result.replace(/^text-embedding-/u, "");
  result = result.replace(/^embedding-/u, "");
  // Strip Ollama tag.
  const colon = result.indexOf(":");
  if (colon >= 0) {
    result = result.substring(0, colon);
  }
  // Replace unsafe runs.
  result = result.replace(/[^a-z0-9-]+/gu, "-");
  // Trim leading/trailing dashes.
  result = result.replace(/^-+|-+$/gu, "");
  return result.length === 0 ? "default" : result;
}

/**
 * Build the bare filename (no directory) for the given provider+model.
 * Exported separately from `computeIndexPath` so callers that already
 * know the directory (and want to compose their own path joining) can
 * skip the join.
 */
export function computeIndexFileName(input: IndexPathInput): string {
  return `${FILE_PREFIX}-${input.provider}-${slugifyModel(input.model)}.json`;
}

function joinDir(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/**
 * Compute the absolute path the IndexStorage should read/write for the
 * given embedding provider and model. Pure — no IO.
 */
export function computeIndexPath(dataDir: string, input: IndexPathInput): string {
  return joinDir(dataDir, computeIndexFileName(input));
}

/**
 * Build the bare DIRECTORY name (no parent) for the per-(provider,model)
 * index. AC-23: the long-term fix for the indexing OOM splits the
 * monolithic IndexFile into one file per item under this directory, so
 * each persist is O(1) instead of O(N) per item / O(N²) over a crawl.
 *
 * The directory name is intentionally the same base string as the
 * single-file name without the trailing `.json` — the legacy single-file
 * sits alongside the directory during the back-compat transition (read()
 * prefers the directory; falls back to the file when the directory is
 * absent). For the (ollama, embeddinggemma) historical pairing the legacy
 * `zotero-ai-explain-index.json` is the file name AND
 * `zotero-ai-explain-index-ollama-embeddinggemma/` is the new directory.
 */
export function computeIndexDirName(input: IndexPathInput): string {
  return `${FILE_PREFIX}-${input.provider}-${slugifyModel(input.model)}`;
}

/**
 * Compute the per-item file name within an index directory. AC-23:
 * `<itemKey>.json`. Item keys are Zotero's 8-character base-32 keys
 * (`[A-Z0-9]{8}` in practice), which are filesystem-safe across macOS,
 * Linux, and Windows. Reserved names (`_meta.json`) are guarded by the
 * storage layer (item keys can never collide with the reserved meta file
 * because Zotero keys are uppercase and `_meta` has a leading underscore).
 */
export function computeItemFileName(itemKey: string): string {
  return `${itemKey}.json`;
}

/**
 * Reserved meta file name inside an index directory. Holds
 * `{ schemaVersion, indexedAt, itemCount }` so `readItemCount()` answers
 * in O(few-bytes) instead of enumerating the whole directory. The
 * leading underscore guarantees no Zotero item key (uppercase
 * alphanumeric) collides with this name.
 */
export const META_FILE_NAME = "_meta.json";

/**
 * Inverse: given a path or filename, recover the (provider, modelSlug)
 * that produced it. Returns null when the filename doesn't match the
 * expected pattern. Used by diagnostics + the settings "Switched to X
 * — already indexed" hint.
 */
export function parseIndexPath(
  pathOrName: string
): { readonly provider: EmbedProviderKind; readonly modelSlug: string } | null {
  // Strip a directory prefix if present.
  const lastSlash = pathOrName.lastIndexOf("/");
  const name = lastSlash >= 0 ? pathOrName.substring(lastSlash + 1) : pathOrName;
  // Pattern: zotero-ai-explain-index-<provider>-<rest>.json
  // `provider` is one of the known kinds; `rest` is the slug.
  const match = /^zotero-ai-explain-index-([a-z]+)-(.+)\.json$/u.exec(name);
  if (match === null) return null;
  const providerToken = match[1];
  const slug = match[2];
  if (providerToken === undefined || slug === undefined) return null;
  if (providerToken !== "ollama" && providerToken !== "openai" && providerToken !== "gemini") {
    return null;
  }
  return { provider: providerToken, modelSlug: slug };
}

/**
 * Back-compat: the legacy single-file install used `zotero-ai-explain-index.json`.
 * When the new per-provider file for ollama+embeddinggemma is absent
 * but the legacy file exists, callers can rename it instead of asking
 * the user to re-index. Exported separately so the IndexStorage doesn't
 * need to know the provider rules.
 */
export const LEGACY_INDEX_FILE_NAME = LEGACY_FILE_NAME;

export function legacyIndexPath(dataDir: string): string {
  return joinDir(dataDir, LEGACY_FILE_NAME);
}
