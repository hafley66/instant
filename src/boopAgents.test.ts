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
  shellQuote,
  subRowsFor,
  type LaneDetail,
} from "./boopAgents";

const LANE_SAMPLE =
  "live  boop-shell-v2    opencode   auto   openrouter/deepseek/deepseek-v4-flash-0731     boop-shell-v2    /Users/chrishafley/projects/instant/.boop-worktrees/lane/boop-shell-v2\n" +
  "dead  gword            opencode   auto   openrouter/deepseek/deepseek-v4-flash-0731     gword            /Users/chrishafley/projects/sprefa-lanes/gword\n" +
  "dead  instant-bus-visible-20260807 opencode - openrouter/deepseek/deepseek-v4-flash-0731 instant-bus-visible-20260807 /tmp/x";

const PS_SAMPLE =
  "lane\tpid\trss_kb\tcpu_pct\tuptime_sec\tchildren\n" +
  "boop-shell-v2\t83311\t2736\t0.0\t1786329951\t4\n" +
  "gword\t0\t-\t-\t-\t-";

const SESSION_SAMPLE =
  '{"session":"s1","nickname":"s1","harness":"codex","cwd":"/r","branch":null,"started_ts":1,"turns":5,"last_ts":2}\n' +
  '{"session":"s2","nickname":"s2","harness":"claude","cwd":"/r2","branch":null,"started_ts":1,"turns":2,"last_ts":2}\n';

const USAGE_SAMPLE =
  '{"bucket":null,"calls":100,"input_tokens":1,"cost_usd":null,"unpriced_calls":100}\n' +
  '{"unpriced_model":"gpt","calls":60}\n';

describe("boop parsing (inline)", () => {
  it("parses lane-list rows incl. a dashed mode + variable padding", () => {
    const rows = parseLaneList(LANE_SAMPLE);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      state: "live",
      lane: "boop-shell-v2",
      harness: "opencode",
      mode: "auto",
      model: "openrouter/deepseek/deepseek-v4-flash-0731",
      tmux: "boop-shell-v2",
    });
    expect(rows[0].cwd).toContain("boop-shell-v2");
    expect(rows[2].mode).toBe("-");
  });

  it("parses ps TSV, number or zero per lane", () => {
    const ps = parsePs(PS_SAMPLE);
    expect(ps["boop-shell-v2"].pid).toBe(83311);
    expect(ps["boop-shell-v2"].rssKb).toBe(2736);
    // dead lanes carry pid 0 and `-` for the resource columns
    expect(ps["gword"].pid).toBe(0);
    expect(ps["gword"].cpuPct).toBeNull();
  });

  it("parses session ndjson into typed rows", () => {
    const ses = parseSessions(SESSION_SAMPLE);
    expect(ses).toHaveLength(2);
    expect(ses[0].harness).toBe("codex");
    expect(ses[0].turns).toBe(5);
  });

  it("parses lane get JSON and route text", () => {
    const live = parseLaneGet(
      '{"lane":"boop-shell-v2","state":"live","harness":"opencode","session_id":"ses_abc"}',
    );
    expect(live.state).toBe("live");
    expect(live.sessionId).toBe("ses_abc");
    expect(parseLaneRoute("resolved boop-shell-v2 -> ses_abc")).toBe("ses_abc");
  });

  it("parses the usage totals row", () => {
    const u = parseUsage(USAGE_SAMPLE);
    expect(u.calls).toBe(100);
    expect(u.costUsd).toBeNull();
  });

  it("merges lanes + ps, and builds route children on expand", () => {
    const lanes = parseLaneList(LANE_SAMPLE);
    const ps = parsePs(PS_SAMPLE);
    const rows = mergeLanes(lanes, ps, []);
    expect(rows[0].pid).toBe(83311);
    expect(rows[1].state).toBe("dead");
    expect(rows[1].pid).toBe(0);
    expect(subRowsFor(rows[0])).toBeUndefined();
    const withRoute: LaneDetail = {
      lane: "x", state: "live", harness: "opencode", tmux: "x", cwd: "/x",
      model: "m", mode: "auto", sessionId: "ses_abc", routeText: "ses_abc",
    };
    const kids = subRowsFor({ ...rows[0], route: withRoute });
    expect(kids?.[0]).toMatchObject({ kind: "route", sessionId: "ses_abc" });
  });

  it("quotes shell args", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("BoopClient poll (fake runner)", () => {
  function fakeRunner(by: Record<string, string>) {
    return async (line: string): Promise<string> => {
      for (const [k, v] of Object.entries(by)) {
        if (line.includes(k)) return v;
      }
      return "";
    };
  }

  it("assembles a snap on the full-cadence tick", async () => {
    const client = new BoopClient(
      fakeRunner({
        "beep lane list": LANE_SAMPLE,
        "beep ps": PS_SAMPLE,
        "db session list": SESSION_SAMPLE,
        "db usage": USAGE_SAMPLE,
      }),
      "boop",
    );
    const snap = await client.poll(0);
    expect(snap.lanes).toHaveLength(3);
    expect(snap.sessions).toHaveLength(2);
    expect(snap.calls).toBe(100);
  });

  it("skips slow db reads off the 5-tick cadence", async () => {
    const client = new BoopClient(
      fakeRunner({ "beep lane list": LANE_SAMPLE, "beep ps": PS_SAMPLE }),
      "boop",
    );
    const snap = await client.poll(1);
    expect(snap.lanes).toHaveLength(3);
    expect(snap.sessions).toHaveLength(0);
    expect(snap.calls).toBe(0);
  });
});
