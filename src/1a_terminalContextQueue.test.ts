import { describe, expect, it } from "vitest";
import { formatQueuedContext, structuredSelectables, type PromptContextItem } from "./1a_terminalContextQueue";

describe("terminal next-message context", () => {
  it("formats enabled editable selections and canonical tables", () => {
    expect(formatQueuedContext([
      { id: "s", kind: "selection", text: " selected text ", turnIds: ["boop:4"], enabled: true },
      { id: "off", kind: "selection", text: "skip", turnIds: [], enabled: false },
      { id: "t", kind: "table", text: "| A | B |\n|---|---|\n| 1 | 2 |", turnIds: ["boop:5"], enabled: true },
    ])).toMatchInlineSnapshot(`
      "Selected context:

      [turn boop:4]
      selected text

      [turn boop:5]
      | A | B |
      |---|---|
      | 1 | 2 |

      "
    `);
  });

  it("projects one selectable onto each table row and list item start", () => {
    expect(structuredSelectables([{
      regions: [
        {
          id: "s:1:table:0", turnId: "s:1", kind: "table", sourceStart: 0, sourceEnd: 3,
          bufferStart: 40, bufferEnd: 43, text: "| Name | State |\n| --- | --- |\n| alpha | visible |\n| beta | hidden |",
        },
        {
          id: "s:1:list:5", turnId: "s:1", kind: "list", sourceStart: 5, sourceEnd: 8,
          bufferStart: 50, bufferEnd: 53, text: "- first item\n  continued\n- second item\n  continued again",
        },
      ],
    }])).toMatchInlineSnapshot(`
      [
        {
          "bufferRow": 40,
          "id": "s:1:table:0:row:0",
          "kind": "table",
          "text": "| Name | State |",
          "turnId": "s:1",
        },
        {
          "bufferRow": 42,
          "id": "s:1:table:0:row:2",
          "kind": "table",
          "text": "| alpha | visible |",
          "turnId": "s:1",
        },
        {
          "bufferRow": 43,
          "id": "s:1:table:0:row:3",
          "kind": "table",
          "text": "| beta | hidden |",
          "turnId": "s:1",
        },
        {
          "bufferRow": 50,
          "id": "s:1:list:5:item:0",
          "kind": "list",
          "text": "- first item
        continued",
          "turnId": "s:1",
        },
        {
          "bufferRow": 52,
          "id": "s:1:list:5:item:2",
          "kind": "list",
          "text": "- second item
        continued again",
          "turnId": "s:1",
        },
      ]
    `);
  });

  it("does not paint source items without a matched xterm row", () => {
    expect(structuredSelectables([{
      regions: [{
        id: "s:2:list:0", turnId: "s:2", kind: "list", sourceStart: 0, sourceEnd: 1,
        bufferStart: 80, bufferEnd: 80, sourceBufferRows: [null, 80], text: "- hidden item\n- visible item",
      }],
    }])).toMatchInlineSnapshot(`
      [
        {
          "bufferRow": 80,
          "id": "s:2:list:0:item:1",
          "kind": "list",
          "text": "- visible item",
          "turnId": "s:2",
        },
      ]
    `);
  });

  it("recovers a projected miss from an exact visible numbered-list line", () => {
    expect(structuredSelectables([{
      regions: [{
        id: "s:3:list:0", turnId: "s:3", kind: "list", sourceStart: 0, sourceEnd: 1,
        bufferStart: 90, bufferEnd: 91, sourceBufferRows: [90, null], text: "1. first\n2. second",
      }],
    }], [{ bufferStart: 90, text: "1. first" }, { bufferStart: 91, text: "2. second" }])).toMatchInlineSnapshot(`
      [
        {
          "bufferRow": 90,
          "id": "s:3:list:0:item:0",
          "kind": "list",
          "text": "1. first",
          "turnId": "s:3",
        },
        {
          "bufferRow": 91,
          "id": "s:3:list:0:item:1",
          "kind": "list",
          "text": "2. second",
          "turnId": "s:3",
        },
      ]
    `);
  });

  it("does not invent a selectable for an xterm item absent from the Boop region", () => {
    expect(structuredSelectables([{
      regions: [{
        id: "s:4:list:0", turnId: "s:4", kind: "list", sourceStart: 0, sourceEnd: 1,
        bufferStart: 100, bufferEnd: 102, sourceBufferRows: [100, 102], text: "- first\n- third",
      }],
    }], [
      { bufferStart: 100, text: "- first" },
      { bufferStart: 101, text: "- second present in xterm" },
      { bufferStart: 102, text: "- third" },
      { bufferStart: 103, text: "• Ran a tool outside the list" },
    ])).toMatchInlineSnapshot(`
      [
        {
          "bufferRow": 100,
          "id": "s:4:list:0:item:0",
          "kind": "list",
          "text": "- first",
          "turnId": "s:4",
        },
        {
          "bufferRow": 102,
          "id": "s:4:list:0:item:1",
          "kind": "list",
          "text": "- third",
          "turnId": "s:4",
        },
      ]
    `);
  });
});

describe("the note is the intent, kept apart from the slice", () => {
  const slice = (over: Partial<PromptContextItem> = {}): PromptContextItem => ({
    id: "selection:1",
    kind: "selection",
    text: "const shift = spans.map((s) => s.row);",
    turnIds: ["session-a:257"],
    enabled: true,
    ...over,
  });

  it("emits the quote alone when nothing was annotated", () => {
    expect(formatQueuedContext([slice()])).toBe(
      "Selected context:\n\n[turn session-a:257]\nconst shift = spans.map((s) => s.row);\n\n",
    );
  });

  it("puts the note under the quote and says which is which", () => {
    expect(formatQueuedContext([slice({ note: "why is this off by one" })])).toBe(
      "Selected context:\n\n[turn session-a:257]\nconst shift = spans.map((s) => s.row);"
      + "\n\nAbout that: why is this off by one\n\n",
    );
  });

  it("ignores a note that is only whitespace", () => {
    expect(formatQueuedContext([slice({ note: "   \n " })])).toBe(
      "Selected context:\n\n[turn session-a:257]\nconst shift = spans.map((s) => s.row);\n\n",
    );
  });

  // A slice the reader unchecked is out of the prompt, note and all.
  it("drops a disabled slice even when it carries a note", () => {
    expect(formatQueuedContext([slice({ enabled: false, note: "keep for later" })])).toBe("");
  });

  it("keeps each slice's note with its own quote", () => {
    const body = formatQueuedContext([
      slice({ id: "a", note: "first intent" }),
      slice({ id: "b", text: "second slice", turnIds: ["session-a:258"], note: "second intent" }),
    ]);
    expect(body).toContain("[turn session-a:257]\nconst shift = spans.map((s) => s.row);\n\nAbout that: first intent");
    expect(body).toContain("[turn session-a:258]\nsecond slice\n\nAbout that: second intent");
  });
});
