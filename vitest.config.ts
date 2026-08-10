import { defineConfig } from "vitest/config";

// Pure-module unit tests only: no DOM, no tauri invoke. Front-end tests stub
// the handful of browser globals they need (localStorage, location) via
// vi.stubGlobal rather than pulling in jsdom/happy-dom.
export default defineConfig({
  resolve: {
    alias: {
      lodash: new URL("./src/0_lodashOrderBy.ts", import.meta.url).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts", "src/**/*.test.ts", "extension/src/**/*.test.ts"],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
