// Rustdoc browsing. A generated cargo doc tree loads its search index with
// fetch(), which Chrome blocks from file://, and the native shell has no HTTP
// origin of its own. The backend therefore serves a selected doc root from a
// private 127.0.0.1 loopback server and hands back an absolute URL, so neither
// the Tauri shell nor a Vite origin is involved. The same command works under
// instant-serve. `openRustdocPath` maps one selected page; the palette variant
// opens the last registered root.
import { invoke } from "./generated/native";
import { flashStatus } from "./core";
import { openBrowserTab } from "./browser";

// Map a locally selected page to its served documentation URL. Returns false
// when the path is not a rustdoc page, letting the normal file-open path run;
// a rustdoc-shaped path with missing output flashes the backend's message.
export async function openRustdocPath(path: string): Promise<boolean> {
  let url: string | null;
  try {
    url = await invoke<string | null>("rustdoc_open", { path });
  } catch (error) {
    flashStatus(String(error));
    return true;
  }
  if (!url) return false;
  void openBrowserTab(url);
  return true;
}

export async function openRustdocBrowser(): Promise<void> {
  let url: string | null;
  try {
    url = await invoke<string | null>("rustdoc_open");
  } catch (error) {
    flashStatus(String(error));
    return;
  }
  if (url) void openBrowserTab(url);
}
