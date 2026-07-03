import { defineConfig } from "vitest/config";

// Pure-module unit tests only: no DOM, no tauri invoke. Front-end tests stub
// the handful of browser globals they need (localStorage, location) via
// vi.stubGlobal rather than pulling in jsdom/happy-dom.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
