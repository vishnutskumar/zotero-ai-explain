/**
 * Public-contract re-exports for the AC3 indexing module tests.
 *
 * Tests import their type names through this file so the test source
 * has a single, named contract surface. The runtime function imports
 * still come directly from the source modules — only the TYPES are
 * funnelled here.
 *
 * Contract source: `docs/superpowers/plans/2026-05-17-real-product-pipeline.md`
 * "AC3 Interfaces" (L976-1033).
 */

export type {
  ZoteroItemLike,
  IndexedItem,
  IndexFile,
  IndexLibraryOptions,
  LibraryCrawlerDeps
} from "../../src/indexing/library-crawler.js";

export type { IndexStorage, CreateIndexStorageDeps } from "../../src/indexing/index-storage.js";

// Local convenience alias for the embedding provider shape that
// indexLibrary depends on. (Mirrors the inline shape declared inside
// `LibraryCrawlerDeps.provider`.)
export type EmbeddingProviderLike = {
  embedTexts(request: {
    readonly baseUrl: string;
    readonly model: string;
    readonly texts: readonly string[];
    readonly signal: AbortSignal;
  }): Promise<readonly (readonly number[])[]>;
};

// Local convenience alias for the io adapter shape that
// createIndexStorage depends on.
export type IndexStorageIoLike = {
  readString(path: string): Promise<string>;
  writeString(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
};
