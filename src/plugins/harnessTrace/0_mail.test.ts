import { describe, expect, it } from "vitest";
import {
  enrichRows,
  mailAgentIdFor,
  parseMailLog,
  parseMailNdjson,
  parseMailRegistry,
  registrySeeds,
  resolveRouteSessions,
  routeTmuxBySession,
  settleRoutedStatus,
  tmuxLiveNames,
} from "./0_mail";
import type { HarnessTraceSeed, IMailAgent } from "./0_types";

const dispatchLine = JSON.stringify({
  id: "env-1",
  from: "coordinator",
  to: "lane-a",
  ts: "2026-08-02T01:00:00Z",
  kind: "dispatch",
  body: "build the trace panel\nfull brief below",
});
const replyLine = JSON.stringify({
  id: "env-2",
  from: "lane-a",
  to: "sess-direct",
  ts: "2026-08-02T02:00:00Z",
  kind: "dispatch",
  body: "second envelope",
});

describe("parseMailNdjson", () => {
  // S2 sabotage receipt: one malformed line among valid ones is skipped, the
  // valid envelopes on either side of it survive.
  it("skips a malformed line and keeps the rest", () => {
    const text = [dispatchLine, "{this is not json", replyLine, ""].join("\n");
    const envelopes = parseMailNdjson(text);
    expect(envelopes.map((envelope) => envelope.id)).toEqual(["env-1", "env-2"]);
  });

  it("skips records missing id or to", () => {
    const noId = JSON.stringify({ from: "x", to: "y" });
    const noTo = JSON.stringify({ id: "env-3", from: "x" });
    expect(parseMailNdjson([noId, noTo, dispatchLine].join("\n"))).toHaveLength(1);
  });

  it("returns empty for empty input", () => {
    expect(parseMailNdjson("")).toEqual([]);
  });
});

describe("ruled-envelope migration", () => {
  const ruled = JSON.stringify({
    id: "m-1",
    from: "coordinator",
    to: "lane-a",
    from_timestamp: "2026-08-03T01:00:00Z",
    to_timestamp: "2026-08-03T01:05:00Z",
    kind: "request",
    reply_to: null,
    body: "read CONTRACT.md",
    ref: null,
  });

  it("parseMailLog reads the ruled envelope, ack state included", () => {
    const [message] = parseMailLog(ruled);
    expect(message.from_timestamp).toBe("2026-08-03T01:00:00Z");
    expect(message.to_timestamp).toBe("2026-08-03T01:05:00Z");
  });

  // The trace panel's join predates the ruling: it still reads `ts`, which the
  // projection fills from from_timestamp.
  it("parseMailNdjson projects ts from from_timestamp for the panel join", () => {
    expect(parseMailNdjson(ruled)[0].ts).toBe("2026-08-03T01:00:00Z");
    expect(parseMailNdjson(dispatchLine)[0].ts).toBe("2026-08-02T01:00:00Z");
  });

  it("enrichRows joins a ruled envelope with no `ts` field at all", () => {
    const [row] = enrichRows([seed("sess-9")], parseMailNdjson(ruled), { "lane-a": "sess-9" });
    expect(row.id).toBe("m-1");
    expect(row.why).toBe("read CONTRACT.md");
  });
});

describe("mailAgentIdFor", () => {
  it("resolves a session id back to the mailbox agent name, else itself", () => {
    const registry = { "lane-a": "sess-9", "lane-b": "sess-7" };
    expect(mailAgentIdFor(registry, "sess-7")).toBe("lane-b");
    expect(mailAgentIdFor(registry, "sess-none")).toBe("sess-none");
    expect(mailAgentIdFor({}, "sess-9")).toBe("sess-9");
  });
});

describe("parseMailRegistry", () => {
  it("keeps only string values and survives malformed json", () => {
    expect(parseMailRegistry('{"lane-a":"sess-9","bad":7}')).toEqual({ "lane-a": "sess-9" });
    expect(parseMailRegistry("not json")).toEqual({});
    expect(parseMailRegistry("[1,2]")).toEqual({});
  });
});

function seed(sessionId: string): HarnessTraceSeed {
  return {
    id: sessionId,
    harness: "claude",
    sessionId,
    parentId: null,
    parentKind: null,
    ts: "2026-08-02T00:00:00.000Z",
    lastActivity: "2026-08-02T03:00:00.000Z",
    status: "done",
    cwd: "~/projects/x",
  };
}

