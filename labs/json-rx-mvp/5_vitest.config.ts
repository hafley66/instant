import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["labs/json-rx-mvp/**/*.test.ts"],
  },
});
