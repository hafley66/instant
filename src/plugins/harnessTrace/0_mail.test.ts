import { describe, expect, it } from "vitest";
import { enrichRows, parseMailNdjson, parseMailRegistry } from "./0_mail";
import type { HarnessTraceSeed } from "./0_types";

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
