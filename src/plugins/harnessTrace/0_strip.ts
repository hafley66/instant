// Pure rules for the in-tab strip: what a toggle press writes, when the shell
// renders, and which sessions belong in it. No React and no store import, so
// vitest covers them in the node environment the rest of the 0_ modules use.
import { buildAgentTree, filterForestByTmux, type AgentTreeNode } from "./0_tree";
import type { AgentSessionNode, IStripPolicy } from "./0_types";

// Every id in a forest, roots and descendants.
function forestIds(roots: AgentTreeNode[], into: Set<string>): Set<string> {
  for (const root of roots) {
    into.add(root.id);
    forestIds(root.children, into);
  }
  return into;
}

// This tab's own claude session (the claude row joined to its tmux session)
// plus the claude subagents descending from it. Transitive: a subagent of a
// subagent is still inside the TUI's own list.
function nativeClaudeIds(nodes: AgentSessionNode[], sid: string): Set<string> {
  const native = new Set(
    nodes.filter((n) => n.harness === "claude" && n.tmuxSession === sid).map((n) => n.id),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const node of nodes) {
      if (native.has(node.id)) continue;
      if (node.harness !== "claude" || node.parentKind !== "subagent") continue;
      if (node.parentId && native.has(node.parentId)) {
        native.add(node.id);
        grew = true;
      }
    }
  }
  return native;
}

export const StripPolicy: IStripPolicy = {
  // No entry means nothing is on screen for this terminal, so the first press
  // summons; only an existing entry flips.
  toggle(entry) {
    return { open: entry ? !entry.open : true };
  },

  // An entry is an explicit user decision and wins outright: open renders the
  // shell even with zero rows (the empty state names the sid). Without one the
  // strip auto-appears only when it has something to show.
  visible(entry, rowCount, hasCurrent) {
    if (entry) return entry.open;
    return rowCount > 0 || hasCurrent;
  },

  nativeIds: nativeClaudeIds,

  external(nodes, sid, scope) {
    const native = nativeClaudeIds(nodes, sid);
    if (scope === "all") return nodes.filter((node) => !native.has(node.id));
    const related = forestIds(filterForestByTmux(buildAgentTree(nodes), sid), new Set<string>());
    return nodes.filter((node) => related.has(node.id) && !native.has(node.id));
  },
};
