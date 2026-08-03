import { describe, it, expect } from "vitest";
import { scanLineTokens, tokenAtColumn, unwrapToken, splitLineRef } from "./termTokens";

// The span a caller would highlight, rendered against the source line, so a
// failure shows the drift instead of two column numbers.
function underline(line: string, col: number): string {
  const span = tokenAtColumn(line, col);
  if (!span) return "";
  return " ".repeat(span.start) + "^".repeat(span.end - span.start);
}

describe("unwrapToken", () => {
  it("keeps a plain path whole", () => {
    expect(unwrapToken("src/main.ts")).toEqual({ text: "src/main.ts", offset: 0 });
  });

  it("peels an agent tool-call envelope", () => {
    expect(unwrapToken("Update(src/main.ts)")).toEqual({ text: "src/main.ts", offset: 7 });
    expect(unwrapToken("Read(/abs/f.ts)")).toEqual({ text: "/abs/f.ts", offset: 5 });
    expect(unwrapToken("Updated(src/main.ts)")).toEqual({ text: "src/main.ts", offset: 8 });
  });

  it("peels a dotted or dashed caller name", () => {
    expect(unwrapToken("fs.readFile(src/a.ts)").text).toBe("src/a.ts");
    expect(unwrapToken("Bash-run(scripts/x.sh)").text).toBe("scripts/x.sh");
  });

  it("peels square-bracket call and markdown link forms", () => {
    expect(unwrapToken("Read[src/a.ts]")).toEqual({ text: "src/a.ts", offset: 5 });
    expect(unwrapToken("[main.ts](src/main.ts)")).toEqual({ text: "src/main.ts", offset: 10 });
  });

  it("strips wrapping punctuation and sentence tails", () => {
    expect(unwrapToken("(src/main.ts)")).toEqual({ text: "src/main.ts", offset: 1 });
    expect(unwrapToken("see src/main.ts.".split(" ")[1])).toEqual({ text: "src/main.ts", offset: 0 });
    expect(unwrapToken("`src/main.ts`,")).toEqual({ text: "src/main.ts", offset: 1 });
    expect(unwrapToken("src/main.ts!?")).toEqual({ text: "src/main.ts", offset: 0 });
  });

  it("keeps a line suffix attached", () => {
    expect(unwrapToken("Update(src/main.ts:42)").text).toBe("src/main.ts:42");
    expect(unwrapToken("src/main.ts:42:7").text).toBe("src/main.ts:42:7");
  });

  it("leaves a url intact", () => {
    expect(unwrapToken("https://example.com/a(b)")).toEqual({
      text: "https://example.com/a(b)",
      offset: 0,
    });
  });
});

describe("tokenAtColumn", () => {
  const line = "  Update(src/main.ts)";

  it("underlines only the path inside the envelope", () => {
    expect(underline(line, 12)).toBe("         ^^^^^^^^^^^");
    expect(tokenAtColumn(line, 12)?.text).toBe("src/main.ts");
  });

  it("reports no token over the envelope itself", () => {
    expect(tokenAtColumn(line, 2)).toBeNull(); // the "U" of Update
    expect(tokenAtColumn(line, 20)).toBeNull(); // the closing paren
  });

  it("covers the whole path but stops at its ends", () => {
    expect(tokenAtColumn(line, 9)?.text).toBe("src/main.ts"); // first char
    expect(tokenAtColumn(line, 19)?.text).toBe("src/main.ts"); // last char
    expect(tokenAtColumn(line, 8)).toBeNull(); // the opening paren
  });

  it("returns nothing in whitespace", () => {
    expect(tokenAtColumn(line, 0)).toBeNull();
    expect(tokenAtColumn(line, 999)).toBeNull();
  });
});

