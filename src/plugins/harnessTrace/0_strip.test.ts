import { describe, expect, it } from "vitest";
import { StripPolicy } from "./0_strip";
import type { AgentSessionNode } from "./0_types";

function node(partial: Partial<AgentSessionNode> & { id: string }): AgentSessionNode {
  return {
    harness: "claude",
    parentId: null,
    parentKind: null,
    from: "user",
    why: "",
    ts: "2026-08-03T00:00:00.000Z",
    lastActivity: "2026-08-03T01:00:00.000Z",
    status: "live",
    cwd: "~/projects/demo",
    tmuxSession: null,
    ...partial,
    tmuxMatches: partial.tmuxMatches ?? (partial.tmuxSession != null ? [partial.tmuxSession] : []),
  };
}

// The tab: a claude session on tmux s1 with a claude subagent (both already
// listed by claude code's own TUI), which dispatched an opencode lane that has
// a subagent of its own. Tree two lives on another terminal.
const TAB_TREE: AgentSessionNode[] = [
  node({ id: "claude-s1", tmuxSession: "s1" }),
  node({ id: "claude-sub", parentId: "claude-s1", parentKind: "subagent" }),
  node({ id: "oc-lane", harness: "opencode", parentId: "claude-s1", parentKind: "dispatch", tmuxSession: "s1" }),
  node({ id: "oc-sub", harness: "opencode", parentId: "oc-lane", parentKind: "subagent" }),
  node({ id: "claude-s2", tmuxSession: "s2", cwd: "~/projects/other" }),
  node({ id: "codex-s2", harness: "codex", parentId: "claude-s2", parentKind: "dispatch", cwd: "~/projects/other" }),
];

// Fail-first receipt (both cases red at 57560ff): the base toggle read an
// absent entry as open and wrote open:false on the first press, and the base
// visibility hid the shell whenever the row set was empty, so a summon on a
// fresh terminal showed nothing.
describe("StripPolicy.toggle", () => {
  it("summons on the first press of a terminal that has no entry", () => {
    expect(StripPolicy.toggle(null)).toEqual({ open: true });
  });

  it("flips an entry that exists", () => {
    expect(StripPolicy.toggle({ open: true })).toEqual({ open: false });
    expect(StripPolicy.toggle({ open: false })).toEqual({ open: true });
  });

  it("round-trips: press, press, press ends open", () => {
    const once = StripPolicy.toggle(null);
    const twice = StripPolicy.toggle(once);
    expect(StripPolicy.toggle(twice)).toEqual({ open: true });
  });
});

describe("StripPolicy.setActivation", () => {
  it("flips the checkbox on an on-screen auto-appeared entry, keeping it open", () => {
    expect(StripPolicy.setActivation(null, false)).toEqual({ open: true, showActive: false });
  });

  it("keeps the entry's open state and sets showActive", () => {
    expect(StripPolicy.setActivation({ open: true }, false)).toEqual({ open: true, showActive: false });
    expect(StripPolicy.setActivation({ open: false, showActive: false }, true)).toEqual({
      open: false,
      showActive: true,
    });
  });
});

describe("StripPolicy.visible", () => {
  it("renders the shell on an explicit summon with zero rows", () => {
    expect(StripPolicy.visible({ open: true }, 0, false)).toBe(true);
  });

  it("keeps a dismissed strip hidden even with rows and a pushed view", () => {
    expect(StripPolicy.visible({ open: false }, 5, true)).toBe(false);
  });

  it("auto-appears for an absent entry only when there is something to show", () => {
    expect(StripPolicy.visible(null, 0, false)).toBe(false);
    expect(StripPolicy.visible(null, 2, false)).toBe(true);
    expect(StripPolicy.visible(null, 0, true)).toBe(true);
  });
});

describe("StripPolicy.nativeIds", () => {
  it("claims this tab's claude session and its claude subagents, nothing else", () => {
    expect([...StripPolicy.nativeIds(TAB_TREE, "s1")].sort()).toEqual(["claude-s1", "claude-sub"]);
  });

  it("claims a subagent of a subagent (the TUI nests them too)", () => {
    const deep = [...TAB_TREE, node({ id: "claude-deep", parentId: "claude-sub", parentKind: "subagent" })];
    expect(StripPolicy.nativeIds(deep, "s1").has("claude-deep")).toBe(true);
  });

  it("claims nothing on a terminal whose sid joins no claude session", () => {
    expect(StripPolicy.nativeIds(TAB_TREE, "s9").size).toBe(0);
  });
});

