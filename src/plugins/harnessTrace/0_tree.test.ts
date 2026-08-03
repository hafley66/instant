import { describe, expect, it } from "vitest";
import {
  buildAgentTree,
  filterForestByTmux,
  resolveDispatchParents,
  toAgentNodes,
  type AgentTreeNode,
} from "./0_tree";
import type { AgentSessionNode, HarnessTraceRow, MailEnvelope } from "./0_types";

function node(partial: Partial<AgentSessionNode> & { id: string }): AgentSessionNode {
  return {
    harness: "claude",
    parentId: null,
    parentKind: null,
    from: "user",
    why: "",
    ts: "2026-08-02T00:00:00.000Z",
    lastActivity: "2026-08-02T01:00:00.000Z",
    status: "done",
    cwd: "~/projects/x",
    tmuxSession: null,
    ...partial,
  };
}

function row(partial: Partial<HarnessTraceRow> & { sessionId: string }): HarnessTraceRow {
  return {
    id: partial.sessionId,
    harness: "claude",
    parentId: null,
    parentKind: null,
    from: "user",
    why: "",
    ts: "2026-08-02T00:00:00.000Z",
    lastActivity: "2026-08-02T01:00:00.000Z",
    status: "done",
    cwd: "~/projects/x",
    ...partial,
  };
}

function env(partial: Partial<MailEnvelope> & { id: string }): MailEnvelope {
  return {
    from: "",
    to: "",
    ts: "2026-08-02T00:00:00Z",
    kind: "dispatch",
    ...partial,
  };
}

describe("buildAgentTree", () => {
  it("splits flat nodes into roots and children under their parent", () => {
    const roots = buildAgentTree([
      node({ id: "parent", harness: "claude", status: "live" }),
      node({ id: "kid-a", parentId: "parent", parentKind: "subagent", status: "live" }),
      node({ id: "kid-b", parentId: "parent", parentKind: "subagent", status: "done" }),
      node({ id: "solo", harness: "codex" }),
    ]);
    expect(roots.map((r) => r.id)).toEqual(["parent", "solo"]);
    const parent = roots[0];
    expect(parent.children.map((c) => c.id)).toEqual(["kid-a", "kid-b"]);
    expect(parent.children[0].parentKind).toBe("subagent");
    expect(roots[1].children).toEqual([]);
  });

  it("promotes an orphan child (missing parent) to a top-level root, never dropping it", () => {
    const roots = buildAgentTree([
      node({ id: "parent" }),
      node({ id: "orphan", parentId: "deleted-parent", parentKind: "subagent" }),
    ]);
    const ids = roots.map((r) => r.id);
    expect(ids).toContain("parent");
    expect(ids).toContain("orphan");
    expect(roots.length).toBe(2);
  });

  it("preserves node identity (not a referential snapshot) in tree nodes", () => {
    const roots = buildAgentTree([node({ id: "parent" })]);
    const childRef: AgentTreeNode = roots[0];
    expect(childRef.id).toBe("parent");
  });
});

