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

import type { IndexFile, LibraryCrawlerDeps } from "../../src/indexing/library-crawler.js";
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
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async read() {
      return stored;
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
    async clear() {
      stored = null;
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
