import { describe, it, expect, vi, beforeEach } from "vitest";

// pluginState.ts reads the module-level `store` from ./state, which itself
// reads localStorage/sessionStorage/location at import time. Same stub +
// vi.resetModules() approach as state.test.ts.

function makeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
}

function freshGlobals() {
  const localStore = makeStorage();
  const sessionStore = makeStorage();
  vi.stubGlobal("localStorage", localStore);
  vi.stubGlobal("sessionStorage", sessionStore);
  vi.stubGlobal("location", { search: "", hash: "" });
  return { localStore, sessionStore };
}

beforeEach(() => {
  vi.resetModules();
});

interface Ui {
  sidebarWidth?: number;
  layersHeight?: number;
}

describe("pluginState.ts", () => {
  it("readPluginState returns the fallback when the plugin has no slice yet", async () => {
    freshGlobals();
    const { readPluginState } = await import("./pluginState");
    expect(readPluginState<Ui>("meme", {})).toEqual({});
  });

  it("savePluginState creates the plugin's slice under its id", async () => {
    freshGlobals();
    const { readPluginState, savePluginState } = await import("./pluginState");
    savePluginState<Ui>("meme", { sidebarWidth: 200 });
    expect(readPluginState<Ui>("meme", {})).toEqual({ sidebarWidth: 200 });
  });

  it("savePluginState merges into the existing slice rather than replacing it", async () => {
    freshGlobals();
    const { readPluginState, savePluginState } = await import("./pluginState");
    savePluginState<Ui>("meme", { sidebarWidth: 200 });
    savePluginState<Ui>("meme", { layersHeight: 150 });
    expect(readPluginState<Ui>("meme", {})).toEqual({ sidebarWidth: 200, layersHeight: 150 });
  });

  it("keeps different plugin ids isolated from each other", async () => {
    freshGlobals();
    const { readPluginState, savePluginState } = await import("./pluginState");
    savePluginState<Ui>("meme", { sidebarWidth: 200 });
    savePluginState<{ foo?: string }>("other", { foo: "bar" });
    expect(readPluginState<Ui>("meme", {})).toEqual({ sidebarWidth: 200 });
    expect(readPluginState<{ foo?: string }>("other", {})).toEqual({ foo: "bar" });
  });

  it("persists the plugin slice through the store's pluginState key", async () => {
    const { localStore } = freshGlobals();
    const { savePluginState } = await import("./pluginState");
    savePluginState<Ui>("meme", { sidebarWidth: 200 });
    expect(localStore.getItem("pluginState")).toBe(JSON.stringify({ meme: { sidebarWidth: 200 } }));
  });

  it("readPluginState picks up the legacy meme:ui migration performed by state.ts", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem("meme:ui", JSON.stringify({ sidebarWidth: 321 }));
    const { readPluginState } = await import("./pluginState");
    expect(readPluginState<Ui>("meme", {})).toEqual({ sidebarWidth: 321 });
  });
});
