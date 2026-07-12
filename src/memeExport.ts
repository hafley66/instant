// Save/export/copy logic for the meme panel, split out of meme.tsx so that
// file stays under the AGENTS.md size cap. Path/filename math is pure and
// unit-tested (memeExport.test.ts); the invoke() calls are the only impure
// part and are thin wrappers around the Rust commands in src-tauri/src/meme.rs.
import { invoke } from "./generated/native";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Local-time yyyyMMdd-HHmmss — matches how the rest of the app timestamps
// things for humans (no timezone math, no locale surprises).
export function formatTimestamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  );
}

export function defaultExportFilename(d: Date = new Date()): string {
  return `meme-${formatTimestamp(d)}.png`;
}

// One-click export target: ~/Desktop/meme-<timestamp>.png. `home` should
// already be an absolute path (the app resolves it once at boot — see
// getHomeDir/setHomeDir in src/core.ts); "/Users" is only a last-resort
// fallback if that resolution somehow never completed.
export function defaultExportPath(home: string, d: Date = new Date()): string {
  const base = (home || "/Users").replace(/\/+$/, "");
  return `${base}/Desktop/${defaultExportFilename(d)}`;
}

// Synthetic `upload://...` paths (from drag/drop or the HTML file picker)
// aren't real filesystem locations — treat them as "no folder known" so a
// derived save path never gets built out of one of these.
export function isRealFolder(folder: string): boolean {
  return folder.length > 0 && !folder.startsWith("upload://");
}

function basename(path: string): string {
  return path.split("/").pop() || path;
}

// Derive an output path next to the source image for a given suffix (used
// for the Slack emoji export). Falls back to the resolved home dir when the
// source folder is an "upload://" placeholder rather than a real directory.
export function deriveOutputPath(
  currentPath: string,
  folder: string,
  home: string,
  suffix: string,
): string {
  const fallbackDir = isRealFolder(folder) ? folder : home || "/Users";
  const name = currentPath.startsWith("upload://")
    ? currentPath.slice("upload://".length).replace(/\.[^.]+$/, "")
    : currentPath.replace(/\.[^.]+$/, "");
  const file = `${basename(name)}${suffix}`;
  if (currentPath.startsWith("upload://")) {
    return `${fallbackDir}/${file}`;
  }
  const dir = currentPath.split("/").slice(0, -1).join("/");
  return dir ? `${dir}/${file}` : file;
}

// Write a PNG data URL to disk via the Rust save_meme command (handles `~`
// expansion and creates missing parent directories on the Rust side).
export async function writeMemePng(path: string, dataUrl: string): Promise<void> {
  await invoke("save_meme", { path, dataUrl });
}

// Copy a PNG data URL to the system clipboard via Rust. WKWebView blocks
// navigator.clipboard.write() for images (NotAllowedError) regardless of
// user gesture, so image copy has to go through a native command instead of
// the web Clipboard API.
export async function copyMemePng(dataUrl: string): Promise<void> {
  await invoke("copy_meme_image", { dataUrl });
}

// True when an error from make_slack_emoji/magick_run (src-tauri/src/meme.rs)
// means magick/convert simply isn't on PATH, as opposed to some other
// ImageMagick failure. Both of that file's "binary missing" format strings
// ("cannot run '{bin}': {e}. Is ImageMagick installed?" and "'{bin}'
// -version failed. Is ImageMagick installed?") end with this phrase, so it's
// a stable classifier without depending on the exact os-error wording.
export function isMagickMissingErrorMessage(msg: string): boolean {
  return /is imagemagick installed\??/i.test(msg);
}

// Probe the Rust side for magick/convert on PATH (magick_available in
// src-tauri/src/meme.rs, which reuses pty::path_env so a GUI-launched
// instant sees the same PATH a login shell/`brew install` would).
export async function probeMagickAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>("magick_available");
  } catch {
    return false;
  }
}
