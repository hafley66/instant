import { describe, expect, it } from "vitest";
import { formatQueuedContext, type PromptContextItem } from "./1a_terminalContextQueue";

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
