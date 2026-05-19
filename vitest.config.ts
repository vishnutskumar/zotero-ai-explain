import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The default test discovery picks up everything matching *.test.ts.
    // E2E tests under tests/e2e/*.e2e.test.ts are excluded here and run via
    // `npm run test:e2e` using `vitest.e2e.config.ts`.
    exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**"],
    coverage: {
      // v8 (Node-native) is faster than istanbul, doesn't require source
      // transforms, and gives accurate line/branch counts for our ESM-
      // heavy codebase. Istanbul's per-file `[/* istanbul ignore */]`
      // pragmas wouldn't survive prettier+eslint without churn anyway.
      provider: "v8",
      include: ["src/**/*.ts", "scripts/llm-proxy/**/*.mjs"],
      exclude: [
        // Test scaffolding never produces useful coverage signal.
        "tests/**",
        // Type-only declaration files: vitest can't run them.
        "**/*.d.ts",
        "**/*.d.mts",
        // Build/staging artefacts and dist output.
        "addon/**",
        "dist/**",
        "**/node_modules/**",
        // E2E driver lives in src/ but is exercised by the real-Zotero
        // suite (not the unit run), so excluding keeps the local gate
        // honest about what the unit tests actually cover.
        "src/platform/e2e-driver.ts"
      ],
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "coverage",
      // Snapshot only — `npm run test:coverage` is the artifact producer.
      // The 80% gate is enforced by `scripts/precommit-coverage.mjs`
      // reading `coverage/coverage-summary.json` (clearer error output
      // than vitest's bare threshold failure, and easier to tune
      // per-file thresholds later).
      reportOnFailure: true
    }
  }
});
