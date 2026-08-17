import { describe, expect, it } from "vitest";
import {
  externalShellOpenSessionArgs,
  externalViewerTarget,
  liveExternalShellRows,
  persistedViewerTarget,
  viewerFailureAction,
} from "./0_externalShells";

describe("external shell viewer targets", () => {
  it("keeps only live rows and preserves each exact tmux target", () => {
    expect(liveExternalShellRows([
      { lane: "codex-590", state: "live", tmux: "%590" },
      { lane: "claude-707", state: "dead", tmux: "%707" },
      { lane: "native", state: "live", tmux: "" },
    ])).toMatchInlineSnapshot(`
      [
        {
          "lane": "codex-590",
          "state": "live",
          "tmux": "%590",
        },
      ]
    `);
  });
  it("keeps the lane identity and pane target separate", () => {
    expect(persistedViewerTarget(externalViewerTarget("luna", "%509"))).toMatchInlineSnapshot(`
      {
        "name": "luna",
        "tmuxTarget": "%509",
        "viewer": true,
      }
    `);
  });

  it("removes a viewer tab after an attach failure", () => {
    expect(viewerFailureAction(true)).toBe("remove");
    expect(viewerFailureAction(false)).toBe("retain");
  });

  it("carries a parsed Boop row through the open_session viewer contract", () => {
    const row = { lane: "terra", tmux: "%509" };
    expect(externalShellOpenSessionArgs(externalViewerTarget(row.lane, row.tmux), {
      id: "s:terra",
      cols: 120,
      rows: 40,
      cellW: 8,
      cellH: 16,
    })).toMatchInlineSnapshot(`
      {
        "attachOnly": true,
        "cellH": 16,
        "cellW": 8,
        "cols": 120,
        "command": null,
        "cwd": null,
        "graphics": false,
        "id": "s:terra",
        "name": "terra",
        "rows": 40,
        "tmuxTarget": "%509",
      }
    `);
  });
});
