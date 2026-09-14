// Rustdoc browsing. instant-serve, started with --doc-root, exposes a generated
// cargo doc tree read-only at /rustdoc/ on the frontend's own HTTP origin. That
// origin matters: rustdoc loads its search index with fetch(), which Chrome
// blocks from file://, so the embedded browser engine is pointed at the served
// tree instead of the local files. Under the Tauri shell the frontend origin is
// tauri://localhost and no local doc server exists, so the command declines
// rather than opening a dead tab.
import { flashStatus } from "./core";
import { openBrowserTab } from "./browser";

export function openRustdocBrowser(): void {
  if (location.protocol !== "http:" && location.protocol !== "https:") {
    flashStatus("rustdoc browsing needs instant-serve (http origin)");
    return;
  }
  const url = new URL("/rustdoc/", location.origin).href;
  void openBrowserTab(url);
}
