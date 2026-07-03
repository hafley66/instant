import { describe, it, expect } from "vitest";
import { hasWidthSignal, anyWidthSignal } from "./treetableSize";

describe("hasWidthSignal", () => {
  it("false when neither dragged nor authored", () => {
    expect(hasWidthSignal("name", {}, undefined)).toBe(false);
  });

  it("true when the column has a columnSizing entry (user dragged)", () => {
    expect(hasWidthSignal("name", { name: 200 }, undefined)).toBe(true);
  });

  it("true when the consumer authored an explicit size", () => {
    expect(hasWidthSignal("name", {}, 120)).toBe(true);
  });

  it("a sizing entry for a different column is not a signal", () => {
    expect(hasWidthSignal("name", { other: 200 }, undefined)).toBe(false);
  });

  it("a dragged width of 0 still counts as a signal", () => {
    expect(hasWidthSignal("name", { name: 0 }, undefined)).toBe(true);
  });
});

describe("anyWidthSignal", () => {
  const ids = ["a", "b", "c"];

  it("false when no column has a signal", () => {
    expect(anyWidthSignal(ids, {}, {})).toBe(false);
  });

  it("true when one column was dragged", () => {
    expect(anyWidthSignal(ids, { b: 150 }, {})).toBe(true);
  });

  it("true when one column has an authored size", () => {
    expect(anyWidthSignal(ids, {}, { c: 90 })).toBe(true);
  });

  it("false for an empty column list", () => {
    expect(anyWidthSignal([], { a: 100 }, { a: 100 })).toBe(false);
  });
});