describe("enrichRows", () => {
  it("defaults from/why when no envelope matches", () => {
    const [row] = enrichRows([seed("sess-none")], parseMailNdjson(dispatchLine), {});
    expect(row.from).toBe("user");
    expect(row.why).toBe("");
    expect(row.id).toBe("sess-none");
  });

  it("joins via the registry and takes the body first line", () => {
    const [row] = enrichRows([seed("sess-9")], parseMailNdjson(dispatchLine), {
      "lane-a": "sess-9",
    });
    expect(row.id).toBe("env-1");
    expect(row.from).toBe("coordinator");
    expect(row.why).toBe("build the trace panel");
  });

  it("joins directly when `to` is the session id", () => {
    const [row] = enrichRows([seed("sess-direct")], parseMailNdjson(replyLine), {});
    expect(row.id).toBe("env-2");
    expect(row.from).toBe("lane-a");
    expect(row.why).toBe("second envelope");
  });

  it("the oldest envelope per session wins", () => {
    const later = JSON.stringify({
      id: "env-9",
      from: "someone-else",
      to: "sess-direct",
      ts: "2026-08-02T05:00:00Z",
      kind: "dispatch",
      body: "late envelope",
    });
    const [row] = enrichRows([seed("sess-direct")], parseMailNdjson([later, replyLine].join("\n")), {});
    expect(row.id).toBe("env-2");
  });
});

function route(partial: Partial<IMailAgent> & { id: string }): IMailAgent {
  return {
    sessionId: "",
    harness: null,
    tmux: null,
    cwd: null,
    sourcePath: null,
    ...partial,
  };
}

