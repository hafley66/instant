import { describe, it, expect, vi, beforeEach } from "vitest";

// 0_panicSettings.ts builds its StorageSignals at import time, so each test
// stubs the globals they touch and re-imports the module fresh. The point of
// these cases is the migration contract: values written by the loadKey/PERSIST
// pair these replaced must still load, under the same keys and the same JSON.

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
    clear: () => map.clear(),
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
  vi.stubGlobal("addEventListener", () => {});
  return { localStore, sessionStore };
}

beforeEach(() => {
  vi.resetModules();
});

describe("panic settings", () => {
  it("loads values persisted under the pre-migration keys", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem("panicMode", JSON.stringify("escape"));
    localStore.setItem("panicPos", JSON.stringify({ x: 40, y: -12 }));
    localStore.setItem("panicBody", JSON.stringify("quiet please"));
    const { panic } = await import("./0_panicSettings");
    expect(panic.mode.$()).toBe("escape");
    expect(panic.pos.$()).toEqual({ x: 40, y: -12 });
    expect(panic.body.$()).toBe("quiet please");
  });

  it("falls back to the default when a key is absent or corrupt", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem("panicSub", "{not json");
    const { panic } = await import("./0_panicSettings");
    expect(panic.sub.$()).toBe("below");
    expect(panic.on.$()).toBe(true);
  });

  it("writes back under the same key as JSON", async () => {
    const { localStore } = freshGlobals();
    const { panic } = await import("./0_panicSettings");
    panic.mode.$("paste");
    expect(localStore.getItem("panicMode")).toBe(JSON.stringify("paste"));
  });

  it("SAFE_BOOT discards the persisted copy", async () => {
    const { localStore, sessionStore } = freshGlobals();
    localStore.setItem("panicButton", JSON.stringify(false));
    sessionStore.setItem("SAFE_BOOT", "1");
    const { panic } = await import("./0_panicSettings");
    expect(panic.on.$()).toBe(true);
  });

  it("cyclePanic advances through the list and wraps", async () => {
    freshGlobals();
    const { panic, cyclePanic, PANIC_SUBS } = await import("./0_panicSettings");
    const seen = PANIC_SUBS.map(() => {
      const at = panic.sub.$();
      cyclePanic(panic.sub, PANIC_SUBS);
      return at;
    });
    expect(seen).toEqual(["below", "cap", "both", "off"]);
    expect(panic.sub.$()).toBe("below");
  });
});
