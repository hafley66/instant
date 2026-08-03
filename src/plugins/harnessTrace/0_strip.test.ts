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
    expect(ids).toEqual(["oc-lane", "oc-sub"]);
  });

  it("widens to every external session, other terminals' included", () => {
    const ids = StripPolicy.external(TAB_TREE, "s1", "all").map((n) => n.id);
    expect(ids).toEqual(["oc-lane", "oc-sub", "claude-s2", "codex-s2"]);
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
    expect(ids).toEqual(["oc-lane", "oc-sub"]);
  });

  it("nativeIds claims through the s: prefix, so scope all still excludes this tab's claude", () => {
    const ids = StripPolicy.external(TAB_TREE, "s:s1", "all").map((n) => n.id);
    expect(ids).not.toContain("claude-s1");
    expect(ids).not.toContain("claude-sub");
  });
});

describe("StripPolicy.external drops finished lanes", () => {
  // Sabotage receipt: the first live day put 7 rows in the bar with 0 lanes
  // running; every dispatched-and-done lane counted as a "shell".
  it("keeps live and idle rows, drops done and dead on both scopes", () => {
    const day = [
      ...TAB_TREE,
      node({ id: "oc-done", harness: "opencode", status: "done", parentId: "claude-s1", parentKind: "dispatch" }),
      node({ id: "sh-dead", harness: "shell", status: "dead", tmuxSession: "s1" }),
      node({ id: "oc-idle", harness: "opencode", status: "idle", tmuxSession: "s1" }),
    ];
    const related = StripPolicy.external(day, "s1", "related").map((n) => n.id);
    expect(related).toEqual(["oc-lane", "oc-sub", "oc-idle"]);
    const all = StripPolicy.external(day, "s1", "all").map((n) => n.id);
    expect(all).not.toContain("oc-done");
    expect(all).not.toContain("sh-dead");
  });
});
