import { describe, expect, it } from "vitest";
import { buildGraphTree, flattenTree, subtreeIds, type SessionGraph } from "./0_boopGraph";

const ident = (harness: string, id: string) => ({ harness, id });

const graph: SessionGraph = {
  schema_version: 1,
  sessions: [
    { session: ident("claude", "root-1"), cwd: "/p/hafley-rs", tmux: "%1", state: "idle", started_ts: 100, last_activity_ts: 900 },
    { session: ident("claude", "child-a"), cwd: "/p/hafley-rs", tmux: null, state: "idle", started_ts: 200, last_activity_ts: 800 },
    { session: ident("claude", "child-b"), cwd: "/p/hafley-rs", tmux: null, state: "idle", started_ts: 210, last_activity_ts: 850 },
    { session: ident("codex", "old-1"), cwd: "/p/old", tmux: null, state: "idle", started_ts: 1, last_activity_ts: 5 },
    { session: ident("codex", "old-child"), cwd: "/p/old", tmux: null, state: "idle", started_ts: 2, last_activity_ts: 600 },
    { session: ident("opencode", "lane-s"), cwd: "/p/wt", tmux: null, state: "idle", started_ts: 300, last_activity_ts: 700 },
  ],
  edges: [
    { parent: ident("claude", "root-1"), child: ident("claude", "child-a"), kind: "spawned" },
    { parent: ident("claude", "root-1"), child: ident("claude", "child-b"), kind: "spawned" },
    { parent: ident("codex", "old-1"), child: ident("codex", "old-child"), kind: "spawned" },
  ],
  shells: [
    { lane: "claude-498", parent_lane: null, harness: "claude", mode: "interactive", session_id: "root-1", session: ident("claude", "root-1"), cwd: "/p/hafley-rs", tmux: "%1", pid: 12, state: "live" },
    { lane: "feature-x", parent_lane: "claude-498", harness: "opencode", mode: "auto", session_id: "lane-s", session: ident("opencode", "lane-s"), cwd: "/p/wt", tmux: "feature-x", pid: null, state: "dead" },
    { lane: "orphan-lane", parent_lane: "gone-parent", harness: "opencode", mode: "auto", session_id: null, cwd: null, tmux: null, pid: null, state: "dead" },
  ],
};

describe("buildGraphTree", () => {
  const roots = buildGraphTree(graph, 500);

  it("folds a bound session into its lane and nests spawned sessions under it", () => {
    const coordinator = roots.find((n) => n.id === "claude-498");
    expect(coordinator?.sessionId).toBe("root-1");
    expect(coordinator?.state).toBe("live");
    expect(coordinator?.lastTs).toBe(900);
    const kids = coordinator!.children.map((n) => n.id).sort();
    expect(kids).toEqual(["claude:child-a", "claude:child-b", "feature-x"]);
  });

  it("keeps an inactive ancestor when its child is active in the window", () => {
    const old = roots.find((n) => n.id === "codex:old-1");
    expect(old?.children.map((n) => n.id)).toEqual(["codex:old-child"]);
  });

  it("makes a lane whose parent lane is unknown a root", () => {
    expect(roots.map((n) => n.id)).toContain("orphan-lane");
  });

  it("orders roots and children by most recent activity", () => {
    expect(roots[0].id).toBe("claude-498");
    const coordinator = roots[0];
    expect(coordinator.children.map((n) => n.id)).toEqual(["claude:child-b", "claude:child-a", "feature-x"]);
  });

  it("flattens and cuts a subtree by id", () => {
    expect(flattenTree(roots).length).toBe(7);
    expect([...subtreeIds(roots, "claude-498")].sort()).toEqual(["claude-498", "claude:child-a", "claude:child-b", "feature-x"]);
  });
});
