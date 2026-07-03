import { describe, it, expect } from "vitest";
import { fuzzyScore, fuzzyFilter } from "./fuzzy";

describe("fuzzyScore", () => {
  it("returns 0 for an empty query", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("returns null when the query is longer than the text", () => {
    expect(fuzzyScore("abcd", "abc")).toBeNull();
  });

  it("returns null when a query char is missing from the text", () => {
    expect(fuzzyScore("xyz", "abc")).toBeNull();
  });

  it("matches a non-contiguous subsequence", () => {
    expect(fuzzyScore("ac", "abc")).not.toBeNull();
  });

  it("requires subsequence order (matches must occur in order)", () => {
    // "ba" is not a subsequence of "abc" ('b' before 'a')
    expect(fuzzyScore("ba", "abc")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("ABC", "abc")).not.toBeNull();
    expect(fuzzyScore("abc", "ABC")).not.toBeNull();
    // Query case doesn't affect the score (text case can, via the camelHump
    // boundary bonus, so hold the text fixed and only vary query case).
    expect(fuzzyScore("ABC", "abcxxx")).toBe(fuzzyScore("abc", "abcxxx"));
  });

  it("scores a consecutive run higher than a scattered match", () => {
    const consecutive = fuzzyScore("abc", "abcxxx");
    const scattered = fuzzyScore("abc", "axbxcx");
    expect(consecutive).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect(consecutive as number).toBeGreaterThan(scattered as number);
  });

  it("scores a word-start / boundary match higher than a mid-word match", () => {
    // "config" starts right after "/", a boundary char.
    const boundary = fuzzyScore("c", "app/config");
    // "c" mid-word inside "scope" (preceded by a lowercase letter, no boundary).
    const midWord = fuzzyScore("c", "scope");
    expect(boundary).not.toBeNull();
    expect(midWord).not.toBeNull();
    expect(boundary as number).toBeGreaterThan(midWord as number);
  });

  it("rewards a match at the very start of the text (prefix bonus)", () => {
    const prefix = fuzzyScore("a", "abc");
    const later = fuzzyScore("a", "bac");
    expect(prefix as number).toBeGreaterThan(later as number);
  });
});

describe("fuzzyFilter", () => {
  it("returns rows unchanged, in original order, for an empty/whitespace query", () => {
    const rows = ["c", "a", "b"];
    expect(fuzzyFilter("", rows, (r) => r)).toEqual(["c", "a", "b"]);
    expect(fuzzyFilter("   ", rows, (r) => r)).toEqual(["c", "a", "b"]);
  });

  it("drops rows that don't match", () => {
    const rows = ["activity", "clipboard", "sessions"];
    expect(fuzzyFilter("zzz", rows, (r) => r)).toEqual([]);
  });

  it("ranks better matches first", () => {
    const rows = ["axbxcx", "abc", "abcxxx"];
    const result = fuzzyFilter("abc", rows, (r) => r);
    expect(result).toEqual(["abc", "abcxxx", "axbxcx"]);
  });

  it("filters using a derived key rather than the row itself", () => {
    const rows = [{ name: "activity" }, { name: "config" }, { name: "zzz" }];
    const result = fuzzyFilter("con", rows, (r) => r.name);
    expect(result).toEqual([{ name: "config" }]);
  });
});
