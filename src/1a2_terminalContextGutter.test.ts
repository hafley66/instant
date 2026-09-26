import { describe, expect, it } from "vitest";
import { structuredSelectables } from "./1a2_terminalContextGutter";

describe("structured rows a gutter checkbox is offered on", () => {
  it("projects one selectable onto a heading region, at the heading's own row", () => {
    expect(structuredSelectables([{
      regions: [{
        id: "s:1:heading:4", turnId: "s:1", kind: "heading", sourceStart: 4, sourceEnd: 4,
        bufferStart: 70, bufferEnd: 70, text: "## Storage layout",
      }],
    }])).toEqual([
      { bufferRow: 70, id: "s:1:heading:4:heading", kind: "heading", text: "## Storage layout", turnId: "s:1" },
    ]);
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

