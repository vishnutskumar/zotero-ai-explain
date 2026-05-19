import { defineConfig } from "vitest/config";

/**
 * Local-only e2e config: runs `tests/e2e-local/**` against a real Ollama
 * daemon at `OLLAMA_BASE_URL` (default `http://localhost:11434`). Real LLM
 * inference is slow, so timeouts are larger than the fake-Ollama config.
 * CI never runs this — the suite auto-skips when Ollama is unreachable.
 */
export default defineConfig({
  test: {
    include: ["tests/e2e-local/**/*.e2e.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    teardownTimeout: 60_000,
    fileParallelism: false,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true
      }
    },
    globals: false
  }
});
