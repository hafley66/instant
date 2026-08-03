import { describe, expect, it } from "vitest";
import {
  enrichRows,
  mailAgentIdFor,
  parseMailLog,
  parseMailNdjson,
  parseMailRegistry,
  registrySeeds,
  routeTmuxBySession,
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
  // Sabotage receipt: before this seam, a `bus dispatch`ed shell lane existed
  // only in registry.json, so it never became a row on any scope.
  it("synthesizes a seed for a route no harness store reported", () => {
    const [row] = registrySeeds(
      { probe: route({ id: "probe", tmux: "probe", cwd: "/tmp/probe" }) },
      [],
      new Set(["probe"]),
    );
    expect(row).toMatchObject({ id: "probe", sessionId: "probe", harness: "shell", status: "live", cwd: "/tmp/probe" });
  });

  it("skips a route whose session a store seed already carries", () => {
    const routes = { lane: route({ id: "lane", sessionId: "sess-1", harness: "opencode" }) };
    expect(registrySeeds(routes, [seed("sess-1")], new Set())).toEqual([]);
  });

  it("seeds an unresolved opencode route under its agent id until resolve fills the session", () => {
    const routes = { lane: route({ id: "lane", harness: "opencode", tmux: "lane" }) };
    const [row] = registrySeeds(routes, [seed("sess-other")], new Set());
    expect(row).toMatchObject({ sessionId: "lane", harness: "opencode", status: "done" });
  });

  it("joins the dispatch envelope through the agent-id fallback, so from/why still attach", () => {
    const routes = { "lane-a": route({ id: "lane-a", tmux: "lane-a" }) };
    const synth = registrySeeds(routes, [], new Set());
    const [row] = enrichRows(synth, parseMailNdjson(dispatchLine), {});
    expect(row.from).toBe("coordinator");
    expect(row.why).toBe("build the trace panel");
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
