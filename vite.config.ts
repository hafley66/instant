import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const devPort = Number(process.env.VITE_DEV_PORT || 1420);
const hmrPort = devPort + 1;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Two HTML entries: the app (index.html) and the headless drop-catcher window
  // (dropcatcher.html). The catcher is the only surface with the native Tauri
  // drag handler; the main window keeps it off so dockview tab-drag works.
  build: {
    rollupOptions: {
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
  // 2. tauri expects a fixed port, fail if that port is not available.
  // VITE_DEV_PORT lets worktrees run alongside the main dev server.
  server: {
    port: devPort,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: hmrPort,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
