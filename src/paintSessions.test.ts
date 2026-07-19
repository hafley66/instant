import { describe, it, expect, vi, beforeEach } from "vitest";

// paintSessions.ts imports the module-level store (via pluginState -> state),
// which reads localStorage/sessionStorage/location at import time. Same stub +
// vi.resetModules() approach as pluginState.test.ts.

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

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("localStorage", makeStorage());
  vi.stubGlobal("sessionStorage", makeStorage());
  vi.stubGlobal("location", { search: "", hash: "" });
});

describe("mruPush", () => {
  it("prepends new entries", async () => {
    const { mruPush } = await import("./paintSessions");
    expect(mruPush(["/a.png"], "/b.png")).toEqual(["/b.png", "/a.png"]);
  });

  it("dedups and floats the re-opened file to the front", async () => {
    const { mruPush } = await import("./paintSessions");
    expect(mruPush(["/a.png", "/b.png", "/c.png"], "/b.png")).toEqual([
      "/b.png",
      "/a.png",
      "/c.png",
    ]);
  });

  it("caps the list", async () => {
    const { mruPush } = await import("./paintSessions");
    const full = Array.from({ length: 10 }, (_, i) => `/f${i}.png`);
    const next = mruPush(full, "/new.png");
    expect(next.length).toBe(10);
    expect(next[0]).toBe("/new.png");
    expect(next).not.toContain("/f9.png");
  });

  it("honors a custom cap", async () => {
    const { mruPush } = await import("./paintSessions");
    expect(mruPush(["/a", "/b"], "/c", 2)).toEqual(["/c", "/a"]);
  });
});
