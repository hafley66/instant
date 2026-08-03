import { describe, expect, it } from "vitest";
import { MailStore } from "./0_bus";
import { MailLeg, injectedLine } from "./1_leg";
import type { IMailAgent } from "./0_types";

const message = MailStore.send({
  id: "m-abc123",
  from: "coordinator",
  to: "lane-a",
  from_timestamp: "2026-08-03T01:00:00Z",
  kind: "request",
  body: "read CONTRACT.md",
});

function agent(overrides: Partial<IMailAgent> = {}): IMailAgent {
  return {
    id: "lane-a",
    sessionId: "sess-a",
    harness: "claude",
    tmux: "busmail-a",
    cwd: null,
    sourcePath: null,
    ...overrides,
  };
}

function robot(paths: string[]): string {
  return JSON.stringify({
    query: "m-abc123",
    hits: paths.map((source_path, i) => ({
      source_path,
      workspace: "/Users/x/projects/demo",
      agent: "claude_code",
      line_number: i + 1,
    })),
  });
}

describe("injectedLine", () => {
  // The id must ride the injected text: the ack query has nothing else to find.
  it("prefixes the body with the envelope id", () => {
    expect(injectedLine(message)).toBe("[bus m-abc123] read CONTRACT.md");
  });
});

describe("MailLeg.tmuxSendArgs", () => {
  it("types the body literally then sends Enter separately", () => {
    expect(MailLeg.tmuxSendArgs(agent(), "hi; Enter", null)).toEqual([
      ["send-keys", "-t", "busmail-a", "-l", "--", "hi; Enter"],
      ["send-keys", "-t", "busmail-a", "Enter"],
    ]);
  });

  it("puts the socket first when the caller pins one", () => {
    const legs = MailLeg.tmuxSendArgs(agent(), "hi", "busmail-gate");
    expect(legs?.[0].slice(0, 2)).toEqual(["-L", "busmail-gate"]);
    expect(legs?.[1].slice(0, 2)).toEqual(["-L", "busmail-gate"]);
  });

  // Ruled: a recipient with no pane leaves the message queued, to_timestamp null.
  it("returns null when the agent has no tmux pane", () => {
    expect(MailLeg.tmuxSendArgs(agent({ tmux: null }), "hi", null)).toBeNull();
  });
});

describe("MailLeg.cassSearchArgs", () => {
  it("queries the envelope id in robot mode", () => {
    expect(MailLeg.cassSearchArgs(message)).toEqual([
      "search",
      "m-abc123",
      "--robot",
      "--limit",
      "20",
    ]);
  });
});

describe("MailLeg.cassHits", () => {
  const recipient = "/Users/x/.claude/projects/demo/sess-a.jsonl";
  const sender = "/Users/x/.claude/projects/demo/sess-coordinator.jsonl";

  it("keeps only hits inside the recipient's transcript", () => {
    const hits = MailLeg.cassHits(agent(), robot([sender, recipient]));
    expect(hits.map((h) => h.source_path)).toEqual([recipient]);
  });

  // The sender typed the id, so its own transcript matches too; an unscoped hit
  // would ack a message nobody received.
  it("does not ack on the sender's own transcript alone", () => {
    expect(MailLeg.cassHits(agent(), robot([sender]))).toEqual([]);
  });

  it("matches an exact source path when the route carries one", () => {
    const routed = agent({ sessionId: "", sourcePath: recipient });
    expect(MailLeg.cassHits(routed, robot([recipient]))).toHaveLength(1);
    expect(MailLeg.cassHits(routed, robot([sender]))).toEqual([]);
  });

  it("returns nothing for zero hits, malformed json, or an unroutable agent", () => {
    expect(MailLeg.cassHits(agent(), robot([]))).toEqual([]);
    expect(MailLeg.cassHits(agent(), "not json")).toEqual([]);
    expect(MailLeg.cassHits(agent(), JSON.stringify({ hits: "nope" }))).toEqual([]);
    expect(MailLeg.cassHits(agent({ sessionId: "" }), robot([recipient]))).toEqual([]);
  });
});
