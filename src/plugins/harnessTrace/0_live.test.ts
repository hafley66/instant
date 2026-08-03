import { describe, expect, it } from "vitest";
import { LiveGate, MAIL_DIR, isLiveSample } from "./0_live";
import type { ILiveSample } from "./0_types";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

describe("LiveGate.status", () => {
  it("buckets by age exactly as the rust reader does", () => {
    expect(LiveGate.status(true, NOW, NOW)).toBe("live");
    expect(LiveGate.status(true, NOW - 2 * 60 * 1000, NOW)).toBe("live");
    expect(LiveGate.status(true, NOW - 2 * 60 * 1000 - 1, NOW)).toBe("idle");
    expect(LiveGate.status(true, NOW - 60 * 60 * 1000, NOW)).toBe("idle");
    expect(LiveGate.status(true, NOW - 60 * 60 * 1000 - 1, NOW)).toBe("done");
  });

  it("reads a vanished cwd as dead whatever the mtime says", () => {
    expect(LiveGate.status(false, NOW, NOW)).toBe("dead");
    expect(LiveGate.status(false, 0, NOW)).toBe("dead");
  });

  // A store written a few ms after the sample's clock read must not age
  // backwards into a negative bucket.
  it("clamps a future mtime to live", () => {
    expect(LiveGate.status(true, NOW + 5_000, NOW)).toBe("live");
  });
});

describe("LiveGate.iso", () => {
  it("returns the empty string for an unknown mtime", () => {
    expect(LiveGate.iso(0)).toBe("");
  });

  it("formats unix ms as ISO-8601 UTC", () => {
    expect(LiveGate.iso(1_722_470_400_000)).toBe("2024-08-01T00:00:00.000Z");
    expect(LiveGate.iso(1_722_470_461_500)).toBe("2024-08-01T00:01:01.500Z");
  });
});

const SAMPLE: ILiveSample = {
  index: 3,
  at: "2026-08-03T12:00:00.000Z",
  atMs: NOW,
  rows: [{
    id: "sess-1",
    harness: "claude",
    sessionId: "sess-1",
    parentId: null,
    parentKind: null,
    ts: "2026-08-03T11:58:00.000Z",
    lastActivity: "2026-08-03T11:59:30.000Z",
    status: "live",
    cwd: "/tmp/gate/cwd",
  }],
  files: { "registry.json": "{}", "bus.ndjson": "" },
  png: "/tmp/gate/png/03.png",
};

describe("LiveGate.seed", () => {
  it("keys the page seed on the dir the panel reads", () => {
    expect(LiveGate.seed(SAMPLE).mailDir).toBe(MAIL_DIR);
  });

  it("passes the sample's rows and mailbox bytes through untouched", () => {
    const seed = LiveGate.seed(SAMPLE);
    expect(seed.rows).toEqual(SAMPLE.rows);
    expect(seed.files).toEqual(SAMPLE.files);
  });
});

// The challenge detector. Fail-first receipt: the driver previously had no way
// to tell "refused and waiting on a human" from "the tool call is still
// running", and the second case below is exactly the one that would have fired
// a confirmation into the middle of the pinned command.
describe("LiveGate.turnEnded", () => {
  const line = (row: unknown) => JSON.stringify(row);
  const assistantText = line({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "confirm you want me to run this" }] },
  });
  const assistantTool = line({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", name: "Bash" }] },
  });
  const userTurn = line({ type: "user", message: { role: "user", content: "go" } });

  it("reads a text-only assistant message as the end of a turn", () => {
    expect(LiveGate.turnEnded(`${userTurn}\n${assistantText}\n`)).toBe(true);
  });

  it("never reads a pending tool call as the end of a turn", () => {
    expect(LiveGate.turnEnded(`${userTurn}\n${assistantTool}\n`)).toBe(false);
    expect(LiveGate.turnEnded(`${assistantText}\n${assistantTool}\n`)).toBe(false);
  });

  it("stays false while the user's message is the last record", () => {
    expect(LiveGate.turnEnded(`${assistantText}\n${userTurn}\n`)).toBe(false);
  });

  it("ignores non-conversational records and a half-written tail line", () => {
    const summary = line({ type: "summary", summary: "s" });
    expect(LiveGate.turnEnded(`${assistantText}\n${summary}\n`)).toBe(true);
    expect(LiveGate.turnEnded(`${assistantText}\n{"type":"assis`)).toBe(true);
    expect(LiveGate.turnEnded("")).toBe(false);
    expect(LiveGate.turnEnded("not json at all")).toBe(false);
  });
});

describe("isLiveSample", () => {
  it("accepts a recorded sample and rejects anything else", () => {
    expect(isLiveSample(SAMPLE)).toBe(true);
    expect(isLiveSample({ rows: [], at: "x" })).toBe(false);
    expect(isLiveSample(null)).toBe(false);
    expect(isLiveSample([])).toBe(false);
  });
});
