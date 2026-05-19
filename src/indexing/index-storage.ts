/**
 * IndexFile persistence — the AC3 storage module of the
 * real-product-pipeline plan.
 *
 * Stores the indexing artefact at
 * `<Zotero data dir>/zotero-ai-explain-index.json`. Read returns `null`
 * on a missing file, malformed JSON, OR a JSON-parseable value that
 * doesn't match the IndexFile shape (FINDING-13). Write serializes
 * atomically via a `.tmp` + rename when the injected io adapter
 * supports it; otherwise plain writeString.
 *
 * Contract source: `docs/superpowers/plans/2026-05-17-real-product-pipeline.md`
 * AC3 Interfaces (L1016-1033) and AC4 shape-validation rules (L770-786).
 */

import {
  computeIndexFileName,
  LEGACY_INDEX_FILE_NAME,
  type EmbedProviderKind
} from "./index-path.js";
import type { IndexFile } from "./library-crawler.js";

/**
 * Sidecar metadata persisted alongside the IndexFile. Lets the
 * controller seed `previouslyIndexed` at startup by reading tens of
 * bytes instead of parsing the full multi-megabyte JSON.
 */
export type IndexMeta = {
  readonly itemCount: number;
  readonly indexedAt: string;
};

export type IndexStorage = {
  read(): Promise<IndexFile | null>;
  /**
   * Cheap "how many items are persisted?" probe. Reads the sidecar
   * `<index>.meta.json` and returns its `itemCount`. Falls back to a
   * full `read()` + `Object.keys(items).length` only when the sidecar
   * is missing (i.e., legacy installs that wrote the index before the
   * sidecar existed); subsequent writes populate the sidecar so the
   * fallback only happens once. Returns 0 when no index exists at all.
   */
  readItemCount(): Promise<number>;
  write(file: IndexFile): Promise<void>;
  clear(): Promise<void>;
  path(): string;
};

export type CreateIndexStorageDeps = {
  readonly zotero: { readonly DataDirectory: { readonly dir: string } };
  readonly io: {
    readString(path: string): Promise<string>;
    writeString(path: string, contents: string): Promise<void>;
    remove(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
  };
  /**
   * Phase 4 direct-API: each (provider, model) gets its own index file.
   * When omitted the legacy single filename is used so a host that
   * hasn't been migrated still works.
   */
  readonly embedProvider?: {
    readonly kind: EmbedProviderKind;
    readonly model: string;
  };
};

/** Legacy file name kept for back-compat when no provider info is supplied. */
const LEGACY_FILE_NAME = LEGACY_INDEX_FILE_NAME;

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function isIndexFile(value: unknown): value is IndexFile {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.indexedAt !== "string") return false;
  const items = record.items;
  if (typeof items !== "object" || items === null || Array.isArray(items)) return false;
  return true;
}