describe("scanLineTokens", () => {
  it("keeps a quoted path with spaces as one token", () => {
    const line = `open "/tmp/my shots/a b.png" now`;
    const spans = scanLineTokens(line);
    const quoted = spans.find((s) => s.text.includes(" "));
    expect(quoted?.text).toBe("/tmp/my shots/a b.png");
    expect(line.slice(quoted!.start, quoted!.end)).toBe("/tmp/my shots/a b.png");
    expect(tokenAtColumn(line, 12)?.text).toBe("/tmp/my shots/a b.png");
  });

  it("does not emit the fragments inside a quoted span", () => {
    const spans = scanLineTokens(`x "a b.png" y`);
    expect(spans.map((s) => s.text)).toEqual(["x", "a b.png", "y"]);
  });

  it("scans a real agent transcript line", () => {
    const line = "  Update(src/main.ts) and Read(src/preview.ts:214)";
    expect(scanLineTokens(line).map((s) => s.text)).toEqual([
      "src/main.ts",
      "and",
      "src/preview.ts:214",
    ]);
  });

  it("every span slices back to its own text", () => {
    const line = "Update(a/b.ts) 'q p.md' plain (c.ts), d.ts.";
    for (const span of scanLineTokens(line)) {
      expect(line.slice(span.start, span.end)).toBe(span.text);
    }
  });

  it("produces non-overlapping spans in column order", () => {
    const spans = scanLineTokens("Update(a.ts) `b.ts` c.ts");
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
    }
  });
});

// The screenshot path a macOS capture drops on the pasteboard: spaces in the
// file name, quoted by whatever wrote the line.
const SHOT =
  "/var/folders/3k/qz9_8x0d1_v0000gn/T/TemporaryItems/NSIRD_screencaptureui_9Kq2Zt/Screenshot 2026-08-03 at 10.05.13 AM.png";

describe("quote pairing", () => {
  it("links the whole quoted screenshot path", () => {
    const line = `'${SHOT}'`;
    expect(scanLineTokens(line).map((s) => s.text)).toEqual([SHOT]);
    expect(tokenAtColumn(line, 100)?.text).toBe(SHOT);
  });

  it("links the quoted screenshot path with prose on both sides", () => {
    const line = `read '${SHOT}' please`;
    expect(scanLineTokens(line).map((s) => s.text)).toEqual(["read", SHOT, "please"]);
  });

  it("does not let a possessive apostrophe open a span", () => {
    const line = "reading claude's log at '/a b/c.png'";
    expect(scanLineTokens(line).map((s) => s.text)).toEqual([
      "reading",
      "claude's",
      "log",
      "at",
      "/a b/c.png",
    ]);
    expect(underline(line, 26)).toBe(" ".repeat(25) + "^".repeat(10));
  });

  it("does not let a contraction apostrophe open a span", () => {
    const line = "don't open '/tmp/my shots/a b.png' yet";
    expect(scanLineTokens(line).map((s) => s.text)).toEqual([
      "don't",
      "open",
      "/tmp/my shots/a b.png",
      "yet",
    ]);
  });

  it("keeps spans non-overlapping on apostrophe prose", () => {
    for (const line of [
      "reading claude's log at '/a b/c.png'",
      "don't open '/tmp/my shots/a b.png' yet",
      "it's the agents' '/a b/c.png' file",
      `path='${SHOT}'`,
    ]) {
      const spans = scanLineTokens(line);
      for (let i = 1; i < spans.length; i++) {
        expect(spans[i].start).toBeGreaterThanOrEqual(spans[i - 1].end);
      }
      for (const span of spans) expect(line.slice(span.start, span.end)).toBe(span.text);
    }
  });

  it("pairs a quote opened right after an assignment or bracket", () => {
    expect(scanLineTokens(`path='${SHOT}'`).map((s) => s.text)).toEqual([SHOT]);
    expect(scanLineTokens("see `src/main.ts`, ok").map((s) => s.text)).toEqual([
      "see",
      "src/main.ts",
      "ok",
    ]);
  });

  // An opener whose closer never arrives on this line carries no information
  // about where the path ends, so the whitespace-run fallback stands: the span
  // stops at the first space rather than dispatching a truncated path with
  // spaces as if it were the whole file name.
  it("leaves an unpaired opening quote to the whitespace-run fallback", () => {
    const line = "'/tmp/shots/Screenshot 2026-08-03 at 10";
    expect(scanLineTokens(line).map((s) => s.text)).toEqual([
      "/tmp/shots/Screenshot",
      "2026-08-03",
      "at",
      "10",
    ]);
  });
});

describe("splitLineRef", () => {
  it("splits line and column suffixes", () => {
    expect(splitLineRef("src/main.ts:42")).toEqual({ path: "src/main.ts", line: 42 });
    expect(splitLineRef("src/main.ts:42:7")).toEqual({ path: "src/main.ts", line: 42 });
  });

  it("leaves a bare path alone", () => {
    expect(splitLineRef("src/main.ts")).toEqual({ path: "src/main.ts" });
  });

  it("does not split a url port", () => {
    expect(splitLineRef("http://localhost:5173")).toEqual({ path: "http://localhost:5173" });
  });
});