describe("StripPolicy.external", () => {
  it("keeps only the externals of this tab's tree, never the claude rows the TUI shows", () => {
    const ids = StripPolicy.external(TAB_TREE, "s1", "related").map((n) => n.id);
    expect(ids).toEqual(["oc-lane"]);
  });

  it("widens to every external session, other terminals' included", () => {
    const ids = StripPolicy.external(TAB_TREE, "s1", "all").map((n) => n.id);
    expect(ids).toEqual(["oc-lane", "claude-s2"]);
  });

  // m-17f56e54 receipt: three pane-less scratch transcripts counted as
  // shells; a session with no tmux pane is history, never a going-on row.
  it("drops a pane-less session from the going-on bar on both scopes", () => {
    const day = [...TAB_TREE, node({ id: "oc-orphan", harness: "opencode", parentId: "claude-s1", parentKind: "dispatch" })];
    expect(StripPolicy.external(day, "s1", "all").map((n) => n.id)).not.toContain("oc-orphan");
    expect(StripPolicy.external(day, "s1", "related").map((n) => n.id)).not.toContain("oc-orphan");
    expect(StripPolicy.history(day, "s1", "all").map((n) => n.id)).toContain("oc-orphan");
  });

  // The pane assignment can starve this tab's own claude session (a routed
  // lane claims the shared pane); native must still anchor its descendants.
  it("keeps related anchored on a native session that lost its pane", () => {
    const day = TAB_TREE.map((n) =>
      n.id === "claude-s1" ? { ...n, tmuxSession: null, tmuxMatches: ["s1"] } : n,
    );
    expect(StripPolicy.external(day, "s1", "related").map((n) => n.id)).toEqual(["oc-lane"]);
    expect(StripPolicy.effectiveScope(day, "s1", null)).toBe("related");
  });

  it("keeps related anchored on a native session that finished", () => {
    const day = TAB_TREE.map((n) => (n.id === "claude-s1" ? { ...n, status: "done" as const } : n));
    expect(StripPolicy.external(day, "s1", "related").map((n) => n.id)).toEqual(["oc-lane"]);
  });

  it("drops the other terminal's tree from the related scope", () => {
    const ids = StripPolicy.external(TAB_TREE, "s1", "related").map((n) => n.id);
    expect(ids).not.toContain("codex-s2");
  });

  it("leaves an external row whose claude parent is gone reachable as a root", () => {
    const external = StripPolicy.external(TAB_TREE, "s1", "related");
    const lane = external.find((n) => n.id === "oc-lane");
    expect(lane?.parentId).toBe("claude-s1");
    expect(external.some((n) => n.id === "claude-s1")).toBe(false);
  });
});

describe("StripPolicy.tmuxNameOf", () => {
  it("strips the tab prefix a terminal id carries", () => {
    expect(StripPolicy.tmuxNameOf("s:sprefa-3")).toBe("sprefa-3");
  });

  it("passes a raw tmux name through", () => {
    expect(StripPolicy.tmuxNameOf("sprefa-3")).toBe("sprefa-3");
  });
});

describe("StripPolicy with a tab-prefixed terminal id", () => {
  // Sabotage receipt: before tmuxNameOf, "s:s1" matched no join row, so
  // related came back empty on every real tab and this tab's own claude
  // leaked into scope "all" as an external row.
  it("related scope matches through the s: prefix", () => {
    const ids = StripPolicy.external(TAB_TREE, "s:s1", "related").map((n) => n.id);
    expect(ids).toEqual(["oc-lane"]);
  });

  it("nativeIds claims through the s: prefix, so scope all still excludes this tab's claude", () => {
    const ids = StripPolicy.external(TAB_TREE, "s:s1", "all").map((n) => n.id);
    expect(ids).not.toContain("claude-s1");
    expect(ids).not.toContain("claude-sub");
  });
});

