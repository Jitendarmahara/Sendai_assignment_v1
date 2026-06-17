import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // integration tests share 8 real Kubernetes pods/leases across files —
    // running test files in parallel causes cross-file contention
    // (NO_POD_AVAILABLE) since vitest, unlike bun:test, parallelizes files
    // by default.
    fileParallelism: false,
    setupFiles: ["./tests/setup.ts"],
  },
});
