import { describe, expect, it } from "vitest";
import { familyIdsOf, scopeEventsToFamily } from "./1_boopFamilyNetwork";
import type { BoopNetworkEvent } from "../../1_boopNetwork";
import type { AgentSessionNode } from "./0_types";

function event(partial: Partial<BoopNetworkEvent> & Pick<BoopNetworkEvent, "event_key" | "lane">): BoopNetworkEvent {
  return {
    event_id: 1,
    event_key: partial.event_key,
    lane: partial.lane,
    trace: partial.trace ?? "trace-a",
    session: partial.session ?? "",
    from_lane: partial.from_lane ?? "",
    to_lane: partial.to_lane ?? "",
    kind: partial.kind ?? "turn-start",
    started_ts: partial.started_ts ?? 100,
    finished_ts: partial.finished_ts ?? null,
    delivery_state: partial.delivery_state ?? "",
    classification: partial.classification ?? "started",
    detail: partial.detail ?? "",
    created_ts: partial.created_ts ?? 100,
  };
}

const familyNodes: AgentSessionNode[] = [
  {
    id: "parent-s1",
    harness: "claude",
    parentId: null,
    parentKind: null,
    from: "user",
    why: "",
    ts: "2026-08-03T10:00:00Z",
    lastActivity: "2026-08-03T11:00:00Z",
    status: "live",
    cwd: "~/projects/demo",
    tmuxSession: "s1",
  },
  {
    id: "oc-lane",
    harness: "opencode",
    parentId: "parent-s1",
    parentKind: "dispatch",
    from: "user",
    why: "",
    ts: "2026-08-03T10:20:00Z",
    lastActivity: "2026-08-03T10:55:00Z",
    status: "live",
    cwd: "~/projects/demo",
    tmuxSession: "s1",
  },
];

describe("familyIdsOf", () => {
  it("collects every family session and lane id", () => {
    const ids = familyIdsOf(familyNodes);
    expect([...ids].sort()).toEqual(["oc-lane", "parent-s1"]);
  });

  it("returns an empty set for no family nodes", () => {
    expect(familyIdsOf([]).size).toBe(0);
  });
});

describe("scopeEventsToFamily", () => {
  const ids = familyIdsOf(familyNodes);

  it("keeps an event whose session matches a family session id", () => {
    const e = event({ event_key: "a", lane: "worker", session: "parent-s1" });
    expect(scopeEventsToFamily([e], ids)).toEqual([e]);
  });

  it("keeps an event whose lane matches a family lane id", () => {
    const e = event({ event_key: "b", lane: "oc-lane", session: "worker-session" });
    expect(scopeEventsToFamily([e], ids)).toHaveLength(1);
  });

  it("keeps an event whose from/to evidence matches a family id", () => {
    const out = event({ event_key: "c", lane: "external", from_lane: "parent-s1", to_lane: "external" });
    const inbound = event({ event_key: "d", lane: "external", from_lane: "root", to_lane: "oc-lane" });
    expect(scopeEventsToFamily([out, inbound], ids)).toHaveLength(2);
  });

  it("drops events that reference only an unrelated family", () => {
    const unrelated = event({ event_key: "e", lane: "parent-other", session: "other-session" });
    expect(scopeEventsToFamily([unrelated], ids)).toEqual([]);
  });

  it("returns an empty array when the family set is empty", () => {
    const e = event({ event_key: "f", lane: "parent-s1" });
    expect(scopeEventsToFamily([e], new Set())).toEqual([]);
  });
});
