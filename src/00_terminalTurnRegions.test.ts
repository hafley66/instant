import { describe, expect, it } from "vitest";
import { detectTurnRegions, projectTurnRegions } from "./00_terminalTurnRegions";

describe("terminal turn regions", () => {
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
          "bufferEnd": 26,
          "bufferStart": 21,
          "id": "s:4:d2:1",
          "kind": "d2",
          "sourceEnd": 4,
          "sourceStart": 1,
          "text": "a -> a very long node name
      b -> c",
          "turnId": "s:4",
        },
      ]
    `);
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
      bufferStart: 119,
      bufferEnd: 129,
    }]);
  });
});
