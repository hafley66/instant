// Pure computation only (repo test law): the grid model over search hits.
import { describe, expect, it } from "vitest";
import { chatLabel, searchRows, whenLabel, type BoopSearchHit } from "./1_boopSearchRows";

const hit = (over: Partial<BoopSearchHit>): BoopSearchHit => ({
  session: "sess-a",
  harness: "claude",
  cwd: "/work/repo",
  nickname: null,
  turn: 0,
  ts: 10,
  role: "user",
  snippet: "…breaker…",
  said: "breaker",
  sessionLastTs: 30,
  sessionTurns: 3,
  ...over,
});

describe("searchRows", () => {
  const hits = [
    hit({ session: "sess-b", turn: 4, ts: 50, sessionLastTs: 55, cwd: null, nickname: null }),
    hit({ turn: 1, ts: 20, role: "assistant" }),
    hit({ turn: 0, ts: 10 }),
    hit({ session: "sess-c", turn: 2, ts: 5, sessionLastTs: 99, nickname: "gamma" }),
  ];

  it("flat mode keeps one row per hit in the order given", () => {
    const rows = searchRows(hits, false);
    expect(rows.map((r) => r.id)).toEqual(["hit:sess-b:4", "hit:sess-a:1", "hit:sess-a:0", "hit:sess-c:2"]);
    expect(rows.every((r) => r.kind === "hit" && r.count === 1 && !r.children)).toBe(true);
  });

  it("tree mode groups by chat, newest activity first, hits newest first", () => {
    const rows = searchRows(hits, true);
    expect(rows.map((r) => [r.id, r.count, r.lastTs])).toEqual([
      ["chat:sess-c", 1, 99],
      ["chat:sess-b", 1, 55],
      ["chat:sess-a", 2, 30],
    ]);
    const a = rows[2];
    expect(a.kind).toBe("chat");
    expect(a.ts).toBe(20);
    expect(a.snippet).toBe("");
    expect(a.children!.map((r) => r.turn)).toEqual([1, 0]);
    expect(a.children![0].hit?.role).toBe("assistant");
  });

  it("labels a chat by nickname, then cwd basename, then session prefix", () => {
    expect(chatLabel({ nickname: "gamma", cwd: "/x/y", session: "abcdefghij" })).toBe("gamma");
    expect(chatLabel({ nickname: null, cwd: "/x/y/", session: "abcdefghij" })).toBe("y");
    expect(chatLabel({ nickname: null, cwd: null, session: "abcdefghij" })).toBe("abcdefgh");
  });
});

describe("whenLabel", () => {
  const now = Date.UTC(2026, 8, 14, 12, 0, 0);
  it("renders relative ages then a date past two weeks", () => {
    expect(whenLabel(0, now)).toBe("");
    expect(whenLabel(now - 30_000, now)).toBe("now");
    expect(whenLabel(now - 5 * 60_000, now)).toBe("5m ago");
    expect(whenLabel(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(whenLabel(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(whenLabel(now - 40 * 86_400_000, now)).toBe("2026-08-05");
  });
});
