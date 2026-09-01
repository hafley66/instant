import { describe, expect, it } from "vitest";
import { createMarbler } from "@hafley66/marbler";
import { laneFrames, toMarbleEvents, type BoopLane, type BoopLaneEvent } from "./boopPanel";

const LANE_A: BoopLane = {
  route: "feat-alpha",
  kind: "lane",
  harness: "opencode",
  model: "openrouter/deepseek/deepseek-v4-flash-0731",
  goal: "ship the alpha",
  parent: "claude-275",
  cwd: "/repo/a",
  branch: "alpha",
  registeredMs: 1000,
  state: "open",
};

const LANE_B: BoopLane = {
  route: "fix-beta",
  kind: "lane",
  harness: "codex",
  model: "gpt-5.6-luna",
  goal: "fix the beta",
  parent: "feat-alpha",
  cwd: "/repo/b",
  branch: "beta",
  registeredMs: 2000,
  state: "closed",
};

const MAIL_A_TO_B: BoopLaneEvent = {
  ts: 3000,
  kind: "yield",
  fromRoute: "feat-alpha",
  toRoute: "fix-beta",
  preview: "hail",
};

const RESULT_B_TO_A: BoopLaneEvent = {
  ts: 4000,
  kind: "result",
  fromRoute: "fix-beta",
  toRoute: "feat-alpha",
  preview: "done rc=0",
};

const DIED: BoopLaneEvent = {
  ts: 5000,
  kind: "exited_without_completion",
  fromRoute: "fix-beta",
  toRoute: "fix-beta",
  preview: "signal",
};

const EVENTS = [MAIL_A_TO_B, RESULT_B_TO_A, DIED];

describe("toMarbleEvents", () => {
  it("maps one lane to one line with open/closed status", () => {
    const rows = toMarbleEvents([LANE_A, LANE_B], []);
    expect(rows.map((row) => row.id)).toEqual(["feat-alpha", "fix-beta"]);
    expect(rows[0].status).toBe(200);
    expect(rows[1].status).toBe(0);
    expect(rows[0].start).toBe(1000);
    expect(rows[1].duration).toBeNull();
  });

  it("feeds marbler's model without a schema rewrite", () => {
    const model = createMarbler(toMarbleEvents([LANE_A, LANE_B], EVENTS));
    expect(model.source.$()).toHaveLength(2);
    expect(model.rows.$()).toHaveLength(2);
  });
});

describe("laneFrames", () => {
  it("lands one mail as a dot on each lane it touches, with the peer set for links", () => {
    const a = laneFrames(LANE_A, [MAIL_A_TO_B]);
    const b = laneFrames(LANE_B, [MAIL_A_TO_B]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].direction).toBe("out");
    expect(a[0].peer).toBe("fix-beta");
    expect(b[0].direction).toBe("in");
    expect(b[0].peer).toBe("feat-alpha");
  });

  it("maps mail kinds onto frame kinds: result, error, and default mail-in/out", () => {
    const a = laneFrames(LANE_A, EVENTS);
    const b = laneFrames(LANE_B, EVENTS);
    const aKinds = a.map((frame) => frame.kind);
    const bKinds = b.map((frame) => frame.kind);
    expect(aKinds).toContain("mail-out");
    expect(aKinds).toContain("result");
    expect(bKinds).toContain("mail-in");
    expect(bKinds).toContain("result");
    expect(bKinds).toContain("error");
  });

  it("marks self-addressed mail as a self dot with no peer", () => {
    const b = laneFrames(LANE_B, [DIED]);
    expect(b[0].direction).toBe("self");
    expect(b[0].peer).toBeNull();
  });

  it("ignores mail that touches other routes", () => {
    expect(laneFrames(LANE_A, [DIED])).toHaveLength(0);
  });
});
