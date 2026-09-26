import { describe, expect, it } from "vitest";
import { structuredRegionMarkup } from "./1_terminalStructuredOverlay";

describe("terminal structured region renderer", () => {
  it("renders a Markdown table as a real table", () => {
    expect(structuredRegionMarkup({
      id: "s:1:table:0", turnId: "s:1", kind: "table", sourceStart: 0, sourceEnd: 3,
      bufferStart: 4, bufferEnd: 7, text: "| Name | State |\n| --- | --- |\n| alpha | visible |\n| beta | hidden |",
    })).toMatchInlineSnapshot(`"<table><thead><tr><th>Name</th><th>State</th></tr></thead><tbody><tr><td>alpha</td><td>visible</td></tr><tr><td>beta</td><td>hidden</td></tr></tbody></table>"`);
  });

  it("renders Markdown list items and escapes message HTML", () => {
    expect(structuredRegionMarkup({
      id: "s:2:list:0", turnId: "s:2", kind: "list", sourceStart: 0, sourceEnd: 1,
      bufferStart: 8, bufferEnd: 9, text: "- visible\n- <script>hidden</script>",
    })).toMatchInlineSnapshot(`"<ul><li>visible</li><li>&lt;script&gt;hidden&lt;/script&gt;</li></ul>"`);
  });
});
