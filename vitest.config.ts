import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { signalsJsx } from "@hafley66/signals/vite";
import type { Plugin } from "vite";

const gridLodashOrderBy: Plugin = {
  name: "instant-grid-lodash-order-by",
  enforce: "pre",
  resolveId(source, importer) {
    if (source !== "lodash" || !importer?.includes("@hafley66/grid")) return null;
    return new URL("./src/0_lodashOrderBy.ts", import.meta.url).pathname;
  },
};

// Pure-module unit tests only: no DOM, no tauri invoke. Front-end tests stub
// the handful of browser globals they need (localStorage, location) via
// vi.stubGlobal rather than pulling in jsdom/happy-dom.
export default defineConfig({
  plugins: [gridLodashOrderBy, react(), signalsJsx()],
  test: {
    environment: "node",
    include: ["scripts/**/*.test.ts", "src/**/*.test.ts", "src/**/*.test.tsx", "extension/src/**/*.test.ts"],
    restoreMocks: true,
    unstubGlobals: true,
    // marbler's dist side-effect-imports its css; inlining routes that through
    // vite's transform, which stubs it, instead of node's ESM loader, which
    // rejects the .css extension.
    server: { deps: { inline: [/@hafley66\/marbler/] } },
  },
});
