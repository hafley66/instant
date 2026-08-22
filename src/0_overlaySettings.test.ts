import { describe, it, expect, vi, beforeEach } from "vitest";

// The migration contract for the window-presentation keys: values written by
// the loadKey/PERSIST pair these replaced must still load, under the same
// localStorage keys and the same JSON.

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

describe("overlay settings", () => {
  it("loads values persisted under the pre-migration keys", async () => {
    const { localStore } = freshGlobals();
    localStore.setItem("overlayMode", JSON.stringify("follow"));
    localStore.setItem("overlayTarget", JSON.stringify("Ghostty"));
    localStore.setItem("overlayFade", JSON.stringify(true));
    localStore.setItem("miniMode", JSON.stringify(true));
    const { overlay } = await import("./0_overlaySettings");
    expect(overlay.mode.$()).toBe("follow");
    expect(overlay.target.$()).toBe("Ghostty");
    expect(overlay.fade.$()).toBe(true);
    expect(overlay.mini.$()).toBe(true);
  });

  it("uses the documented defaults when nothing is persisted", async () => {
    freshGlobals();
    const { overlay } = await import("./0_overlaySettings");
    expect(overlay.mode.$()).toBe("off");
    expect(overlay.target.$()).toBe("Code");
    expect(overlay.fade.$()).toBe(false);
    expect(overlay.mini.$()).toBe(false);
  });

  it("writes back under the same key as JSON", async () => {
    const { localStore } = freshGlobals();
    const { overlay } = await import("./0_overlaySettings");
    overlay.target.$("Zed");
    expect(localStore.getItem("overlayTarget")).toBe(JSON.stringify("Zed"));
  });

  it("SAFE_BOOT discards the persisted copy", async () => {
    const { localStore, sessionStore } = freshGlobals();
    localStore.setItem("miniMode", JSON.stringify(true));
    sessionStore.setItem("SAFE_BOOT", "1");
    const { overlay } = await import("./0_overlaySettings");
    expect(overlay.mini.$()).toBe(false);
  });
});
