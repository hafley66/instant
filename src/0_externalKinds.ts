// Kinds instant hands to the OS default app instead of rendering itself:
// no in-app viewer exists, so clicks route to openExternal (see preview.ts).
import { IMAGE_EXTS, SHIKI_LANG } from "./core";

export const EXTERNAL_EXTS: ReadonlySet<string> = new Set([
  // video
  "mp4", "mov", "m4v", "mkv", "webm", "avi",
  // audio
  "mp3", "m4a", "wav", "flac", "aac", "ogg",
  // archives and installers
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "dmg", "pkg",
  // office documents
  "docx", "xlsx", "pptx", "pages", "numbers", "key",
  // fonts
  "ttf", "otf", "woff", "woff2",
  // applications
  "app",
]);

// Matches openPathInInstant's extraction so both sides agree on what has an
// extension (dotless names contribute their whole lowercased name).
const extOf = (path: string): string =>
  path.split("/").pop()?.split(".").pop()?.toLowerCase() ?? "";

export function opensExternally(path: string): boolean {
  return EXTERNAL_EXTS.has(extOf(path));
}

// True for what instant renders today: images, PDF, D2, Markdown, HTML, and
// the language table in core.ts (source and plain text stay inside).
export function isKnownInstantKind(path: string): boolean {
  const ext = extOf(path);
  return (
    IMAGE_EXTS.has(ext) ||
    ["pdf", "d2", "md", "markdown", "html", "htm", "svg"].includes(ext) ||
    SHIKI_LANG[ext] !== undefined
  );
}
