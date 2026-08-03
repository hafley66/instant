import { describe, expect, it } from "vitest";
import { MailDirectory, MailStore } from "./0_bus";
import type { IMailMessage } from "./0_types";

function sent(id: string, from: string, to: string, at: string, extra: Partial<IMailMessage> = {}) {
  return MailStore.line({
    id,
    from,
    to,
    from_timestamp: at,
    to_timestamp: null,
    kind: "request",
    reply_to: null,
    body: `body of ${id}`,
    ref: null,
    ...extra,
  });
}

describe("MailStore.parse", () => {
  // Sabotage receipt: a malformed line between two valid rows is skipped and
  // both neighbours survive.
  it("skips malformed lines and rows without id or to", () => {
    const text = [
      sent("m-1", "coordinator", "lane-a", "2026-08-03T01:00:00Z"),
      "{not json",
      JSON.stringify({ from: "x", to: "y" }),
      JSON.stringify({ id: "m-9", from: "x" }),
      sent("m-2", "lane-a", "coordinator", "2026-08-03T02:00:00Z"),
    ].join("\n");
    expect(MailStore.parse(text).map((m) => m.id)).toEqual(["m-1", "m-2"]);
  });

  it("reads the pre-ruling `ts` field as from_timestamp", () => {
    const legacy = JSON.stringify({
      id: "env-1",
      from: "coordinator",
      to: "lane-a",
      ts: "2026-08-02T01:00:00Z",
      kind: "dispatch",
      body: "build the trace panel",
    });
    const [message] = MailStore.parse(legacy);
    expect(message.from_timestamp).toBe("2026-08-02T01:00:00Z");
    expect(message.to_timestamp).toBeNull();
    expect(message.kind).toBe("dispatch");
    expect(message.reply_to).toBeNull();
  });

  it("round-trips a ruled envelope through line/parse", () => {
    const message = MailStore.send({
      id: "m-7",
      from: "coordinator",
      to: "lane-a",
      from_timestamp: "2026-08-03T03:00:00Z",
      kind: "result",
      body: "done",
      reply_to: "m-1",
      ref: "plans/x.md",
    });
    expect(MailStore.parse(MailStore.line(message))).toEqual([message]);
    expect(JSON.parse(MailStore.line(message)).to_timestamp).toBeNull();
  });
});

describe("MailStore.fold", () => {
  it("appended ack row fills to_timestamp, latest row per id wins", () => {
    const send = sent("m-1", "coordinator", "lane-a", "2026-08-03T01:00:00Z");
    const ack = sent("m-1", "coordinator", "lane-a", "2026-08-03T01:00:00Z", {
      to_timestamp: "2026-08-03T01:05:00Z",
    });
    const folded = MailStore.fold(MailStore.parse([send, ack].join("\n")));
    expect(folded).toHaveLength(1);
    expect(folded[0].to_timestamp).toBe("2026-08-03T01:05:00Z");
  });

  it("an at-least-once resend after the ack cannot unack it", () => {
    const send = sent("m-1", "coordinator", "lane-a", "2026-08-03T01:00:00Z");
    const ack = sent("m-1", "coordinator", "lane-a", "2026-08-03T01:00:00Z", {
      to_timestamp: "2026-08-03T01:05:00Z",
    });
    const resend = sent("m-1", "coordinator", "lane-a", "2026-08-03T01:10:00Z", {
      body: "body of m-1 (resent)",
    });
    const folded = MailStore.fold(MailStore.parse([send, ack, resend].join("\n")));
    expect(folded[0].to_timestamp).toBe("2026-08-03T01:05:00Z");
    expect(folded[0].body).toBe("body of m-1 (resent)");
  });

  it("keeps first-appearance order across ids", () => {
    const text = [
      sent("m-2", "a", "b", "2026-08-03T05:00:00Z"),
      sent("m-1", "a", "b", "2026-08-03T01:00:00Z"),
      sent("m-2", "a", "b", "2026-08-03T05:00:00Z"),
    ].join("\n");
    expect(MailStore.fold(MailStore.parse(text)).map((m) => m.id)).toEqual(["m-2", "m-1"]);
  });
});

describe("MailStore in/out/unacked", () => {
  const rows = MailStore.parse(
    [
      sent("m-1", "coordinator", "lane-a", "2026-08-03T01:00:00Z"),
      sent("m-2", "lane-a", "coordinator", "2026-08-03T02:00:00Z", { kind: "result", reply_to: "m-1" }),
      sent("m-3", "coordinator", "lane-b", "2026-08-03T03:00:00Z"),
      sent("m-1", "coordinator", "lane-a", "2026-08-03T01:00:00Z", {
        to_timestamp: "2026-08-03T01:30:00Z",
      }),
    ].join("\n"),
  );

  it("inbox and outbox are per agent id, oldest first", () => {
    expect(MailStore.inbox(rows, "lane-a").map((m) => m.id)).toEqual(["m-1"]);
    expect(MailStore.outbox(rows, "lane-a").map((m) => m.id)).toEqual(["m-2"]);
    expect(MailStore.inbox(rows, "coordinator").map((m) => m.id)).toEqual(["m-2"]);
    expect(MailStore.outbox(rows, "coordinator").map((m) => m.id)).toEqual(["m-1", "m-3"]);
  });

  it("unacked is exactly the rows with to_timestamp null after the fold", () => {
    expect(MailStore.unacked(rows).map((m) => m.id)).toEqual(["m-2", "m-3"]);
  });

  it("ack returns a new row and never mutates the send row", () => {
    const [send] = MailStore.parse(sent("m-5", "a", "b", "2026-08-03T09:00:00Z"));
    const acked = MailStore.ack(send, "2026-08-03T09:01:00Z");
    expect(send.to_timestamp).toBeNull();
    expect(acked.to_timestamp).toBe("2026-08-03T09:01:00Z");
    expect(acked.id).toBe(send.id);
  });
});

