import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { signalsJsx } from "@hafley66/signals/vite";
import path from "node:path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), signalsJsx()],
  resolve: {
    dedupe: ["react", "react-dom", "@hafley66/signals"],
    alias: {
      "@hafley66/boop-adapters": path.resolve(__dirname, "../hafley-rxjs/packages/boop-adapters/dist/index.js"),
      "@hafley66/marbler": path.resolve(__dirname, "../hafley-rxjs/packages/marbler/src/index.ts"),
    },
  },
  // signalsJsx rewrites JSX imports after Vite's initial HTML/module scan, so
  // the generated runtime otherwise gets discovered only after the webview has
  // loaded and Vite forces a dependency-optimization reload.
  optimizeDeps: {
    include: [
      "@hafley66/grid > @tanstack/react-table",
      "lodash",
    ],
    exclude: [
      "@hafley66/signals",
      "@hafley66/signals/react",
      "@hafley66/signals/jsx-runtime",
      "@hafley66/signals/jsx-dev-runtime",
    ],
  },
  // Two HTML entries: the app (index.html) and the headless drop-catcher window
  // (dropcatcher.html). The catcher is the only surface with the native Tauri
  // drag handler; the main window keeps it off so dockview tab-drag works.
  build: {
    // xp.css contains legacy pseudo-element selector chains that Lightning CSS
    // rejects. Preserve the published selectors without CSS minification.
    cssMinify: false,
    rolldownOptions: {
      input: {
        main: "index.html",
        dropcatcher: "dropcatcher.html",
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. avoid FSEvents' volume-wide native stream and keep generated trees
      // out of the frontend watcher
      usePolling: true,
      interval: 500,
      ignored: [
        "**/.git/**",
        "**/node_modules/**",
        "**/.pnpm-store/**",
        "**/src-tauri/**",
        "**/target/**",
        "**/.worktrees/**",
        "**/.claude/worktrees/**",
        "**/dist/**",
        "**/coverage/**",
        "**/test-results/**",
        "**/playwright-report/**",
        "**/chat_log/**",
        "**/.dl/**",
      ],
    },
  },
}));
