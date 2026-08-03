import { describe, expect, it } from "vitest";
import { StripPolicy } from "./0_strip";

// Fail-first receipt (both cases red at 57560ff): the base toggle read an
// absent entry as open and wrote open:false on the first press, and the base
// visibility hid the shell whenever the row set was empty, so a summon on a
// fresh terminal showed nothing.
describe("StripPolicy.toggle", () => {
  it("summons on the first press of a terminal that has no entry", () => {
    expect(StripPolicy.toggle(null)).toEqual({ open: true });
  });

  it("flips an entry that exists", () => {
    expect(StripPolicy.toggle({ open: true })).toEqual({ open: false });
    expect(StripPolicy.toggle({ open: false })).toEqual({ open: true });
  });

  it("round-trips: press, press, press ends open", () => {
    const once = StripPolicy.toggle(null);
    const twice = StripPolicy.toggle(once);
    expect(StripPolicy.toggle(twice)).toEqual({ open: true });
  });
});

describe("StripPolicy.visible", () => {
  it("renders the shell on an explicit summon with zero rows", () => {
    expect(StripPolicy.visible({ open: true }, 0, false)).toBe(true);
  });

  it("keeps a dismissed strip hidden even with rows and a pushed view", () => {
    expect(StripPolicy.visible({ open: false }, 5, true)).toBe(false);
  });

  it("auto-appears for an absent entry only when there is something to show", () => {
    expect(StripPolicy.visible(null, 0, false)).toBe(false);
    expect(StripPolicy.visible(null, 2, false)).toBe(true);
    expect(StripPolicy.visible(null, 0, true)).toBe(true);
  });
});
