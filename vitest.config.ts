import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The default test discovery picks up everything matching *.test.ts.
    // E2E tests under tests/e2e/*.e2e.test.ts are excluded here and run via
    // `npm run test:e2e` using `vitest.e2e.config.ts`.
    exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**"]
  }
});
