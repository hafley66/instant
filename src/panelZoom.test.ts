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

describe("zoom target resolution", () => {
  async function target() {
    freshGlobals();
    const { registerZoomKind, resolveZoomTarget } = await import("./panelZoom");
    registerZoomKind({ prefix: "md:", min: 0.5, max: 2.5, step: 0.1 });
    registerZoomKind({ prefix: "term:", min: 0.5, max: 3, step: 0.1 });
    return resolveZoomTarget;
  }

  it("a preview opened after the terminal took focus wins the gesture", async () => {
    const resolveZoomTarget = await target();
    expect(
      resolveZoomTarget({ pid: "md:%2Fa.md", at: 200 }, { pid: "term:s:main", at: 100 }),
    ).toBe("md:%2Fa.md");
  });

  it("a terminal focused after that panel was activated wins it back", async () => {
    const resolveZoomTarget = await target();
    expect(
      resolveZoomTarget({ pid: "md:%2Fa.md", at: 100 }, { pid: "term:s:main", at: 200 }),
    ).toBe("term:s:main");
  });

  it("keeps the focused terminal when the newer active panel has no kind", async () => {
    const resolveZoomTarget = await target();
    expect(
      resolveZoomTarget({ pid: "preview:%2Fa.md", at: 200 }, { pid: "term:s:main", at: 100 }),
    ).toBe("term:s:main");
  });

  it("names the active panel when no terminal holds focus, else nothing", async () => {
    const resolveZoomTarget = await target();
    expect(resolveZoomTarget({ pid: "md:%2Fa.md", at: 100 }, { pid: null, at: 0 })).toBe(
      "md:%2Fa.md",
    );
    expect(resolveZoomTarget({ pid: "preview:%2Fa.md", at: 100 }, { pid: null, at: 0 })).toBe(
      "preview:%2Fa.md",
    );
    expect(resolveZoomTarget({ pid: null, at: 0 }, { pid: null, at: 0 })).toBeNull();
  });
});

describe("tabZoom -> panelZoom migration", () => {
  it("converts px font sizes to term factors, once", async () => {
    const { localStore } = freshGlobals({ tabZoom: JSON.stringify({ "s:main": 26 }) });
    const { settings } = await import("./0_settings");
    expect(settings.panelZoom.$()["term:s:main"]).toBeCloseTo(26 / 13);
    expect(localStore.getItem("panelZoomV1")).toBe("1");
    expect(localStore.getItem("tabZoom")).toBeNull();
  });

  it("leaves existing panelZoom entries alone", async () => {
    freshGlobals({
      tabZoom: JSON.stringify({ "s:main": 26 }),
      panelZoom: JSON.stringify({ "md:/x.md": 1.5 }),
    });
    const { settings } = await import("./0_settings");
    expect(settings.panelZoom.$()["md:/x.md"]).toBe(1.5);
    expect(settings.panelZoom.$()["term:s:main"]).toBeCloseTo(2);
  });
});
