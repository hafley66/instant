import { describe, it, expect, vi, beforeEach } from "vitest";

// state.ts reads localStorage/sessionStorage/location at import time (SAFE_BOOT,
// load()) to build the module-level `store`. There's no DOM here (node
// environment, no jsdom) so we stub just the surface it touches and re-import
// the module fresh for each test via vi.resetModules().

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

describe("state.ts boot / persistence", () => {
  it("defaults every persisted field on empty storage", async () => {
    freshGlobals();
    const { store } = await import("./state");
    const s = store.get();
    expect(s.skin).toBe("xp");
    expect(s.mode).toBe("light");
    expect(s.sidebar).toBe("big");
    expect(s.scanRoot).toBe("~/projects");
    expect(s.wtAgents).toEqual([
      { label: "claude", command: "claude", resume: "--resume" },
      { label: "opencode", command: "opencode", resume: "--session" },
      { label: "codex", command: "codex", resume: "resume" },
    ]);
  });

  it("falls back to the raw string for a legacy (pre-JSON) persisted value", async () => {
    const { localStore } = freshGlobals();
    // Old plain-string persistence: not JSON-encoded, so JSON.parse throws.
    localStore.setItem("scanRoot", "~/legacy-path");
    const { store } = await import("./state");
    expect(store.get().scanRoot).toBe("~/legacy-path");
  });

  it("reads a well-formed JSON-encoded persisted value", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem("zoom", JSON.stringify(1.5));
    const { store } = await import("./state");
    expect(store.get().zoom).toBe(1.5);
  });

  it("migrates the old resumeTabs key once and sets the version flag", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem(
      "resumeTabs",
      JSON.stringify({ "/old/cwd": { editor: "claude", sessionId: "stale" } }),
    );
    await import("./state");
    expect(localStore.getItem("resumeTabsV2")).toBe("1");
    expect(localStore.getItem("resumeTabs")).toBeNull();
  });

  it("leaves resumeTabs alone once the version flag is already set", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem("resumeTabsV2", "1");
    localStore.setItem(
      "resumeTabs",
      JSON.stringify({ "/keep/cwd": { editor: "opencode", sessionId: "keep" } }),
    );
    const { store } = await import("./state");
    expect(store.get().resumeTabs).toEqual({
      "/keep/cwd": { editor: "opencode", sessionId: "keep" },
    });
  });

  it("store.set() persists only the changed PERSIST-listed keys", async () => {
    const { localStore } = freshGlobals();
    const { store } = await import("./state");
    store.set({ zoom: 2 });
    expect(localStore.getItem("zoom")).toBe(JSON.stringify(2));
    // Runtime-only fields (not in PERSIST) are never written to localStorage.
    expect(localStore.getItem("activity")).toBeNull();
  });

  it("SAFE_BOOT (sessionStorage flag) skips reading persisted values", async () => {
    const { localStore, sessionStore } = freshGlobals();
    localStore.setItem("skin", JSON.stringify("p5"));
    sessionStore.setItem("SAFE_BOOT", "1");
    const mod = await import("./state");
    expect(mod.SAFE_BOOT).toBe(true);
    expect(mod.store.get().skin).toBe("xp"); // fallback, ignoring the persisted "p5"
  });

  it("SAFE_BOOT is false and persisted values load normally on a plain boot", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem("skin", JSON.stringify("p5"));
    const mod = await import("./state");
    expect(mod.SAFE_BOOT).toBe(false);
    expect(mod.store.get().skin).toBe("p5");
  });

  it("defaults pluginState to {} on empty storage", async () => {
    freshGlobals();
    const { store } = await import("./state");
    expect(store.get().pluginState).toEqual({});
  });

  it("migrates the legacy meme:ui key into pluginState.meme once", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem("meme:ui", JSON.stringify({ sidebarWidth: 222, layersHeight: 99 }));
    const { store } = await import("./state");
    expect(store.get().pluginState.meme).toEqual({ sidebarWidth: 222, layersHeight: 99 });
    // Old key is left in place (no destructive delete).
    expect(localStore.getItem("meme:ui")).toBe(JSON.stringify({ sidebarWidth: 222, layersHeight: 99 }));
  });

  it("does not re-migrate meme:ui once pluginState.meme is already set", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem("meme:ui", JSON.stringify({ sidebarWidth: 222 }));
    localStore.setItem("pluginState", JSON.stringify({ meme: { sidebarWidth: 10 } }));
    const { store } = await import("./state");
    expect(store.get().pluginState.meme).toEqual({ sidebarWidth: 10 });
  });

  it("ignores a malformed legacy meme:ui value", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem("meme:ui", "{not json");
    const { store } = await import("./state");
    expect(store.get().pluginState.meme).toBeUndefined();
  });

  it("SAFE_BOOT skips the meme:ui migration too", async () => {
    const { localStore, sessionStore } = freshGlobals();
    localStore.setItem("meme:ui", JSON.stringify({ sidebarWidth: 222 }));
    sessionStore.setItem("SAFE_BOOT", "1");
    const { store } = await import("./state");
    expect(store.get().pluginState).toEqual({});
  });

  it("store.set() persists pluginState under its own key", async () => {
    const { localStore } = freshGlobals();
    const { store } = await import("./state");
    store.set({ pluginState: { meme: { sidebarWidth: 5 } } });
    expect(localStore.getItem("pluginState")).toBe(JSON.stringify({ meme: { sidebarWidth: 5 } }));
  });
});
