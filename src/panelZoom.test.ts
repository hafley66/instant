import { describe, it, expect, vi, beforeEach } from "vitest";

// panelZoom.ts reads the module-level store (./state), which reads
// localStorage/sessionStorage/location at import time. Same stub +
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

function freshGlobals(seed: Record<string, string> = {}) {
  const localStore = makeStorage();
  for (const [k, v] of Object.entries(seed)) localStore.setItem(k, v);
  vi.stubGlobal("localStorage", localStore);
  vi.stubGlobal("sessionStorage", makeStorage());
  vi.stubGlobal("location", { search: "", hash: "" });
  return { localStore };
}

beforeEach(() => {
  vi.resetModules();
});

describe("panelZoom", () => {
  it("defaults to 1x and remembers a set factor", async () => {
    freshGlobals();
    const { registerZoomKind, setPanelZoom, zoomFactorFor } = await import("./panelZoom");
    registerZoomKind({ prefix: "test:", min: 0.5, max: 2, step: 0.25 });
    expect(zoomFactorFor("test:a")).toBe(1);
    setPanelZoom("test:a", 1.5);
    expect(zoomFactorFor("test:a")).toBe(1.5);
  });

  it("clamps to the kind's bounds", async () => {
    freshGlobals();
    const { registerZoomKind, setPanelZoom, zoomFactorFor } = await import("./panelZoom");
    registerZoomKind({ prefix: "test:", min: 0.5, max: 2, step: 0.25 });
    setPanelZoom("test:a", 99);
    expect(zoomFactorFor("test:a")).toBe(2);
    setPanelZoom("test:a", 0.01);
    expect(zoomFactorFor("test:a")).toBe(0.5);
  });

  it("fires onZoom with the applied factor; reset restores 1x", async () => {
    freshGlobals();
    const seen: number[] = [];
    const { registerZoomKind, setPanelZoom, resetPanelZoom, zoomFactorFor } = await import(
      "./panelZoom"
    );
    registerZoomKind({
      prefix: "t2:",
      min: 0.5,
      max: 2,
      step: 0.25,
      onZoom: (_pid, f) => seen.push(f),
    });
    setPanelZoom("t2:a", 99);
    expect(seen).toEqual([2]);
    resetPanelZoom("t2:a");
    expect(zoomFactorFor("t2:a")).toBe(1);
    expect(seen).toEqual([2, 1]);
  });

  it("gestures step the resolved target by the kind's step", async () => {
    freshGlobals();
    const { registerZoomKind, setZoomTargetResolver, panelZoomGesture, zoomFactorFor } =
      await import("./panelZoom");
    registerZoomKind({ prefix: "test:", min: 0.5, max: 2, step: 0.25 });
    setZoomTargetResolver(() => "test:a");
    panelZoomGesture(1);
    expect(zoomFactorFor("test:a")).toBeCloseTo(1.25);
    panelZoomGesture(1);
    panelZoomGesture(-1);
    expect(zoomFactorFor("test:a")).toBeCloseTo(1.25);
  });
});

describe("tabZoom -> panelZoom migration", () => {
  it("converts px font sizes to term factors, once", async () => {
    const { localStore } = freshGlobals({ tabZoom: JSON.stringify({ "s:main": 26 }) });
    const { store } = await import("./state");
    expect(store.get().panelZoom["term:s:main"]).toBeCloseTo(26 / 13);
    expect(localStore.getItem("panelZoomV1")).toBe("1");
    expect(localStore.getItem("tabZoom")).toBeNull();
  });

  it("leaves existing panelZoom entries alone", async () => {
    freshGlobals({
      tabZoom: JSON.stringify({ "s:main": 26 }),
      panelZoom: JSON.stringify({ "md:/x.md": 1.5 }),
    });
    const { store } = await import("./state");
    expect(store.get().panelZoom["md:/x.md"]).toBe(1.5);
    expect(store.get().panelZoom["term:s:main"]).toBeCloseTo(2);
  });
});
