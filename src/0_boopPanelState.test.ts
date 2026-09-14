import { describe, expect, it } from "vitest";
import { boopRosterState, type BoopRosterInput } from "./0_boopPanelState";

const base: BoopRosterInput = {
  laneCount: 0,
  shownCount: 0,
  hiddenByActive: 0,
  status: "success",
  error: null,
};

describe("boopRosterState", () => {
  it("reports loading while the first graph read is in flight", () => {
    expect(boopRosterState({ ...base, status: "idle" })).toEqual({ kind: "loading" });
    expect(boopRosterState({ ...base, status: "loading" })).toEqual({ kind: "loading" });
  });

  it("never claims no agents while the graph is pending", () => {
    expect(boopRosterState({ ...base, status: "loading" }).kind).not.toBe("empty");
  });

  it("reports the store error instead of the empty message", () => {
    expect(boopRosterState({ ...base, error: "unknown command boop_session_graph" })).toEqual({
      kind: "error",
      message: "unknown command boop_session_graph",
    });
  });

  it("reports a successful zero-lane graph as empty", () => {
    expect(boopRosterState(base)).toEqual({ kind: "empty" });
  });

  it("explains an all-hidden roster instead of showing a blank table", () => {
    expect(
      boopRosterState({ laneCount: 3, shownCount: 0, hiddenByActive: 3, status: "success", error: null }),
    ).toEqual({ kind: "hidden-by-active", hidden: 3 });
  });

  it("shows rows when any lane survives the filter", () => {
    expect(
      boopRosterState({ laneCount: 3, shownCount: 1, hiddenByActive: 2, status: "success", error: null }),
    ).toEqual({ kind: "rows" });
  });

  it("prefers rows over a stale error once lanes exist", () => {
    expect(
      boopRosterState({ laneCount: 2, shownCount: 2, hiddenByActive: 0, status: "error", error: "boom" }),
    ).toEqual({ kind: "rows" });
  });
});
