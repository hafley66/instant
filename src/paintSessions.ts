// Paint "sessions" — the tmux-reattach equivalent for paintings. Persisted in
// pluginState.paint: the recent-files MRU and the last-opened path, so the
// panel resumes the previous painting on open and the rail button's children
// list the history. The live edit counter (paintEdits) is the dirty signal the
// tab wrapper's guard reads; it's session-only, like the editor itself.
import { Signal } from "@hafley66/signals";
import { invoke } from "./generated/native";
import { readPluginState, savePluginState } from "./pluginState";
import { activePaintBridge } from "./paintBridge";
import { baseName, flashStatus, getHomeDir } from "./core";
import { formatTimestamp } from "./memeExport";

const PLUGIN_ID = "paint";
const RECENT_CAP = 10;

export interface PaintSession {
  recent: string[]; // MRU first, capped at RECENT_CAP
  lastPath: string | null; // resumed on panel open
}

export const paintSession = Signal<PaintSession>({
  recent: [],
  lastPath: null,
  ...readPluginState<Partial<PaintSession>>(PLUGIN_ID, {}),
});

// UI/session signals (not persisted): the path input's value and the unsaved
// edit counter (bumped by the bridge's onEdit, reset on load/save).
export const paintCurrent = Signal("");
export const paintEdits = Signal(0);

export function discardPaintSession(): void {
  activePaintBridge()?.clearQuicksave();
  paintEdits.$(0);
}

// MRU insert: dedup + most-recent-first + cap. Pure, unit-tested.
export function mruPush(list: string[], path: string, cap: number = RECENT_CAP): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, cap);
}

function record(path: string): void {
  const cur = paintSession.$();
  const next: PaintSession = { recent: mruPush(cur.recent, path), lastPath: path };
  paintSession.$(next);
  savePluginState<PaintSession>(PLUGIN_ID, next);
}

// Load an image file into the editor and make it the current session.
export async function loadPaintFile(path: string): Promise<boolean> {
  const bridge = activePaintBridge();
  if (!bridge) return false;
  try {
    const dataUrl = await invoke<string>("read_image", { path });
    bridge.loadDataUrl(dataUrl); // fires onClean via the open_file action
    paintCurrent.$(path);
    paintEdits.$(0);
    record(path);
    flashStatus(`paint: opened ${baseName(path)}`);
    return true;
  } catch (e) {
    flashStatus(`paint: ${String(e)}`);
    return false;
  }
}

// Flatten and write the painting as PNG to the current path (default:
// ~/Desktop/paint-<timestamp>.png when nothing was opened/typed yet).
export async function savePaint(): Promise<void> {
  const bridge = activePaintBridge();
  const dataUrl = bridge?.compositePng();
  if (!dataUrl) {
    flashStatus("paint: nothing to save");
    return;
  }
  const path =
    paintCurrent.$().trim() ||
    `${getHomeDir() || "/Users"}/Desktop/paint-${formatTimestamp(new Date())}.png`;
  try {
    await invoke("save_meme", { path, dataUrl }); // PNG data URL -> disk, ~ ok
    paintCurrent.$(path);
    paintEdits.$(0);
    record(path);
    bridge?.quicksave();
    flashStatus(`paint: saved ${baseName(path)}`);
  } catch (e) {
    flashStatus(`paint: ${String(e)}`);
  }
}
