// The single app store. UI/persisted state lives here; runtime resources (live
// xterm Terminals) stay in their own registry in main.ts. New durable fields
// (sessions, panels, layout) get added to AppState and listed in PERSIST.
import { createStore } from "./store";

export type Skin = "xp" | "p5";
export type Mode = "light" | "dark";

export interface AppState {
  skin: Skin;
  mode: Mode;
  active: string | null; // active tab id
}

// Durable slice, mirrored to localStorage. `active` is intentionally excluded —
// it's session-runtime, not a preference.
const PERSIST: (keyof AppState)[] = ["skin", "mode"];

function load(): AppState {
  return {
    skin: (localStorage.getItem("skin") as Skin) ?? "xp",
    mode: (localStorage.getItem("mode") as Mode) ?? "light",
    active: null,
  };
}

export const store = createStore<AppState>(load());

store.subscribe((s) => {
  for (const k of PERSIST) localStorage.setItem(k, String(s[k]));
}, PERSIST);