describe("MailStore threading", () => {
  const rows = MailStore.parse(
    [
      sent("m-1", "coordinator", "lane-a", "2026-08-03T01:00:00Z"),
      sent("m-2", "lane-a", "coordinator", "2026-08-03T02:00:00Z", { reply_to: "m-1" }),
      sent("m-3", "coordinator", "lane-a", "2026-08-03T03:00:00Z", { reply_to: "m-2" }),
      sent("m-4", "coordinator", "lane-b", "2026-08-03T04:00:00Z"),
    ].join("\n"),
  );

  it("thread collects every reply sharing a root, oldest first", () => {
    expect(MailStore.thread(rows, "m-3").map((m) => m.id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(MailStore.thread(rows, "m-1").map((m) => m.id)).toEqual(["m-1", "m-2", "m-3"]);
    expect(MailStore.thread(rows, "m-4").map((m) => m.id)).toEqual(["m-4"]);
    expect(MailStore.thread(rows, "nope")).toEqual([]);
  });

  it("replyDepth counts hops to the root", () => {
    expect(MailStore.replyDepth(rows, "m-1")).toBe(0);
    expect(MailStore.replyDepth(rows, "m-2")).toBe(1);
    expect(MailStore.replyDepth(rows, "m-3")).toBe(2);
  });

  it("a reply_to cycle terminates instead of spinning", () => {
    const cyclic = MailStore.parse(
      [
        sent("c-1", "a", "b", "2026-08-03T01:00:00Z", { reply_to: "c-2" }),
        sent("c-2", "a", "b", "2026-08-03T02:00:00Z", { reply_to: "c-1" }),
      ].join("\n"),
    );
    expect(MailStore.thread(cyclic, "c-1").map((m) => m.id)).toEqual(["c-1", "c-2"]);
    expect(MailStore.thread(cyclic, "c-2").map((m) => m.id)).toEqual(["c-1", "c-2"]);
    expect(MailStore.replyDepth(cyclic, "c-1")).toBe(2);
  });

  it("a reply_to pointing at a missing row roots on itself", () => {
    const orphan = MailStore.parse(
      sent("o-1", "a", "b", "2026-08-03T01:00:00Z", { reply_to: "gone" }),
    );
    expect(MailStore.thread(orphan, "o-1").map((m) => m.id)).toEqual(["o-1"]);
    expect(MailStore.replyDepth(orphan, "o-1")).toBe(0);
  });
});

describe("MailStore.queue", () => {
  const rows = MailStore.parse(
    [
      sent("m-1", "coordinator", "lane-a", "2026-08-03T01:00:00Z"),
      sent("m-2", "lane-a", "coordinator", "2026-08-03T02:00:00Z", { reply_to: "m-1" }),
      sent("m-3", "coordinator", "lane-b", "2026-08-03T03:00:00Z"),
      sent("m-1", "coordinator", "lane-a", "2026-08-03T01:00:00Z", {
        to_timestamp: "2026-08-03T01:30:00Z",
      }),
    ].join("\n"),
  );

  it("interleaves both directions oldest first with thread depth", () => {
    expect(MailStore.queue(rows, "lane-a")).toEqual([
      expect.objectContaining({ direction: "in", depth: 0 }),
      expect.objectContaining({ direction: "out", depth: 1 }),
    ]);
    expect(MailStore.queue(rows, "lane-a").map((row) => row.message.id)).toEqual(["m-1", "m-2"]);
  });

  it("carries the folded ack state into the queue", () => {
    const [first] = MailStore.queue(rows, "lane-a");
    expect(first.message.to_timestamp).toBe("2026-08-03T01:30:00Z");
    expect(MailStore.queue(rows, "lane-b")[0].message.to_timestamp).toBeNull();
  });

  it("is empty for an agent with no mail", () => {
    expect(MailStore.queue(rows, "lane-z")).toEqual([]);
  });
});

describe("MailDirectory", () => {
  it("reads both the legacy string form and the route object", () => {
    const directory = MailDirectory.parse(
      JSON.stringify({
        "lane-a": "sess-9",
        "lane-b": {
          sessionId: "sess-b",
          harness: "claude",
          tmux: "busmail-b",
          sourcePath: "/Users/x/.claude/projects/p/sess-b.jsonl",
        },
        version: 1,
      }),
    );
    expect(directory["lane-a"]).toEqual({
      id: "lane-a",
      sessionId: "sess-9",
      harness: null,
      tmux: null,
      sourcePath: null,
    });
    expect(MailDirectory.agent(directory, "lane-b")?.tmux).toBe("busmail-b");
    expect(MailDirectory.agent(directory, "lane-b")?.harness).toBe("claude");
    expect(directory.version).toBeUndefined();
    expect(MailDirectory.agent(directory, "nobody")).toBeNull();
  });

  it("survives malformed json, arrays and unknown harness names", () => {
    expect(MailDirectory.parse("not json")).toEqual({});
    expect(MailDirectory.parse("[1,2]")).toEqual({});
    const directory = MailDirectory.parse(JSON.stringify({ x: { sessionId: "s", harness: "zsh" } }));
    expect(directory.x.harness).toBeNull();
  });
});