describe("resolveDispatchParents", () => {
  it("attaches a dispatch parent when the envelope sender resolves to a live session", () => {
    const nodes: AgentSessionNode[] = [
      node({ id: "sess-driver", from: "fable" }),
      node({ id: "sess-child", harness: "opencode", from: "coordinator" }),
    ];
    const envelopes = [
      env({ id: "m-1", from: "fable", to: "oc-worker", body: "build the strip" }),
    ];
    const registry = { "oc-worker": "sess-child", fable: "sess-driver" };
    const resolved = resolveDispatchParents(nodes, envelopes, registry);
    const child = resolved.find((n) => n.id === "sess-child")!;
    expect(child.parentId).toBe("sess-driver");
    expect(child.parentKind).toBe("dispatch");
    const driver = resolved.find((n) => n.id === "sess-driver")!;
    expect(driver.parentId).toBeNull();
  });

  it("leaves a session top-level when its sender is unknown or not in the set", () => {
    const nodes: AgentSessionNode[] = [
      node({ id: "sess-child", harness: "opencode" }),
      node({ id: "other", harness: "codex" }),
    ];
    const envelopes = [env({ id: "m-1", from: "ghost", to: "oc-worker" })];
    const registry = { "oc-worker": "sess-child" }; // "ghost" maps nowhere
    const resolved = resolveDispatchParents(nodes, envelopes, registry);
    expect(resolved.find((n) => n.id === "sess-child")!.parentId).toBeNull();
    expect(resolved.find((n) => n.id === "sess-child")!.parentKind).toBeNull();
  });

  it("does not overwrite a rust-attached subagent parent", () => {
    const nodes: AgentSessionNode[] = [
      node({ id: "parent", from: "fable" }),
      node({ id: "kid", parentId: "parent", parentKind: "subagent" }),
    ];
    const envelopes = [env({ id: "m-1", from: "fable", to: "kid-x" })];
    const registry = { "kid-x": "kid", fable: "parent" };
    const resolved = resolveDispatchParents(nodes, envelopes, registry);
    expect(resolved.find((n) => n.id === "kid")!.parentKind).toBe("subagent");
  });
});

describe("toAgentNodes", () => {  it("maps seam rows to the frozen model keyed by session id and keeps from/why + a dispatch parent", () => {
    const rows = [
      row({ sessionId: "sess-driver", from: "fable", why: "run the lane" }),
      row({ sessionId: "sess-child", harness: "opencode", from: "coordinator" }),
      row({ sessionId: "kid-a", parentId: "sess-driver", parentKind: "subagent" }),
    ];
    const envelopes = [env({ id: "m-1", from: "fable", to: "oc-worker", body: "build it" })];
    const registry = { "oc-worker": "sess-child", fable: "sess-driver" };
    const nodes = toAgentNodes(rows, envelopes, registry);
    const child = nodes.find((n) => n.id === "sess-child")!;
    expect(child.id).toBe("sess-child");
    expect(child.from).toBe("coordinator");
    expect(child.parentId).toBe("sess-driver");
    expect(child.parentKind).toBe("dispatch");
    const sub = nodes.find((n) => n.id === "kid-a")!;
    expect(sub.parentKind).toBe("subagent");
  });
});

describe("filterForestByTmux", () => {
  it("keeps a tree containing a node joined to the sid and drops a tree without one", () => {
    const roots = buildAgentTree([
      node({ id: "t1-parent", tmuxSession: "s1", status: "live" }),
      node({ id: "t1-unjoined", parentId: "t1-parent", parentKind: "subagent", tmuxSession: null, status: "live" }),
      node({ id: "t2-parent", tmuxSession: "s2", status: "live" }),
      node({ id: "t2-child", parentId: "t2-parent", parentKind: "subagent", tmuxSession: "s2", status: "done" }),
    ]);
    const filtered = filterForestByTmux(roots, "s1");
    expect(filtered.map((r) => r.id)).toEqual(["t1-parent"]);
    const t1 = filtered[0];
    // The whole containing tree survives, including the unjoined child.
    expect(t1.children.map((c) => c.id)).toEqual(["t1-unjoined"]);
  });

  it("keeps a tree when only a nested descendant matches", () => {
    const roots = buildAgentTree([
      node({ id: "root", tmuxSession: null, status: "live" }),
      node({ id: "mid", parentId: "root", parentKind: "subagent", tmuxSession: null, status: "live" }),
      node({ id: "leaf", parentId: "mid", parentKind: "subagent", tmuxSession: "s1", status: "live" }),
    ]);
    const filtered = filterForestByTmux(roots, "s1");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("root");
    expect(filtered[0].children[0].id).toBe("mid");
    expect(filtered[0].children[0].children[0].id).toBe("leaf");
  });

  it("drops every tree when nothing is joined to the sid", () => {
    const roots = buildAgentTree([
      node({ id: "a", tmuxSession: "s9", status: "done" }),
      node({ id: "b", tmuxSession: null, status: "done" }),
    ]);
    expect(filterForestByTmux(roots, "s1")).toEqual([]);
  });
});
