// Dropped-file vocabulary shared by the catcher window (which stashes) and the
// main window (which pastes or types). No DOM/tauri/./core imports: catcher bundle.
import type { CommandName } from "./generated/native";

/// One dropped path after `stash_drop` (src-tauri/src/fs.rs). `stashed` null
/// with a `reason` means the original is still the only copy.
export type StashedDrop = {
  source: string;
  stashed: string | null;
  bytes: number;
  reason: string | null;
};

// Type-checked against the generated command union; the import above is erased.
export const STASH_DROP_COMMAND: CommandName = "stash_drop";

/// The path every later step names: the durable copy when there is one.
export const dropPath = (drop: StashedDrop): string => drop.stashed ?? drop.source;

/// Lowercased extension of a path, "" when it has none.
export function pathExt(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/// Image by extension, against the caller's table (IMAGE_EXTS in ./core).
export const isImagePath = (path: string, exts: ReadonlySet<string>): boolean =>
  exts.has(pathExt(path));

/// "" when boop delivered the file (`pasted …`, or `typed …` when it fell back
/// to a quoted path). run_click drops stderr and exit status; hence the 2>&1.
export function pasteFailure(output: string): string {
  const line = output.trim().split("\n")[0]?.trim() ?? "";
  if (line.startsWith("pasted ") || line.startsWith("typed ")) return "";
  if (!line) return "boop beep paste said nothing";
  return line.replace(/^Error:\s*/, "");
}

/// One instant.log line per dropped file.
export function dropLogLine(drop: StashedDrop, outcome: string): string {
  const stashed = drop.stashed ?? "-";
  const reason = drop.reason ? ` reason=${JSON.stringify(drop.reason)}` : "";
  return `drop source=${JSON.stringify(drop.source)} stashed=${JSON.stringify(stashed)} bytes=${drop.bytes} outcome=${outcome}${reason}`;
}

/// A path that never reached the stash (command failed, or an event carrying
/// bare paths).
export const unstashed = (source: string): StashedDrop => ({
  source,
  stashed: null,
  bytes: 0,
  reason: null,
});
