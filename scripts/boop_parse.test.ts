import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BoopClient,
  mergeLanes,
  parseLaneGet,
  parseLaneList,
  parseLaneRoute,
  parsePs,
  parseSessions,
  parseUsage,
} from "../src/boopAgents";

// Unit tests against real `boop` output captured from a live run and committed
// under fixtures/boop/. Exercises the exact shapes the Agents panel parses.
const FIX = join(import.meta.dirname, "..", "fixtures", "boop");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");

describe("boop parsing against committed fixtures", () => {
  it("parses the full 103-lane `beep lane list` table", () => {
    const rows = parseLaneList(fixture("lane-list.txt"));
    expect(rows).toHaveLength(103);
    const shell = rows.find((r) => r.lane === "boop-shell-v2");
    expect(shell?.state).toBe("live");
    expect(shell?.harness).toBe("opencode");
    expect(shell?.model).toBe("openrouter/deepseek/deepseek-v4-flash-0731");
    // every row gets cwd, the trailing unpadded token run
    for (const r of rows) expect(r.cwd.length).toBeGreaterThan(0);
  });

  it("parses the `beep ps` TSV for every lane", () => {
    const ps = parsePs(fixture("ps.tsv"));
    expect(Object.keys(ps)).toHaveLength(103);
    expect(ps["boop-shell-v2"].pid).toBeGreaterThan(0);
    expect(ps["gword"].pid).toBe(0);
    expect(ps["gword"].rssKb).toBeNull();
  });

  it("parses recent sessions ndjson", () => {
    const ses = parseSessions(fixture("sessions.ndjson"));
    expect(ses).toHaveLength(5);
    expect(ses[0].harness).toBe("codex");
  });

  it("parses lane get for live and dead lanes", () => {
    const live = parseLaneGet(fixture("lane-get-live.json"));
    expect(live.state).toBe("live");
    expect(live.sessionId).toBeTruthy();
    const dead = parseLaneGet(fixture("lane-get-dead.json"));
    expect(dead.state).toBe("dead");
    expect(dead.sessionId).toBeNull();
  });

  it("extracts the session id from `beep lane route`", () => {
    expect(parseLaneRoute(fixture("lane-route.txt"))).toMatch(/^ses_/);
  });

  it("reads the totals row out of `db usage` ndjson", () => {
    const u = parseUsage(fixture("usage.ndjson"));
    expect(u.calls).toBeGreaterThan(0);
    expect(u.costUsd).toBeNull();
  });

  it("merges lane list + ps + sessions into panel rows", () => {
    const rows = mergeLanes(
      parseLaneList(fixture("lane-list.txt")),
      parsePs(fixture("ps.tsv")),
      parseSessions(fixture("sessions.ndjson")),
    );
    expect(rows).toHaveLength(103);
    const shell = rows.find((r) => r.lane === "boop-shell-v2");
    expect(shell?.pid).toBeGreaterThan(0);
    expect(shell?.route).toBeNull();
  });
});

describe("BoopClient poll against committed fixtures", () => {
  function fakeRunner(by: Record<string, string>) {
    return async (line: string): Promise<string> => {
      for (const [k, v] of Object.entries(by)) {
        if (line.includes(k)) return v;
      }
      return "";
    };
  }

  it("assembles a snap the panel renders from", async () => {
    const client = new BoopClient(
      fakeRunner({
        "beep lane list": fixture("lane-list.txt"),
        "beep ps": fixture("ps.tsv"),
        "db session list": fixture("sessions.ndjson"),
        "db usage": fixture("usage.ndjson"),
      }),
      "boop",
    );
    const snap = await client.poll(0);
    expect(snap.lanes).toHaveLength(103);
    expect(snap.sessions).toHaveLength(5);
    expect(snap.calls).toBeGreaterThan(0);
  });
});
