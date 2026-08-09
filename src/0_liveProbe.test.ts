import { describe, expect, it, vi } from "vitest";
import { countDomNodes, createLiveProbe, selectProbeRoot } from "./0_liveProbe";

describe("live probe", () => {
  it("keeps render and operation counts separate while retaining a bounded event log", async () => {
    const probe = createLiveProbe(2);
    const listener = vi.fn();
    const unsubscribe = probe.subscribe(listener);
    probe.record({ kind: "render", name: "SvgDocumentViewer", scope: "/tmp/chart.svg" });
    probe.record({ kind: "operation", name: "preview.renderD2", scope: "/tmp/chart.d2" });
    probe.record({ kind: "render", name: "SvgDocumentViewer", scope: "/tmp/chart.svg" });
    await Promise.resolve();

    expect({
      eventCount: probe.snapshot().eventCount,
      renderCounts: probe.snapshot().renderCounts,
      operationCounts: probe.snapshot().operationCounts,
      recent: probe.snapshot().recentEvents.map(({ sequence, kind, name, scope }) => ({ sequence, kind, name, scope })),
      notifications: listener.mock.calls.length,
    }).toMatchInlineSnapshot(`
      {
        "eventCount": 3,
        "notifications": 1,
        "operationCounts": {
          "preview.renderD2": 1,
        },
        "recent": [
          {
            "kind": "operation",
            "name": "preview.renderD2",
            "scope": "/tmp/chart.d2",
            "sequence": 2,
          },
          {
            "kind": "render",
            "name": "SvgDocumentViewer",
            "scope": "/tmp/chart.svg",
            "sequence": 3,
          },
        ],
        "renderCounts": {
          "SvgDocumentViewer": 2,
        },
      }
    `);
    unsubscribe();
  });

  it("counts a probe boundary and all descendants without observing mutations", () => {
    const root = { querySelectorAll: () => [{}, {}, {}] } as unknown as HTMLElement;
    expect(countDomNodes(root)).toBe(4);
    expect(countDomNodes(null)).toBe(0);
  });

  it("uses the explicit tab root before the local media wrapper", () => {
    const tabRoot = { querySelectorAll: () => [{}, {}, {}, {}, {}] } as unknown as HTMLElement;
    const mediaRoot = { querySelectorAll: () => [{}] } as unknown as HTMLElement;
    expect(countDomNodes(selectProbeRoot(tabRoot, mediaRoot))).toBe(6);
  });
});
