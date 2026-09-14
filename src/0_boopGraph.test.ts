import { describe, expect, it } from "vitest";
import {
  activeOnlyTree,
  buildGraphTree,
  flattenTree,
  subtreeIds,
  type GraphNode,
  type SessionGraph,
} from "./0_boopGraph";

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

describe("session/shell state mapping", () => {
  it("reads GraphSession.state: live stays live, dead or finished is dead, else idle", () => {
    const graph: SessionGraph = {
      schema_version: 1,
      sessions: [
        { session: ident("claude", "s-live"), cwd: null, tmux: null, state: "live", started_ts: 1, last_activity_ts: 100 },
        { session: ident("claude", "s-dead"), cwd: null, tmux: null, state: "dead", started_ts: 1, last_activity_ts: 100 },
        { session: ident("claude", "s-finished"), cwd: null, tmux: null, state: null, started_ts: 1, last_activity_ts: 100, finished_ts: 50 },
        { session: ident("claude", "s-idle"), cwd: null, tmux: null, state: "idle", started_ts: 1, last_activity_ts: 100 },
      ],
      edges: [],
      shells: [],
    };
    const byId = new Map(buildGraphTree(graph, 0).map((n) => [n.id, n.state]));
    expect(byId.get("claude:s-live")).toBe("live");
    expect(byId.get("claude:s-dead")).toBe("dead");
    expect(byId.get("claude:s-finished")).toBe("dead");
    expect(byId.get("claude:s-idle")).toBe("idle");
  });

  it("treats an unknown shell state as idle, not dead", () => {
    const graph: SessionGraph = {
      schema_version: 1,
      sessions: [],
      edges: [],
      shells: [
        { lane: "unknown-lane", parent_lane: null, harness: null, mode: null, session_id: null, cwd: null, tmux: null, pid: null, state: "unknown" },
      ],
    };
    expect(buildGraphTree(graph, 0)[0].state).toBe("idle");
  });

  it("disambiguates session labels that share a cwd base", () => {
    const graph: SessionGraph = {
      schema_version: 1,
      sessions: [
        { session: ident("claude", "aaaaaaaa-1"), cwd: "/p/same", tmux: null, state: "idle", started_ts: 1, last_activity_ts: 100 },
        { session: ident("claude", "bbbbbbbb-2"), cwd: "/p/same", tmux: null, state: "idle", started_ts: 1, last_activity_ts: 100 },
      ],
      edges: [],
      shells: [],
    };
    const labels = buildGraphTree(graph, 0).map((n) => n.label);
    expect(new Set(labels).size).toBe(2);
  });
});

const node = (id: string, state: GraphNode["state"], children: GraphNode[] = []): GraphNode => ({
  id,
  label: id,
  kind: "lane",
  harness: "opencode",
  state,
  cwd: null,
  sessionId: null,
  parentId: null,
  startedTs: 0,
  lastTs: 0,
  finishedTs: 0,
  children,
});

describe("activeOnlyTree", () => {
  it("keeps a live root and its live children, drops non-live ones", () => {
    const live = node("root", "live", [node("kid-live", "live"), node("kid-idle", "idle")]);
    const out = activeOnlyTree([live]);
    expect(out.map((n) => n.id)).toEqual(["root"]);
    expect(out[0].children.map((n) => n.id)).toEqual(["kid-live"]);
  });

  it("returns nothing when no node is live", () => {
    const dead = node("dead-root", "dead", [node("idle-kid", "idle")]);
    expect(activeOnlyTree([dead])).toEqual([]);
    expect(activeOnlyTree([])).toEqual([]);
  });

  it("hoists a live grandchild through an inactive parent onto the nearest live ancestor", () => {
    const root = node("live-root", "live", [
      node("idle-mid", "idle", [node("live-grand", "live", [node("live-great", "live")])]),
    ]);
    const out = activeOnlyTree([root]);
    expect(out[0].id).toBe("live-root");
    expect(out[0].children.map((n) => n.id)).toEqual(["live-grand"]);
    expect(out[0].children[0].parentId).toBe("live-root");
    expect(out[0].children[0].children.map((n) => n.id)).toEqual(["live-great"]);
  });

  it("makes a live grandchild under a fully inactive root a new root", () => {
    const deadRoot = node("dead-root", "dead", [node("live-grand", "live")]);
    const out = activeOnlyTree([deadRoot]);
    expect(out.map((n) => n.id)).toEqual(["live-grand"]);
    expect(out[0].parentId).toBeNull();
  });

  it("preserves stored ids and labels while copying the visible rows", () => {
    const grand = node("live-grand", "live");
    grand.label = "opencode · wt";
    const root = node("live-root", "live", [node("idle-mid", "idle", [grand])]);
    const out = activeOnlyTree([root]);
    expect(out[0].children[0].id).toBe("live-grand");
    expect(out[0].children[0].label).toBe("opencode · wt");
    expect(out[0].children[0]).not.toBe(grand);
  });
});
