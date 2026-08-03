import { describe, expect, it } from "vitest";
import { LiveState } from "./2_liveState";
import type { ILiveSample } from "./0_types";

const CLAUDE = "4bf4853d-0000-4000-8000-000000000001";
const CHILD = "ses_livespawn01";

const REGISTRY = JSON.stringify({
  "gate-claude": { sessionId: CLAUDE, harness: "claude", tmux: "gate-claude", sourcePath: "/x.jsonl" },
  "oc-child": { sessionId: CHILD, harness: "opencode", tmux: null, sourcePath: null },
});

const HAIL = JSON.stringify({
  id: "m-hail01",
  from: "coordinator",
  to: "gate-claude",
  from_timestamp: "2026-08-03T12:00:00.000Z",
  to_timestamp: "2026-08-03T12:01:10.000Z",
  kind: "dispatch",
  reply_to: null,
  body: "run the pinned command",
  ref: null,
});

const SPAWN = JSON.stringify({
  id: "m-spawn01",
  from: "gate-claude",
  to: "oc-child",
  from_timestamp: "2026-08-03T12:00:40.000Z",
  to_timestamp: null,
  kind: "dispatch",
  reply_to: "m-hail01",
  body: "opencode run -m provider/model --auto \"...\"",
  ref: null,
});

function claudeRow() {
  return {
    id: CLAUDE,
    harness: "claude" as const,
    sessionId: CLAUDE,
    parentId: null,
    parentKind: null,
    ts: "2026-08-03T11:59:00.000Z",
    lastActivity: "2026-08-03T12:01:00.000Z",
    status: "live" as const,
    cwd: "/tmp/gate/cwd",
  };
}

function childRow(status: "live" | "idle") {
  return {
    id: CHILD,
    harness: "opencode" as const,
    sessionId: CHILD,
    parentId: null,
    parentKind: null,
    ts: "2026-08-03T12:00:40.000Z",
    lastActivity: "2026-08-03T12:00:55.000Z",
    status,
    cwd: "/tmp/gate/cwd",
  };
}

function sample(rows: ILiveSample["rows"], files: Record<string, string>): ILiveSample {
  return { index: 0, at: "2026-08-03T12:01:20.000Z", atMs: 0, rows, files, png: "" };
}

describe("LiveState.read", () => {
  it("reads the parent alone before the spawn", () => {
    const state = LiveState.read(sample([claudeRow()], { "registry.json": REGISTRY, "bus.ndjson": HAIL }));
    expect(state.parentId).toBe(CLAUDE);
    expect(state.childId).toBeNull();
    expect(state.rootCount).toBe(1);
    expect(state.sessionCount).toBe(1);
    // The hail's sender is not a session, so the parent stays a root.
    expect(state.parentFrom).toBe("coordinator");
  });

  it("hangs the spawned child under the parent through the dispatch row", () => {
    const state = LiveState.read(
      sample([claudeRow(), childRow("live")], { "registry.json": REGISTRY, "bus.ndjson": `${HAIL}\n${SPAWN}\n` }),
    );
    expect(state.childId).toBe(CHILD);
    expect(state.childParentId).toBe(CLAUDE);
    expect(state.childParentKind).toBe("dispatch");
    expect(state.rootCount).toBe(1);
    expect(state.sessionCount).toBe(2);
    expect(state.childStatus).toBe("live");
  });

  it("counts acked and unacked rows off the fold, not the raw lines", () => {
    // The hail appears twice: a send row then its ack row, as the append-only
    // log records it. The fold must read one message, acked.
    const unacked = JSON.stringify({ ...JSON.parse(HAIL), to_timestamp: null });
    const state = LiveState.read(
      sample([claudeRow(), childRow("idle")], {
        "registry.json": REGISTRY,
        "bus.ndjson": `${unacked}\n${SPAWN}\n${HAIL}\n`,
      }),
    );
    expect(state.acked).toBe(1);
    expect(state.unacked).toBe(1);
    expect(state.childStatus).toBe("idle");
  });

  it("keeps the child a root when no dispatch row names it", () => {
    const state = LiveState.read(
      sample([claudeRow(), childRow("live")], { "registry.json": REGISTRY, "bus.ndjson": HAIL }),
    );
    expect(state.childParentId).toBeNull();
    expect(state.childParentKind).toBeNull();
    expect(state.rootCount).toBe(2);
  });
});