describe("StripPolicy.external keeps only active lanes", () => {
  // Sabotage receipt: the first live day put 7 rows in the bar with 0 lanes
  // running; every dispatched-and-done lane counted as a "shell".
  it("keeps live rows and drops idle, done, and dead rows on both scopes", () => {
    const day = [
      ...TAB_TREE,
      node({ id: "oc-done", harness: "opencode", status: "done", parentId: "claude-s1", parentKind: "dispatch" }),
      node({ id: "sh-dead", harness: "shell", status: "dead", tmuxSession: "s1" }),
      node({ id: "oc-idle", harness: "opencode", status: "idle", tmuxSession: "s1" }),
    ];
    const related = StripPolicy.external(day, "s1", "related").map((n) => n.id);
    expect(related).toEqual(["oc-lane"]);
    const all = StripPolicy.external(day, "s1", "all").map((n) => n.id);
    expect(all).not.toContain("oc-idle");
    expect(all).not.toContain("oc-done");
    expect(all).not.toContain("sh-dead");
  });
});

describe("StripPolicy.external related is parent links only", () => {
  // Defect receipt 2026-08-04: the user's own codex tab (same cwd, so its
  // tmuxMatches carried the viewing tab's sid) showed up in related scope.
  it("drops another tab's session that joins this sid through the cwd guess", () => {
    const nodes: AgentSessionNode[] = [
      node({ id: "claude-here", tmuxSession: "s1" }),
      node({ id: "codex-tab", harness: "codex", tmuxSession: "sprefa-2", tmuxMatches: ["sprefa-2", "s1"] }),
    ];
    expect(StripPolicy.external(nodes, "s1", "related")).toEqual([]);
    expect(StripPolicy.external(nodes, "s1", "all").map((n) => n.id)).toEqual(["codex-tab"]);
  });

  it("keeps a parentless session out of related even when tmux-joined to this tab", () => {
    const nodes: AgentSessionNode[] = [
      node({ id: "claude-here", tmuxSession: "s1" }),
      node({ id: "oc-stray", harness: "opencode", tmuxSession: "s1" }),
    ];
    expect(StripPolicy.external(nodes, "s1", "related")).toEqual([]);
  });
});

describe("StripPolicy native harness anchors", () => {
  it("shows a dispatched OpenCode lane related to a Codex tmux tab", () => {
    const nodes = [
      node({ id: "codex-parent", harness: "codex", tmuxSession: "instant", tmuxMatches: ["instant"], status: "live" }),
      node({ id: "flash-child", harness: "opencode", parentId: "codex-parent", parentKind: "dispatch", tmuxSession: "flash", status: "live" }),
    ];
    expect(StripPolicy.external(nodes, "instant", "related").map((entry) => entry.id)).toEqual(["flash-child"]);
  });
});

describe("StripPolicy.external with a subagent thread of an external session", () => {
  // Defect receipt 2026-08-04: codex's guardian thread (thread_source subagent,
  // parent_thread_id set, same cwd) rendered as a second external shell, so one
  // codex pane on sprefa-2 counted as "2 external shells" with different ids.
  it("counts one shell for a codex session plus its guardian thread, both scopes", () => {
    const nodes: AgentSessionNode[] = [
      node({ id: "claude-here", tmuxSession: "s1" }),
      node({ id: "codex-main", harness: "codex", parentId: "claude-here", parentKind: "dispatch", tmuxSession: "s2" }),
      node({ id: "codex-guardian", harness: "codex", parentId: "codex-main", parentKind: "subagent", tmuxSession: "s2" }),
    ];
    expect(StripPolicy.external(nodes, "s1", "all").map((n) => n.id)).toEqual(["codex-main"]);
    expect(StripPolicy.external(nodes, "s1", "related").map((n) => n.id)).toEqual(["codex-main"]);
  });
});

describe("StripPolicy.openAction", () => {
  // Fail-first receipt (RCA 2026-08-03): a routed row whose tmux died passed
  // `if (r.tmuxSession)` and `new-session -A` minted an empty shell on click.
  it("ignores a routed row whose tmux is missing from the live list", () => {
    expect(StripPolicy.openAction({ tmuxSession: "lane-dead" }, new Set(["other"]))).toBe("ignore");
  });

  it("opens a row whose tmux is live", () => {
    expect(StripPolicy.openAction({ tmuxSession: "lane-a" }, new Set(["lane-a"]))).toBe("open");
  });

  it("ignores an unjoined row", () => {
    expect(StripPolicy.openAction({ tmuxSession: null }, new Set(["lane-a"]))).toBe("ignore");
  });
});