describe("registrySeeds", () => {
  const NOW = Date.parse("2026-08-03T12:00:00Z");

  // Sabotage receipt: before this seam, a `bus dispatch`ed shell lane existed
  // only in registry.json, so it never became a row on any scope.
  it("synthesizes a seed for a route no harness store reported", () => {
    const [row] = registrySeeds(
      { probe: route({ id: "probe", tmux: "probe", cwd: "/tmp/probe" }) },
      [],
      new Set(["probe"]),
      [],
      NOW,
    );
    expect(row).toMatchObject({ id: "probe", sessionId: "probe", harness: "shell", status: "idle", cwd: "/tmp/probe" });
  });

  // REVIEW-reactive finding 9: a registry lane was "live" purely because its
  // tmux existed, with a blank activity column beside a green dot for hours.
  it("grades a live-tmux route by mail activity: fresh = live, stale = idle", () => {
    const routes = { lane: route({ id: "lane", tmux: "lane" }) };
    const fresh = parseMailNdjson(
      JSON.stringify({ id: "m-f", from: "coord", to: "lane", ts: "2026-08-03T11:59:00Z", kind: "request" }),
    );
    expect(registrySeeds(routes, [], new Set(["lane"]), fresh, NOW)[0]).toMatchObject({
      status: "live",
      lastActivity: "2026-08-03T11:59:00.000Z",
    });
    const stale = parseMailNdjson(
      JSON.stringify({ id: "m-s", from: "coord", to: "lane", ts: "2026-08-03T09:00:00Z", kind: "request" }),
    );
    expect(registrySeeds(routes, [], new Set(["lane"]), stale, NOW)[0]).toMatchObject({ status: "idle" });
  });

  it("never grades a living tmux done, however old the mail", () => {
    const routes = { lane: route({ id: "lane", tmux: "lane" }) };
    const ancient = parseMailNdjson(
      JSON.stringify({ id: "m-a", from: "coord", to: "lane", ts: "2026-08-01T00:00:00Z", kind: "request" }),
    );
    expect(registrySeeds(routes, [], new Set(["lane"]), ancient, NOW)[0]).toMatchObject({ status: "idle" });
  });

  it("skips a route whose session a store seed already carries", () => {
    const routes = { lane: route({ id: "lane", sessionId: "sess-1", harness: "opencode" }) };
    expect(registrySeeds(routes, [seed("sess-1")], new Set(), [], NOW)).toEqual([]);
  });

  it("seeds an unresolved opencode route under its agent id until resolve fills the session", () => {
    const routes = { lane: route({ id: "lane", harness: "opencode", tmux: "lane" }) };
    const [row] = registrySeeds(routes, [seed("sess-other")], new Set(), [], NOW);
    expect(row).toMatchObject({ sessionId: "lane", harness: "opencode", status: "done" });
  });

  it("joins the dispatch envelope through the agent-id fallback, so from/why still attach", () => {
    const routes = { "lane-a": route({ id: "lane-a", tmux: "lane-a" }) };
    const synth = registrySeeds(routes, [], new Set(), [], NOW);
    const [row] = enrichRows(synth, parseMailNdjson(dispatchLine), {});
    expect(row.from).toBe("coordinator");
    expect(row.why).toBe("build the trace panel");
  });

  // Proof-run defect: a lane dispatched by a dispatched coordinator had no
  // parent link, so the grandparent tab's related scope never showed it.
  it("hangs a dispatched lane under its dispatcher's resolved session", () => {
    const routes = {
      coord: route({ id: "coord", harness: "claude", cwd: "~/projects/x" }),
      lane: route({ id: "lane", tmux: "lane" }),
    };
    const stored = [seed("sess-real")];
    const resolved = resolveRouteSessions(routes, stored, "/Users/h");
    const envs = parseMailNdjson(
      JSON.stringify({ id: "m-d", from: "coord", to: "lane", ts: "2026-08-03T11:00:00Z", kind: "dispatch" }),
    );
    const [row] = registrySeeds(routes, stored, new Set(["lane"]), envs, NOW, resolved);
    expect(row).toMatchObject({ id: "lane", parentId: "sess-real", parentKind: "dispatch" });
  });

  it("leaves parentId null when the dispatcher is not a registered agent", () => {
    const routes = { lane: route({ id: "lane", tmux: "lane" }) };
    const envs = parseMailNdjson(
      JSON.stringify({ id: "m-u", from: "user", to: "lane", ts: "2026-08-03T11:00:00Z", kind: "request" }),
    );
    const [row] = registrySeeds(routes, [], new Set(["lane"]), envs, NOW);
    expect(row).toMatchObject({ parentId: null, parentKind: null });
  });

  // The log is append-only and lane ids get reused: a stale placeholder-from
  // envelope older than the real dispatch must not eat the parent edge.
  it("skips older placeholder froms and parents from the first agent envelope", () => {
    const routes = {
      coord: route({ id: "coord", sessionId: "sess-c", harness: "claude" }),
      lane: route({ id: "lane", tmux: "lane" }),
    };
    const envs = parseMailNdjson(
      [
        JSON.stringify({ id: "m-0", from: "coordinator", to: "lane", ts: "2026-08-03T10:00:00Z", kind: "dispatch" }),
        JSON.stringify({ id: "m-1", from: "coord", to: "lane", ts: "2026-08-03T11:00:00Z", kind: "dispatch" }),
      ].join("\n"),
    );
    const [row] = registrySeeds(routes, [], new Set(["lane"]), envs, NOW);
    expect(row).toMatchObject({ parentId: "sess-c", parentKind: "dispatch" });
  });

  // m-17f56e54 receipt: instant-fable's unresolved route seeded a second row
  // beside its own store session (same harness, same cwd), 6 shells where 2 ran.
  it("skips a route resolved onto a store seed instead of duplicating it", () => {
    const routes = { agent: route({ id: "agent", harness: "claude", tmux: "agent", cwd: "~/projects/x" }) };
    const stored = [seed("sess-real")];
    const resolved = resolveRouteSessions(routes, stored, "/Users/h");
    expect(resolved).toEqual({ agent: "sess-real" });
    expect(registrySeeds(routes, stored, new Set(["agent"]), [], NOW, resolved)).toEqual([]);
  });
});

