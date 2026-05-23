/**
 * Shared stub builders for tests that instantiate
 * `createIndexingController` but do not exercise its crawler-driven
 * behavior (those live in `indexing-controller-crawler.test.ts`).
 *
 * Tests of UI views, runtime composition, and integration flows still
 * need a real `IndexingController` instance because they wire the
 * controller's listeners and actions into the surrounding code. They
 * do NOT need a real Zotero global, provider, or filesystem — those
 * are wired with minimal stubs that never get invoked because the
 * tests never call `controller.start()` (or if they do, the
 * vi.mock'd crawler resolves immediately).
 */

import {
  CURRENT_SCHEMA_VERSION,
  type IndexFile,
  type LibraryCrawlerDeps
} from "../../src/indexing/library-crawler.js";
import type { IndexStorage } from "../../src/indexing/index-storage.js";

export function stubCrawlerZotero(): LibraryCrawlerDeps["zotero"] {
  return {
    Libraries: { userLibraryID: 1 },
    Items: {
      // eslint-disable-next-line @typescript-eslint/require-await
      getAll: async () => [],
      get: () => null
    }
  };
}

export function stubCrawlerProvider(): LibraryCrawlerDeps["provider"] {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    embedTexts: async () => []
  };
}

export function stubCrawlerSettings(): LibraryCrawlerDeps["settings"] {
  return { baseUrl: "http://localhost:11434", embeddingModel: "nomic-embed-text" };
}

export function stubIndexStorage(): IndexStorage {
  let stored: IndexFile | null = null;
  let tmp: IndexFile | null = null;
  let marker = false;
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async read() {
      return stored;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async readWithMigration() {
      const schemaVersion = stored?.schemaVersion ?? 1;
      return { file: stored, migrationPending: marker || schemaVersion < CURRENT_SCHEMA_VERSION };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async readItemCount() {
      return stored === null ? 0 : Object.keys(stored.items).length;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async write(file) {
      stored = file;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async writeItem(itemKey, entry) {
      // AC-23: per-item persist. Merge into the in-memory stored
      // IndexFile so the next `read()` sees the new item.
      stored = stored ?? {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        items: {},
        indexedAt: new Date(0).toISOString()
      };
      stored = {
        ...stored,
        items: { ...stored.items, [itemKey]: entry },
        indexedAt: new Date().toISOString()
      };
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async writeTmp(file) {
      tmp = file;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async commitMigration() {
      if (tmp === null) throw new Error("no .tmp to commit");
      stored = tmp;
      tmp = null;
      marker = false;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async abandonMigration() {
      tmp = null;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async writeMarker() {
      marker = true;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async removeMarker() {
      marker = false;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async hasMarker() {
      return marker;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async clear() {
      // FINDING-4: the real `IndexStorage.clear()` removes the primary,
      // the meta sidecar, the migration `.tmp`, AND the `.migrating`
      // marker. The stub mirrors that so a controller test exercising a
      // clear-during-migration sees the same post-condition (no marker /
      // tmp survives) the production storage layer guarantees.
      stored = null;
      tmp = null;
      marker = false;
    },
    path() {
      return "/var/test-fixture/test-index.json";
    }
  };
}

/**
 * Bundle stub deps for a controller that is never actually started by
 * the test (UI/composition-flow tests). Returns an object spreadable
 * into the controller's options.
 */
export function controllerStubDeps(): {
  readonly zotero: LibraryCrawlerDeps["zotero"];
  readonly provider: LibraryCrawlerDeps["provider"];
  readonly settings: LibraryCrawlerDeps["settings"];
  readonly storage: IndexStorage;
} {
  return {
    zotero: stubCrawlerZotero(),
    provider: stubCrawlerProvider(),
    settings: stubCrawlerSettings(),
    storage: stubIndexStorage()
  };
}
