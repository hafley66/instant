import { describe, expect, it } from "vitest";
import { detectTurnRegions, projectTurnRegions } from "./00_terminalTurnRegions";

describe("terminal turn regions", () => {
  it("detects an ATX heading and a bold-only title line as one-line heading regions", () => {
    expect(detectTurnRegions([
      "## Plan",
      "prose under it",
      "**Storage layout:**",
      "- item",
      "#not a heading",
    ].join("\n")).filter((region) => region.kind === "heading")).toEqual([
      { kind: "heading", sourceStart: 0, sourceEnd: 0, text: "## Plan" },
      { kind: "heading", sourceStart: 2, sourceEnd: 2, text: "**Storage layout:**" },
    ]);
  });

  it("keeps a heading out of the list that follows it", () => {
    const regions = detectTurnRegions(["# Title", "- a", "- b"].join("\n"));
    expect(regions.map((region) => [region.kind, region.sourceStart, region.sourceEnd])).toEqual([
      ["heading", 0, 0],
      ["list", 1, 2],
    ]);
  });

  it("detects diagram, table, and list regions in source order", () => {
    expect(detectTurnRegions([
      "before",
      "```mermaid",
      "flowchart LR",
      "A --> B",
      "```",
      "| name | state |",
      "| --- | ---: |",
      "| tmux | visible |",
      "- first",
      "  continuation",
      "- second",
    ].join("\n"))).toMatchInlineSnapshot(`
      [
        {
          "kind": "mermaid",
          "sourceEnd": 4,
          "sourceStart": 1,
          "text": "flowchart LR
      A --> B",
        },
        {
          "kind": "table",
          "sourceEnd": 7,
          "sourceStart": 5,
          "text": "| name | state |
      | --- | ---: |
      | tmux | visible |",
        },
        {
          "kind": "list",
          "sourceEnd": 10,
          "sourceStart": 8,
          "text": "- first
        continuation
      - second",
        },
      ]
    `);
  });

  it("does not parse diff lines inside a generic code fence as list items", () => {
    expect(detectTurnRegions("```diff\n- removed\n+ added\n```\n- actual item")).toMatchInlineSnapshot(`
      [
        {
          "kind": "list",
          "sourceEnd": 4,
          "sourceStart": 4,
          "text": "- actual item",
        },
      ]
    `);
  });

  it("projects a diagram through physically wrapped xterm rows", () => {
    const said = ["before", "```d2", "a -> a very long node name", "b -> c", "```", "after"].join("\n");
    expect(projectTurnRegions("s:4", said, { bufferStart: 20, bufferEnd: 29 }, [
      { text: "before", start: 20, end: 20 },
      { text: "d2", start: 21, end: 21 },
      { text: "a -> a very long node name", start: 22, end: 24 },
      { text: "b -> c", start: 25, end: 25 },
      { text: "after", start: 26, end: 26 },
    ], (line) => line.trim().toLowerCase())).toMatchInlineSnapshot(`
      [
        {
          "bufferEnd": 25,
          "bufferStart": 22,
          "id": "s:4:d2:1",
          "kind": "d2",
          "sourceBufferRows": [
            null,
            22,
            25,
            null,
          ],
          "sourceEnd": 4,
          "sourceStart": 1,
          "text": "a -> a very long node name
      b -> c",
          "turnId": "s:4",
        },
      ]
    `);
  });

  it("preserves each list item's physical row after a wrapped item", () => {
    const said = "- first item wraps onto another physical row\n- second item";
    const [region] = projectTurnRegions("s:10", said, { bufferStart: 30, bufferEnd: 33 }, [
      { text: "- first item wraps onto another physical row", start: 30, end: 31 },
      { text: "- second item", start: 32, end: 32 },
    ], (line) => line.trim());
    expect(region).toMatchObject({
      kind: "list",
      sourceBufferRows: [30, 32],
    });
  });

  it("uses one consistent offset when sequence-diagram keywords repeat", () => {
    const said = [
      "prose before",
      "```mermaid",
      "sequenceDiagram",
      "participant Host",
      "participant Kid",
      "activate Host",
      "Host->>Kid: startup",
      "deactivate Host",
      "activate Kid",
      "Kid->>Host: response",
      "deactivate Kid",
      "```",
    ].join("\n");
    expect(projectTurnRegions("s:9", said, { bufferStart: 100, bufferEnd: 140 }, [
      { text: "older activate Host prose", start: 101, end: 101 },
      { text: "sequenceDiagram", start: 120, end: 120 },
      { text: "participant Host", start: 121, end: 121 },
      { text: "participant Kid", start: 122, end: 122 },
      { text: "activate Host", start: 123, end: 123 },
      { text: "Host->>Kid: startup", start: 124, end: 124 },
      { text: "deactivate Host", start: 125, end: 125 },
      { text: "activate Kid", start: 126, end: 126 },
      { text: "Kid->>Host: response", start: 127, end: 127 },
      { text: "deactivate Kid", start: 128, end: 128 },
    ], (line) => line.trim())).toMatchObject([{
      kind: "mermaid",
      bufferStart: 120,
      bufferEnd: 128,
    }]);
  });
});
