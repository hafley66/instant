import { describe, expect, it } from "vitest";
import { bracketedPaste, quoteForPrompt } from "./promptQuote";

describe("bracketedPaste", () => {
  it("wraps the body in the paste markers", () => {
    expect(bracketedPaste("hello")).toBe("\x1b[200~hello\x1b[201~");
  });

  // The whole point: a bare \n written to a pty is Enter, so a three-line body
  // would submit three times. Inside the markers the app inserts them.
  it("keeps newlines, which a bare write would submit on", () => {
    expect(bracketedPaste("a\nb")).toBe("\x1b[200~a\nb\x1b[201~");
  });

  it("normalises CRLF and CR to one newline each", () => {
    expect(bracketedPaste("a\r\nb\rc")).toBe("\x1b[200~a\nb\nc\x1b[201~");
  });

  // An ESC in the body would close the paste early and the rest would run as
  // keystrokes against the agent's input bar.
  it("drops an embedded ESC rather than letting it end the paste", () => {
    expect(bracketedPaste("a\x1b[201~rm -rf /")).toBe("\x1b[200~a [201~rm -rf /\x1b[201~");
  });

  it("drops tabs and other control bytes but not newlines", () => {
    expect(bracketedPaste("a\tb\x00c\nd")).toBe("\x1b[200~a b c\nd\x1b[201~");
  });
});

describe("quoteForPrompt", () => {
  it("prefixes every line and leaves a blank line for the question", () => {
    expect(quoteForPrompt("first\nsecond")).toBe("> first\n> second\n\n");
  });

  it("leaves a blank source line as a bare marker, with no trailing space", () => {
    expect(quoteForPrompt("first\n\nthird")).toBe("> first\n>\n> third\n\n");
  });

  it("quotes a single line", () => {
    expect(quoteForPrompt("just this")).toBe("> just this\n\n");
  });
});
