import { describe, it, expect } from "vitest";
import {
  joinWrappedRows,
  mapSpanToRowRanges,
  capWrappedRows,
  wrappedLinkSpans,
  MAX_WRAP_ROWS,
  type WrapRow,
} from "./termWrapJoin";
import { scanLineTokens } from "./termTokens";

const row = (text: string, isWrapped = false): WrapRow => ({ text, isWrapped });

describe("joinWrappedRows", () => {
  it("joins two rows with correct start offsets", () => {
    const joined = joinWrappedRows([row("…/instant-lab-"), row("dock/e2e.png", true)]);
    expect(joined.text).toBe("…/instant-lab-dock/e2e.png");
    expect(joined.rowStartOffsets).toEqual([0, 14]); // "…/instant-lab-".length
  });

  it("joins three rows with running offsets", () => {
    const joined = joinWrappedRows([row("aa"), row("bb", true), row("cc", true)]);
    expect(joined.text).toBe("aabbcc");
    expect(joined.rowStartOffsets).toEqual([0, 2, 4]);
  });

  it("keeps offsets by string length, not by some cols arithmetic", () => {
    // 日本語 is three characters in string length; the join must count them as 3.
    const joined = joinWrappedRows([row("Update(日本"), row("語.ts)", true)]);
    expect(joined.text).toBe("Update(日本語.ts)");
    expect(joined.rowStartOffsets).toEqual([0, 9]); // 9 = "Update(日本".length
  });
});

describe("mapSpanToRowRanges", () => {
  // "…/instant-lab-" | "dock/e2e.png": row0 = chars 0..13, row1 = chars 14..26.
  const joined = joinWrappedRows([row("…/instant-lab-"), row("dock/e2e.png", true)]);

  it("gives one range for a span fully inside one row", () => {
    // "instant-lab-" spans offsets 2..14 of the joined text, all in row0.
    const spans = mapSpanToRowRanges({ start: 2, end: 14 }, joined);
    expect(spans).toEqual([{ rowIndex: 0, startCol: 2, endCol: 14 }]);
  });

  it("splits a boundary-crossing span into two ranges", () => {
    // The whole path "/instant-lab-dock/e2e.png": offsets 1..26.
    const spans = mapSpanToRowRanges({ start: 1, end: 26 }, joined);
    expect(spans).toEqual([
      { rowIndex: 0, startCol: 1, endCol: 14 },
      { rowIndex: 1, startCol: 0, endCol: 12 },
    ]);
  });

  it("maps a span that lands entirely on the second row", () => {
    // "/e2e.p" spans offsets 19..25 of the joined text, all in row1.
    const spans = mapSpanToRowRanges({ start: 19, end: 25 }, joined);
    expect(spans).toEqual([{ rowIndex: 1, startCol: 5, endCol: 11 }]);
  });

  it("every range slices back to the span's text within its row", () => {
    for (const span of scanLineTokens(joined.text)) {
      const ranges = mapSpanToRowRanges(span, joined);
      let rebuilt = "";
      for (const r of ranges) {
        rebuilt += joined.text.slice(
          joined.rowStartOffsets[r.rowIndex] + r.startCol,
          joined.rowStartOffsets[r.rowIndex] + r.endCol,
        );
      }
      expect(rebuilt).toBe(span.text);
      expect(ranges.length).toBeGreaterThan(0);
    }
  });
});

describe("capWrappedRows", () => {
  it("leaves a line under the cap unchanged", () => {
    const rows = [row("a"), row("b", true), row("c", true)];
    expect(capWrappedRows(rows, 1, false)).toEqual({ rows, index: 1 });
  });

  it("degrades an over-cap line to the single clicked row", () => {
    const rows = Array.from({ length: MAX_WRAP_ROWS + 5 }, (_, i) =>
      row(`row${i}`, i > 0),
    );
    const capped = capWrappedRows(rows, 7, true);
    expect(capped.rows).toEqual([{ text: "row7", isWrapped: false }]);
    expect(capped.index).toBe(0);
  });
});

describe("wrappedLinkSpans", () => {
  it("emits one multi-row link for a path split across a boundary", () => {
    // /tmp/term-e2e/src/mdview/MdPanel.tsx cut after "mdview/".
    // Row0 = "Update(/tmp/term-e2e/src/mdview/" (32 chars, path cols 7..32),
    // row1 = "MdPanel.tsx)" (path cols 0..11).
    const rows = [row("Update(/tmp/term-e2e/src/mdview/"), row("MdPanel.tsx)", true)];
    const links = wrappedLinkSpans(rows, (t) => t.includes("/"));
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("/tmp/term-e2e/src/mdview/MdPanel.tsx");
    expect(links[0].ranges).toEqual([
      { rowIndex: 0, startCol: 7, endCol: 32 },
      { rowIndex: 1, startCol: 0, endCol: 11 },
    ]);
  });

  it("keeps an intra-row link on a single range", () => {
    const rows = [row("Update(src/main.ts)")];
    const links = wrappedLinkSpans(rows, (t) => t.includes("."));
    expect(links[0].text).toBe("src/main.ts");
    expect(links[0].ranges).toEqual([{ rowIndex: 0, startCol: 7, endCol: 18 }]);
  });

  it("emits one link for a quoted path whose spaces straddle a wrap", () => {
    const shot = "/tmp/shots/Screenshot 2026-08-03 at 10.05.13 AM.png";
    const rows = [row(`open '${shot.slice(0, 30)}`), row(`${shot.slice(30)}' now`, true)];
    const links = wrappedLinkSpans(rows, (t) => t.includes("/"));
    expect(links.map((l) => l.text)).toEqual([shot]);
    expect(links[0].ranges).toEqual([
      { rowIndex: 0, startCol: 6, endCol: 36 },
      { rowIndex: 1, startCol: 0, endCol: 21 },
    ]);
  });

  it("keeps a wrapped quoted path whole when prose above it holds an apostrophe", () => {
    const shot = "/tmp/my shots/a b.png";
    const rows = [row("don't open '/tmp/my sho"), row("ts/a b.png' yet", true)];
    const links = wrappedLinkSpans(rows, (t) => t.includes("/"));
    expect(links.map((l) => l.text)).toEqual([shot]);
  });
});
