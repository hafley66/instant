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

describe("settings boot / persistence", () => {
  it("defaults every persisted field on empty storage", async () => {
    freshGlobals();
    const { settings } = await import("./0_settings");
    expect(settings.skin.$()).toBe("xp");
    expect(settings.mode.$()).toBe("light");
    expect(settings.sidebar.$()).toBe("big");
    expect(settings.scanRoot.$()).toBe("~/projects");
    expect(settings.wtAgents.$()).toEqual([
      { label: "claude", command: "claude", resume: "--resume" },
      { label: "opencode", command: "opencode", resume: "--session" },
      { label: "codex", command: "codex", resume: "resume" },
    ]);
  });

  it("falls back to the raw string for a legacy (pre-JSON) persisted value", async () => {
    const { localStore } = freshGlobals();
    // Old plain-string persistence: not JSON-encoded, so JSON.parse throws.
    localStore.setItem("scanRoot", "~/legacy-path");
    const { settings } = await import("./0_settings");
    expect(settings.scanRoot.$()).toBe("~/legacy-path");
  });

  it("reads a well-formed JSON-encoded persisted value", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem("zoom", JSON.stringify(1.5));
    const { settings } = await import("./0_settings");
    expect(settings.zoom.$()).toBe(1.5);
  });

  it("migrates the old resumeTabs key once and sets the version flag", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem(
      "resumeTabs",
      JSON.stringify({ "/old/cwd": { editor: "claude", sessionId: "stale" } }),
    );
    await import("./0_settings");
    expect(localStore.getItem("resumeTabsV2")).toBe("1");
    // The migration removes the key; the signal then seeds it with its empty
    // default, so the poisoned entries are gone either way.
    expect(JSON.parse(localStore.getItem("resumeTabs")!)).toEqual({});
  });

  it("leaves resumeTabs alone once the version flag is already set", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem("resumeTabsV2", "1");
    localStore.setItem(
      "resumeTabs",
      JSON.stringify({ "/keep/cwd": { editor: "opencode", sessionId: "keep" } }),
    );
    const { settings } = await import("./0_settings");
    expect(settings.resumeTabs.$()).toEqual({
      "/keep/cwd": { editor: "opencode", sessionId: "keep" },
    });
  });

  it("writing a setting persists that key alone", async () => {
    const { localStore } = freshGlobals();
    const { settings } = await import("./0_settings");
    settings.zoom.$(2);
    expect(localStore.getItem("zoom")).toBe(JSON.stringify(2));
    // Runtime-only fields live in the store and are never written to localStorage.
    expect(localStore.getItem("activity")).toBeNull();
  });

  it("SAFE_BOOT (sessionStorage flag) skips reading persisted values", async () => {
    const { localStore, sessionStore } = freshGlobals();
    localStore.setItem("skin", JSON.stringify("p5"));
    sessionStore.setItem("SAFE_BOOT", "1");
    const mod = await import("./state");
    const { settings } = await import("./0_settings");
    expect(mod.SAFE_BOOT).toBe(true);
    expect(settings.skin.$()).toBe("xp"); // fallback, ignoring the persisted "p5"
  });

  it("SAFE_BOOT is false and persisted values load normally on a plain boot", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem("skin", JSON.stringify("p5"));
    const mod = await import("./state");
    const { settings } = await import("./0_settings");
    expect(mod.SAFE_BOOT).toBe(false);
    expect(settings.skin.$()).toBe("p5");
  });

  it("defaults pluginState to {} on empty storage", async () => {
    freshGlobals();
    const { settings } = await import("./0_settings");
    expect(settings.pluginState.$()).toEqual({});
  });

  it("migrates the legacy meme:ui key into pluginState.meme once", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem("meme:ui", JSON.stringify({ sidebarWidth: 222, layersHeight: 99 }));
    const { settings } = await import("./0_settings");
    expect(settings.pluginState.$().meme).toEqual({ sidebarWidth: 222, layersHeight: 99 });
    // Old key is left in place (no destructive delete).
    expect(localStore.getItem("meme:ui")).toBe(JSON.stringify({ sidebarWidth: 222, layersHeight: 99 }));
  });

  it("does not re-migrate meme:ui once pluginState.meme is already set", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem("meme:ui", JSON.stringify({ sidebarWidth: 222 }));
    localStore.setItem("pluginState", JSON.stringify({ meme: { sidebarWidth: 10 } }));
    const { settings } = await import("./0_settings");
    expect(settings.pluginState.$().meme).toEqual({ sidebarWidth: 10 });
  });

  it("ignores a malformed legacy meme:ui value", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem("meme:ui", "{not json");
    const { settings } = await import("./0_settings");
    expect(settings.pluginState.$().meme).toBeUndefined();
  });

  it("SAFE_BOOT skips the meme:ui migration too", async () => {
    const { localStore, sessionStore } = freshGlobals();
    localStore.setItem("meme:ui", JSON.stringify({ sidebarWidth: 222 }));
    sessionStore.setItem("SAFE_BOOT", "1");
    const { settings } = await import("./0_settings");
    expect(settings.pluginState.$()).toEqual({});
  });

  it("writing pluginState persists it under its own key", async () => {
    const { localStore } = freshGlobals();
    const { settings } = await import("./0_settings");
    settings.pluginState.$({ meme: { sidebarWidth: 5 } });
    expect(localStore.getItem("pluginState")).toBe(JSON.stringify({ meme: { sidebarWidth: 5 } }));
  });
});
