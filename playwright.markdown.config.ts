import { defineConfig } from "@playwright/test";
import real from "./playwright.real.config";

// The full Instant frontend and Rust RPC backend in both browser engines.
// WebKit exercises the focus behavior used by the macOS Tauri webview.
export default defineConfig({
  ...real,
  testMatch: ["mdzoom.spec.ts", "1_markdown-focus.spec.ts"],
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    {
      name: "webkit",
      use: { browserName: "webkit", userAgent: undefined, permissions: [], launchOptions: { args: [] } },
    },
  ],
});