describe("resolveRouteSessions", () => {
  it("maps an unresolved route to the newest store seed sharing harness and cwd", () => {
    const routes = { agent: route({ id: "agent", harness: "claude", cwd: "~/projects/x" }) };
    const older = { ...seed("sess-old"), lastActivity: "2026-08-02T01:00:00.000Z" };
    const newer = { ...seed("sess-new"), lastActivity: "2026-08-02T05:00:00.000Z" };
    expect(resolveRouteSessions(routes, [older, newer], "/Users/h")).toEqual({ agent: "sess-new" });
  });

  it("keeps an explicit sessionId and ignores cwd matches for it", () => {
    const routes = { agent: route({ id: "agent", sessionId: "sess-pinned", harness: "claude", cwd: "~/projects/x" }) };
    expect(resolveRouteSessions(routes, [seed("sess-other")], "/Users/h")).toEqual({ agent: "sess-pinned" });
  });

  it("matches across tilde and absolute cwd spellings", () => {
    const routes = { agent: route({ id: "agent", harness: "claude", cwd: "/Users/h/projects/x" }) };
    expect(resolveRouteSessions(routes, [seed("sess-real")], "/Users/h")).toEqual({ agent: "sess-real" });
  });

  it("never crosses harnesses on a shared cwd", () => {
    const routes = { agent: route({ id: "agent", harness: "opencode", cwd: "~/projects/x" }) };
    expect(resolveRouteSessions(routes, [seed("sess-claude")], "/Users/h")).toEqual({});
  });
});

describe("routeTmuxBySession", () => {
  // Sabotage receipt: five tmux sessions sharing one cwd made the cwd guess
  // join this tab's claude to a sibling session, so related scope missed
  // every lane the registry could have placed exactly.
  it("maps a resolved session to its recorded tmux name", () => {
    const map = routeTmuxBySession({
      main: route({ id: "main", sessionId: "sess-m", harness: "claude", tmux: "sprefa-3" }),
    });
    expect(map.get("sess-m")).toBe("sprefa-3");
  });

  it("keys an unresolved route by agent id and skips routes with no tmux", () => {
    const map = routeTmuxBySession({
      lane: route({ id: "lane", tmux: "lane" }),
      quiet: route({ id: "quiet", sessionId: "sess-q" }),
    });
    expect(map.get("lane")).toBe("lane");
    expect(map.has("sess-q")).toBe(false);
  });
});

describe("tmuxLiveNames", () => {
  it("reads the names out of a list_sessions answer", () => {
    expect(tmuxLiveNames([{ name: "lane-a" }, { name: "lane-b" }])).toEqual(["lane-a", "lane-b"]);
  });

  it("an empty list is an answer: no tmux session is alive", () => {
    expect(tmuxLiveNames([])).toEqual([]);
  });

  // Sabotage receipt: answering [] here instead of null graded every routed
  // lane done on the e2e page, whose stub resolves undefined for list_sessions.
  it("a host with no list answers null, not an empty list", () => {
    expect(tmuxLiveNames(undefined)).toBeNull();
    expect(tmuxLiveNames(null)).toBeNull();
    expect(tmuxLiveNames("nope")).toBeNull();
  });

  it("drops rows carrying no string name", () => {
    expect(tmuxLiveNames([{ name: "lane-a" }, {}, null, { name: 7 }])).toEqual(["lane-a"]);
  });
});

describe("settleRoutedStatus", () => {
  const node = (id: string, status: "live" | "idle" | "done" | "dead") => ({
    id,
    harness: "opencode" as const,
    parentId: null,
    parentKind: null,
    from: "user",
    why: "",
    ts: "",
    lastActivity: "",
    status,
    cwd: "",
    tmuxSession: null,
  });

  // Sabotage receipt: the fusion lane finished at 15:30 and still sat in the
  // bar as idle at 15:51; its registry tmux session had been gone the whole
  // time.
  it("flips a routed row to done the moment its tmux session is gone", () => {
    const [row] = settleRoutedStatus([node("sess-f", "idle")], new Map([["sess-f", "lane-f"]]), new Set());
    expect(row.status).toBe("done");
  });

  it("leaves a routed row alone while its tmux session lives", () => {
    const [row] = settleRoutedStatus([node("sess-f", "live")], new Map([["sess-f", "lane-f"]]), new Set(["lane-f"]));
    expect(row.status).toBe("live");
  });

  it("never touches unrouted rows or dead ones", () => {
    const rows = settleRoutedStatus(
      [node("plain", "idle"), node("gone", "dead")],
      new Map([["gone", "lane-g"]]),
      new Set(),
    );
    expect(rows.map((r) => r.status)).toEqual(["idle", "dead"]);
  });
});
