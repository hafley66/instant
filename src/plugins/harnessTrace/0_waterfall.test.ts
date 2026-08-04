import { describe, expect, it } from "vitest";
import {
  binSpans,
  binsPath,
  decimateTicks,
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
  it("defaultRange is the whole domain at or below the session limit", () => {
    const d = domainOf(spans, 400);
    expect(defaultRange(spans, d)).toEqual({ start: d.start, end: d.end });
  });
  it("empty span set degrades to a zero-width domain at the clock", () => {
    const d = domainOf([], 500);
    expect(d).toEqual({ start: 500, end: 500 });
  });
});

describe("defaultRange over the session limit", () => {
  // Ten sessions one second apart; a limit of 3 must open on the newest three.
  const many: ISessionSpan[] = Array.from({ length: 10 }, (_, i) => ({
    id: "s" + i,
    harness: "claude" as const,
    start: 1000 + i * 1000,
    end: 1500 + i * 1000,
  }));

  it("opens on the newest `limit` sessions, not the whole history", () => {
    const d = domainOf(many, 11_000);
    const r = defaultRange(many, d, 3);
    expect(r.start).toBe(8000); // s7's start: s7, s8, s9 are the newest three
    expect(r.end).toBe(d.end);
    expect(spansInRange(many, r).map((s) => s.id)).toEqual(["s7", "s8", "s9"]);
  });

  it("bounds the opening row count by the limit however long history gets", () => {
    const huge: ISessionSpan[] = Array.from({ length: 300 }, (_, i) => ({
      id: "h" + i,
      harness: "claude" as const,
      start: i * 1000,
      end: i * 1000 + 100,
    }));
    const d = domainOf(huge, 300_000);
    expect(spansInRange(huge, defaultRange(huge, d, 40))).toHaveLength(40);
  });
});

describe("decimateTicks", () => {
  const r = { start: 0, end: 1000 };

  it("keeps well separated ticks intact", () => {
    const ticks: ISessionTick[] = [
      { sessionId: "a", ts: 0, type: "user", preview: "" },
      { sessionId: "a", ts: 500, type: "assistant", preview: "" },
      { sessionId: "a", ts: 1000, type: "tool", preview: "" },
    ];
    expect(decimateTicks(ticks, r, 300).map((t) => t.ts)).toEqual([0, 500, 1000]);
  });

  it("collapses ticks sharing a pixel column, keeping the higher ranked type", () => {
    const ticks: ISessionTick[] = [
      { sessionId: "a", ts: 500, type: "assistant", preview: "" },
      { sessionId: "a", ts: 501, type: "user", preview: "" },
    ];
    const out = decimateTicks(ticks, r, 300);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("user");
  });

  it("caps a lane at plotW/minPx + 1 whatever the message count", () => {
    const ticks: ISessionTick[] = Array.from({ length: 5000 }, (_, i) => ({
      sessionId: "a",
      ts: (i / 5000) * 1000,
      type: "assistant" as const,
      preview: "",
    }));
    const out = decimateTicks(ticks, r, 300, 3);
    expect(out.length).toBeLessThanOrEqual(300 / 3 + 1);
  });

  it("returns time-ordered ticks", () => {
    const ticks: ISessionTick[] = [
      { sessionId: "a", ts: 900, type: "user", preview: "" },
      { sessionId: "a", ts: 100, type: "user", preview: "" },
    ];
    expect(decimateTicks(ticks, r, 300).map((t) => t.ts)).toEqual([100, 900]);
  });

  it("degenerate zero-width range keeps one tick", () => {
    const ticks: ISessionTick[] = [
      { sessionId: "a", ts: 5, type: "assistant", preview: "" },
      { sessionId: "a", ts: 5, type: "user", preview: "" },
    ];
    const out = decimateTicks(ticks, { start: 5, end: 5 }, 300);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("user");
  });
});

describe("binSpans", () => {
  it("emits a fixed column count independent of the span count", () => {
    const few: ISessionSpan[] = [{ id: "a", harness: "claude", start: 10, end: 20 }];
    const many: ISessionSpan[] = Array.from({ length: 4000 }, (_, i) => ({
      id: "s" + i,
      harness: "claude" as const,
      start: i % 100,
      end: (i % 100) + 5,
    }));
    const domain = { start: 0, end: 100 };
    expect(binSpans(few, domain, 60)).toHaveLength(60);
    expect(binSpans(many, domain, 60)).toHaveLength(60);
  });

  it("counts overlap per column", () => {
    const spans: ISessionSpan[] = [
      { id: "a", harness: "claude", start: 0, end: 50 },
      { id: "b", harness: "claude", start: 25, end: 100 },
    ];
    const bins = binSpans(spans, { start: 0, end: 100 }, 4);
    expect(bins.map((b) => b.count)).toEqual([1, 2, 2, 1]);
  });

  it("a zero-width domain has no columns to lay out", () => {
    expect(binSpans([], { start: 5, end: 5 }, 60)).toEqual([]);
  });
});

describe("binsPath", () => {
  it("draws a closed step area from the floor", () => {
    const bins = [
      { start: 0, end: 50, count: 1 },
      { start: 50, end: 100, count: 2 },
    ];
    const d = binsPath(bins, 100, 20);
    expect(d.startsWith("M0,20")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    // Peak column reaches the top, half-height column sits mid-way.
    expect(d).toContain("L0.00,10.00");
    expect(d).toContain("L50.00,0.00");
  });

  it("is one path however many columns there are", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ start: i, end: i + 1, count: 1 }));
    const d = binsPath(many, 600, 20);
    expect(d.match(/M/g)).toHaveLength(1);
    expect(d.match(/Z/g)).toHaveLength(1);
  });

  it("degenerate inputs draw nothing", () => {
    expect(binsPath([], 100, 20)).toBe("");
    expect(binsPath([{ start: 0, end: 1, count: 0 }], 100, 20)).toBe("");
    expect(binsPath([{ start: 0, end: 1, count: 3 }], 0, 20)).toBe("");
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