describe("StripPolicy.history", () => {
  // REVIEW-reactive finding 5: history mode passed raw nodes to the waterfall,
  // drawing the tab's own claude session, the one thing the bar must not show.
  it("drops native claude rows, keeps done/dead externals and subagent threads on scope all", () => {
    const day = [
      ...TAB_TREE,
      node({ id: "oc-done", harness: "opencode", status: "done", parentId: "claude-s1", parentKind: "dispatch" }),
    ];
    const ids = StripPolicy.history(day, "s1", "all").map((n) => n.id);
    expect(ids).not.toContain("claude-s1");
    expect(ids).not.toContain("claude-sub");
    expect(ids).toContain("oc-done");
    expect(ids).toContain("oc-sub");
  });

  it("related keeps parent-link descendants only", () => {
    const ids = StripPolicy.history(TAB_TREE, "s1", "related").map((n) => n.id);
    expect(ids).toEqual(["oc-lane", "oc-sub"]);
  });
});

describe("StripPolicy.effectiveScope", () => {
  // Coordinator receipt (m-36e96eb8, screenshot 23:28): a coordinator tab's
  // strip said "0 external shells" while four dispatched lanes ran in tmux.
  const lanes = [node({ id: "oc-a", harness: "opencode", tmuxSession: "oc-a" })];

  it("widens an untouched related scope that matches nothing", () => {
    expect(StripPolicy.effectiveScope(lanes, "s9", null)).toBe("all");
  });

  it("keeps related when it has rows", () => {
    expect(StripPolicy.effectiveScope(TAB_TREE, "s1", null)).toBe("related");
  });

  it("honors an explicit choice even when related is empty", () => {
    expect(StripPolicy.effectiveScope(lanes, "s9", "related")).toBe("related");
  });

  it("stays related when both scopes are empty (the empty state names the sid)", () => {
    expect(StripPolicy.effectiveScope([], "s9", null)).toBe("related");
  });

  // Leak receipt 2026-08-05: a rooted tab (native claude session present) with
  // no children widened to "all" and showed sibling roots from other projects.
  it("stays related for a rooted tab with a native session but no children", () => {
    const rooted = [
      node({ id: "claude-here", tmuxSession: "s1" }),
      node({ id: "claude-other-tree", tmuxSession: "s2", cwd: "~/projects/other" }),
    ];
    expect(StripPolicy.effectiveScope(rooted, "s1", null)).toBe("related");
    expect(StripPolicy.external(rooted, "s1", "related")).toEqual([]);
  });
});

describe("StripPolicy exact native session identity", () => {
  it("anchors a same-cwd fourth tab to its recorded session instead of every matching root", () => {
    const nodes = [
      node({ id: "tab-1", tmuxSession: "repo", tmuxMatches: ["repo", "repo-4"] }),
      node({ id: "tab-4", tmuxSession: "repo-4", tmuxMatches: ["repo", "repo-4"] }),
      node({ id: "lane-1", harness: "opencode", parentId: "tab-1", parentKind: "dispatch", tmuxSession: "lane-1" }),
      node({ id: "lane-4", harness: "opencode", parentId: "tab-4", parentKind: "dispatch", tmuxSession: "lane-4" }),
    ];

    expect([...StripPolicy.nativeIds(nodes, "repo-4", "tab-4")]).toEqual(["tab-4"]);
    expect(StripPolicy.external(nodes, "repo-4", "related", "tab-4").map((entry) => entry.id)).toEqual([
      "lane-4",
    ]);
    expect(StripPolicy.effectiveScope(nodes, "repo-4", null, "tab-4")).toBe("related");
  });
});

describe("StripPolicy.external with a cwd shared by several tmux sessions", () => {
  // Defect receipt: a repo directory hosts tmux sessions "demo" and "demo-3".
  // The cwd guess pinned the node's tmuxSession to "demo", so a viewer on
  // "demo-3" saw related as empty forever. tmuxMatches carries every match, so
  // the viewer's sid matches even though the display guess is "demo".
  it("related scope reaches a node whose tmuxSession guessed one of the shared sessions", () => {
    const nodes: AgentSessionNode[] = [
      node({ id: "claude-demo", tmuxSession: "demo", tmuxMatches: ["demo", "demo-3"] }),
      node({ id: "oc-demo", harness: "opencode", parentId: "claude-demo", parentKind: "dispatch", tmuxSession: "oc-demo" }),
    ];
    expect([...StripPolicy.nativeIds(nodes, "demo-3")].sort()).toEqual(["claude-demo"]);
    const related = StripPolicy.external(nodes, "demo-3", "related").map((n) => n.id);
    expect(related).toEqual(["oc-demo"]);
  });
});
