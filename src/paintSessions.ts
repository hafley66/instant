// Paint "sessions" — the tmux-reattach equivalent for paintings. Persisted in
// pluginState.paint: the recent-files MRU and the last-opened path, so the
// panel resumes the previous painting on open and the rail button's children
// list the history. Each panel instance owns its live edit counter and dirty
// signal; those values are session-only, like the editor itself.
import { Signal } from "@hafley66/signals";
import { invoke } from "./generated/native";
import { readPluginState, savePluginState } from "./pluginState";
import type { PaintBridge } from "./paintBridge";
import { clearPaintSessionSnapshot } from "./paintBridge";
import { baseName, flashStatus, getHomeDir } from "./core";
import { formatTimestamp } from "./memeExport";
import { copyMemePng } from "./memeExport";

const PLUGIN_ID = "paint";
const RECENT_CAP = 10;
export const PAINT_SIDEBAR_RECENT_CAP = 5;

export interface PaintSession {
  recent: string[]; // MRU first, capped at RECENT_CAP
  lastPath: string | null; // resumed on panel open
}

export const paintSession = Signal<PaintSession>({
  recent: [],
  lastPath: null,
  ...readPluginState<Partial<PaintSession>>(PLUGIN_ID, {}),
});

type WritableSignal<T> = {
  $(): T;
  $(value: T): void;
};

export interface PaintPanelState {
  panelId: string;
  current: WritableSignal<string>;
  edits: WritableSignal<number>;
  bridge: PaintBridge | null;
}

const panelStates = new Map<string, PaintPanelState>();

export function paintPanelState(panelId: string): PaintPanelState {
  const existing = panelStates.get(panelId);
  if (existing) return existing;
  const state: PaintPanelState = { panelId, current: Signal(""), edits: Signal(0), bridge: null };
  panelStates.set(panelId, state);
  return state;
}

export function releasePaintPanelState(panelId: string): void {
  panelStates.delete(panelId);
}

export function discardPaintSession(panelId: string): void {
  const state = panelStates.get(panelId);
  state?.bridge?.clearQuicksave();
  clearPaintSessionSnapshot(panelId);
  state?.edits.$(0);
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

export function removeRecentPaint(path: string): void {
  const cur = paintSession.$();
  const next: PaintSession = {
    recent: cur.recent.filter((entry) => entry !== path),
    lastPath: cur.lastPath === path ? null : cur.lastPath,
  };
  paintSession.$(next);
  savePluginState<PaintSession>(PLUGIN_ID, next);
}

export async function deletePaintFile(path: string): Promise<boolean> {
  if (!window.confirm(`Delete “${baseName(path)}” from disk?`)) return false;
  try {
    await invoke("delete_file", { path });
    removeRecentPaint(path);
    flashStatus(`paint: deleted ${baseName(path)}`);
    return true;
  } catch (e) {
    flashStatus(`paint: ${String(e)}`);
    return false;
  }
}

export async function copyPaintImage(state: PaintPanelState): Promise<boolean> {
  const dataUrl = state.bridge?.compositePng();
  if (!dataUrl) {
    flashStatus("paint: nothing to copy");
    return false;
  }
  try {
    await copyMemePng(dataUrl);
    flashStatus("paint: copied image");
    return true;
  } catch (e) {
    flashStatus(`paint: ${String(e)}`);
    return false;
  }
}

// Load an image file into the editor and make it the current session.
export async function loadPaintFile(state: PaintPanelState, path: string): Promise<boolean> {
  const bridge = state.bridge;
  if (!bridge) return false;
  try {
    if (/\.svg$/i.test(path)) {
      const svg = await invoke<string>("read_text", { path });
      bridge.loadSvgText(svg);
    } else {
      const dataUrl = await invoke<string>("read_image", { path });
      bridge.loadDataUrl(dataUrl);
    }
    state.current.$(path);
    state.edits.$(0);
    record(path);
    bridge.quicksave();
    flashStatus(`paint: opened ${baseName(path)}`);
    return true;
  } catch (e) {
    flashStatus(`paint: ${String(e)}`);
    return false;
  }
}

export async function requestLoadPaintFile(state: PaintPanelState, path: string): Promise<boolean> {
  if (state.edits.$() > 0) {
    const saveChanges = window.confirm(
      `“${baseName(state.current.$()) || "untitled painting"}” has unsaved changes. Save before opening ${baseName(path)}?`,
    );
    if (saveChanges) {
      if (!(await savePaint(state))) return false;
    } else {
      state.bridge?.clearQuicksave();
      state.edits.$(0);
    }
  }
  return loadPaintFile(state, path);
}

// Write the painting as SVG when the path ends in .svg, otherwise flatten it
// to PNG. The default path is ~/Desktop/paint-<timestamp>.png.
export async function savePaint(state: PaintPanelState): Promise<boolean> {
  const bridge = state.bridge;
  const path =
    state.current.$().trim() ||
    `${getHomeDir() || "/Users"}/Desktop/paint-${formatTimestamp(new Date())}.png`;
  const isSvg = /\.svg$/i.test(path);
  const dataUrl = isSvg ? null : bridge?.compositePng();
  const svg = isSvg ? bridge?.exportSvg() : null;
  if (!dataUrl && !svg) {
    flashStatus("paint: nothing to save");
    return false;
  }
  try {
    if (svg) await invoke("save_text", { path, contents: svg });
    else {
      await invoke("save_meme", { path, dataUrl });
      bridge?.clearSvgSource();
    }
    state.current.$(path);
    state.edits.$(0);
    record(path);
    bridge?.quicksave();
    flashStatus(`paint: saved ${baseName(path)}`);
    return true;
  } catch (e) {
    flashStatus(`paint: ${String(e)}`);
    return false;
  }
}
