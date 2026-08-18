import { describe, expect, it } from "vitest";
import type { AgentSessionNode } from "./plugins/harnessTrace/0_types";
import { familyGeometry } from "./1b_BoopFamilyGraph";

function node(id: string, ts: string, parentId: string | null): AgentSessionNode {
  return {
    id,
    harness: "codex",
    parentId,
    parentKind: parentId ? "dispatch" : null,
    from: "user",
    why: "",
    cwd: "/repo",
    ts,
    lastActivity: ts,
    status: "live",
  };
}

describe("familyGeometry", () => {
  it("uses the observed timestamp domain and tree depth", () => {
    const geometry = familyGeometry([
      node("root", "2026-08-18T12:00:00.000Z", null),
      node("middle", "2026-08-18T12:00:05.000Z", "root"),
      node("last", "2026-08-18T12:00:10.000Z", "middle"),
    ]);

    expect({
      nodeIds: geometry.nodeIds,
      positions: [...geometry.positions],
      edges: geometry.edges,
    }).toMatchInlineSnapshot(`
      {
        "edges": [
          [
            0,
            1,
          ],
          [
            1,
            2,
          ],
        ],
        "nodeIds": [
          "root",
          "middle",
          "last",
        ],
        "positions": [
          0,
          10,
          500,
          28,
          1000,
          46,
        ],
      }
    `);
  });
});
