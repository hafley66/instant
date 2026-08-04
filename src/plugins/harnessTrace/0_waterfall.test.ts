import { describe, expect, it } from "vitest";
import {
  defaultRange,
  domainOf,
  sessionSpans,
  spansInRange,
  tickFrom,
  tickType,
  ticksInRange,
  toSpan,
  visibleSessionIds,
} from "./0_waterfall";
import type { AgentSessionNode, ISessionSpan, ISessionTick } from "./0_types";
import type { AiMessage } from "../../state";

function node(partial: Partial<AgentSessionNode> & { id: string }): AgentSessionNode {
  return {
    harness: "claude",
    parentId: null,
    parentKind: null,
    from: "user",
    why: "",
    ts: "2026-08-02T10:00:00.000Z",
    lastActivity: "2026-08-02T11:00:00.000Z",
    status: "done",
    cwd: "~/projects/x",
    tmuxSession: null,
    ...partial,
  };
}

function msg(partial: Partial<AiMessage> & { id: string }): AiMessage {
  return {
    editor: "claude",
    session_id: "s1",
    seq: 1,
    role: "assistant",
    subtype: undefined,
    ts: 1000,
    preview: "",
    text: "",
    locator: "",
    ...partial,
  };
}

const T0 = Date.parse("2026-08-02T10:00:00Z");
const NOW = Date.parse("2026-08-02T12:00:00Z");

describe("toSpan", () => {
  it("maps ts and lastActivity with a now fallback", () => {
    const s = toSpan(node({ id: "a", ts: "2026-08-02T10:00:00.000Z", lastActivity: "2026-08-02T10:30:00.000Z" }), NOW);
    expect(s.start).toBe(T0);
    expect(s.end).toBe(T0 + 30 * 60 * 1000);
  });

  it("clamps end to at least start", () => {
    const s = toSpan(node({ id: "a", ts: "2026-08-02T10:00:00.000Z", lastActivity: "2026-08-02T09:00:00.000Z" }), NOW);
    expect(s.end).toBe(s.start);
  });

  it("breathes live bars to now", () => {
    const s = toSpan(node({ id: "a", status: "live", lastActivity: "2026-08-02T10:30:00.000Z" }), NOW);
    expect(s.end).toBe(NOW);
  });
});

describe("tickType", () => {
  it("user prompts read off role", () => {
    expect(tickType(msg({ id: "m", role: "user" }))).toBe("user");
  });
  it("tool subtypes are tool", () => {
    expect(tickType(msg({ id: "m", role: "assistant", subtype: "tool_use" }))).toBe("tool");
  });
  it("reasoning subtype is reasoning", () => {
    expect(tickType(msg({ id: "m", subtype: "reasoning" }))).toBe("reasoning");
  });
  it("a bare assistant with no subtype stays assistant", () => {
    expect(tickType(msg({ id: "m", role: "assistant" }))).toBe("assistant");
  });
  it("codex tool-result names ride subtype as tool", () => {
    expect(tickType(msg({ id: "m", role: "assistant", subtype: "Shell(1)" }))).toBe("tool");
  });
});

describe("tickFrom", () => {
  it("projects the rust AiMessage shape", () => {
    const t = tickFrom(msg({ id: "m9", session_id: "sx", ts: 55, role: "user", preview: "hi" }));
    expect(t).toEqual({ sessionId: "sx", ts: 55, type: "user", preview: "hi" });
  });
});

describe("sessionSpans / domainOf / defaultRange", () => {
  const spans: ISessionSpan[] = [
    { id: "a", harness: "claude", start: 100, end: 200 },
    { id: "b", harness: "opencode", start: 150, end: 250 },
  ];
  it("builds one span per node", () => {
    expect(sessionSpans([node({ id: "a" }), node({ id: "b" })], NOW)).toHaveLength(2);
  });
  it("pads the domain 2% and clamps end to now", () => {
    const d = domainOf(spans, 400);
    expect(d.start).toBe(100 - Math.max(1, 150 * 0.02));
    expect(d.end).toBe(400 + Math.max(1, 150 * 0.02));
  });
  it("defaultRange is the whole domain", () => {
    const d = domainOf(spans, 400);
    expect(defaultRange(d)).toEqual({ start: d.start, end: d.end });
  });
  it("empty span set degrades to a zero-width domain at the clock", () => {
    const d = domainOf([], 500);
    expect(d).toEqual({ start: 500, end: 500 });
  });
});

describe("range filters", () => {
  const spans: ISessionSpan[] = [
    { id: "a", harness: "claude", start: 100, end: 200 },
    { id: "b", harness: "opencode", start: 300, end: 400 },
  ];
  const ticks: ISessionTick[] = [
    { sessionId: "a", ts: 120, type: "user", preview: "x" },
    { sessionId: "a", ts: 220, type: "assistant", preview: "y" },
    { sessionId: "a", ts: 320, type: "tool", preview: "z" },
  ];
  it("keeps only spans intersecting the range", () => {
    expect(spansInRange(spans, { start: 0, end: 210 }).map((s) => s.id)).toEqual(["a"]);
    expect(spansInRange(spans, { start: 250, end: 350 }).map((s) => s.id)).toEqual(["b"]);
  });
  it("keeps only ticks on or inside the range", () => {
    expect(ticksInRange(ticks, { start: 200, end: 400 }).map((t) => t.ts)).toEqual([220, 320]);
  });
  it("visibleSessionIds is the in-range span id set", () => {
    expect([...visibleSessionIds(spans, { start: 0, end: 210 })]).toEqual(["a"]);
  });
});
