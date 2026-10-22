import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/corpus-projection.integration.test.ts"],
    exclude: ["**/node_modules/**", "reader/**"],
    testTimeout: 30_000,
  },
});
