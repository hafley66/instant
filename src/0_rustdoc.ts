// Rustdoc browsing. instant-serve, started with --doc-root, exposes a generated
// cargo doc tree read-only at /rustdoc/ on the frontend's own HTTP origin. That
// origin matters: rustdoc loads its search index with fetch(), which Chrome
// blocks from file://, so the embedded browser engine is pointed at the served
// tree instead of the local files. The availability check keeps the command from
// opening a 404 tab when no doc root is configured, which covers both the native
// shell (tauri://localhost) and a dev Vite origin.
import { flashStatus } from "./core";
import { openBrowserTab } from "./browser";

export async function openRustdocBrowser(): Promise<void> {
  if (location.protocol !== "http:" && location.protocol !== "https:") {
    flashStatus("rustdoc browsing needs the serve backend (http origin)");
    return;
  }
  let reachable = false;
  try {
    reachable = (await fetch("/rustdoc/", { method: "HEAD" })).ok;
  } catch {
    reachable = false;
  }
  if (!reachable) {
    flashStatus("no rustdoc doc root configured (start instant-serve with --doc-root)");
    return;
  }
  void openBrowserTab(new URL("/rustdoc/", location.origin).href);
}