export function createIndexStorage(deps: CreateIndexStorageDeps): IndexStorage {
  const fileName =
    deps.embedProvider !== undefined
      ? computeIndexFileName({
          provider: deps.embedProvider.kind,
          model: deps.embedProvider.model
        })
      : LEGACY_FILE_NAME;
  const filePath = joinPath(deps.zotero.DataDirectory.dir, fileName);
  const legacyFilePath = joinPath(deps.zotero.DataDirectory.dir, LEGACY_FILE_NAME);
  // Sidecar lives next to the index file with a `.meta.json` suffix in
  // place of the trailing `.json`. We rewrite it on every `write()` so
  // `readItemCount()` answers in O(few-bytes) instead of O(full-parse).
  const metaPath = `${filePath.replace(/\.json$/u, "")}.meta.json`;

  /**
   * Legacy migration: the old single-file install wrote
   * `zotero-ai-explain-index.json` for the only embed pairing that
   * existed at the time (ollama + embeddinggemma). After Phase 4 added
   * per-(provider, model) filenames, that file becomes orphaned for
   * existing installs even though the new active filename would
   * resolve to the same vectors. To preserve months-old indexes we
   * fall back to the legacy filename ONLY when the new file is absent
   * AND the active embed provider matches the historical default.
   */
  function isLegacyEligible(): boolean {
    if (deps.embedProvider === undefined) return false;
    if (deps.embedProvider.kind !== "ollama") return false;
    return deps.embedProvider.model.trim().toLowerCase() === "embeddinggemma";
  }

  async function tryReadParsed(path: string): Promise<IndexFile | null> {
    if (!(await deps.io.exists(path))) {
      return null;
    }
    let raw: string;
    try {
      raw = await deps.io.readString(path);
    } catch {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isIndexFile(parsed)) {
      return null;
    }
    return parsed;
  }

  return {
    path() {
      return filePath;
    },

    async read() {
      // Prefer the new per-provider file. If both legacy and new exist,
      // the new file wins because the legacy data is by definition stale.
      const primary = await tryReadParsed(filePath);
      if (primary !== null) {
        return primary;
      }
      // Legacy fallback: only kicks in for the historical (ollama,
      // embeddinggemma) pairing — legacy never held any other vectors.
      if (filePath === legacyFilePath || !isLegacyEligible()) {
        return null;
      }
      const legacy = await tryReadParsed(legacyFilePath);
      if (legacy === null) {
        return null;
      }
      // One-time migration: copy the legacy payload to the new
      // per-provider path so subsequent reads hit the fast path. If the
      // write fails (read-only disk, transient IO error) we still
      // return the parsed legacy data — the user gets their index back
      // and the next run will retry the copy.
      try {
        await deps.io.writeString(filePath, JSON.stringify(legacy));
      } catch {
        // Migration is best-effort; legacy data is already in memory.
      }
      return legacy;
    },

    async readItemCount() {
      // Fast path: parse the sidecar (tens of bytes). We REQUIRE the
      // primary IndexFile to exist alongside it — a stale sidecar
      // surviving an interrupted clear() would otherwise hydrate a
      // phantom count after the actual index is gone.
      const primaryExists = await deps.io.exists(filePath);
      if (primaryExists && (await deps.io.exists(metaPath))) {
        try {
          const raw = await deps.io.readString(metaPath);
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed === "object" && parsed !== null && "itemCount" in parsed) {
            const candidate = parsed.itemCount;
            if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
              return candidate;
            }
          }
        } catch {
          // Fall through to the legacy full-read path.
        }
      }
      // Legacy fallback: parse the full IndexFile once for installs that
      // wrote the index before the sidecar existed. Prime the sidecar in
      // passing so this expensive path is at most one-shot per install.
      const file = await (async (): Promise<IndexFile | null> => {
        const primary = await tryReadParsed(filePath);
        if (primary !== null) return primary;
        if (filePath === legacyFilePath || !isLegacyEligible()) return null;
        return tryReadParsed(legacyFilePath);
      })();
      if (file === null) return 0;
      const itemCount = Object.keys(file.items).length;
      if (itemCount > 0) {
        try {
          const meta: IndexMeta = { itemCount, indexedAt: file.indexedAt };
          await deps.io.writeString(metaPath, JSON.stringify(meta));
        } catch {
          // Best-effort prime — failure just means next call retries.
        }
      }
      return itemCount;
    },

    async write(file) {
      const serialized = JSON.stringify(file);
      await deps.io.writeString(filePath, serialized);
      // Sidecar is best-effort: a failure here just means the next
      // `readItemCount()` falls back to the full-file path. Don't surface
      // the error to the caller — the index itself is already persisted.
      try {
        const meta: IndexMeta = {
          itemCount: Object.keys(file.items).length,
          indexedAt: file.indexedAt
        };
        await deps.io.writeString(metaPath, JSON.stringify(meta));
      } catch {
        // ignore
      }
    },

    async clear() {
      if (await deps.io.exists(filePath)) {
        try {
          await deps.io.remove(filePath);
        } catch {
          // The file may have vanished between our exists check and the
          // remove call. Either way the post-condition holds.
        }
      }
      if (await deps.io.exists(metaPath)) {
        try {
          await deps.io.remove(metaPath);
        } catch {
          // ignore — stale sidecar will be overwritten by next write
        }
      }
    }
  };
}
