// Pure rules for the in-tab strip: what a toggle press writes, when the shell
// renders, and which sessions belong in it. No React and no store import, so
// vitest covers them in the node environment the rest of the 0_ modules use.
import type { AgentSessionNode, IStripPolicy } from "./0_types";

// Transitive parentId closure over `nodes` starting from `seed` ids.
function descendantsOf(nodes: AgentSessionNode[], seed: Set<string>): Set<string> {
  const reachable = new Set(seed);
  for (let grew = true; grew; ) {
    grew = false;
    for (const node of nodes) {
      if (reachable.has(node.id) || !node.parentId || !reachable.has(node.parentId)) continue;
      reachable.add(node.id);
      grew = true;
    }
  }
  return reachable;
}

// This tab's own claude session (the claude row joined to its tmux session)
// plus the claude subagents descending from it. Transitive: a subagent of a
// subagent is still inside the TUI's own list.
function nativeClaudeIds(nodes: AgentSessionNode[], sid: string): Set<string> {
  const native = new Set(
    nodes.filter((n) => n.harness === "claude" && (n.tmuxMatches ?? []).includes(sid)).map((n) => n.id),
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

// Terminal ids carry the "s:" tab prefix (core.ts sessionId) while join rows
// and nodes hold raw tmux names; every comparison below runs in tmux-name
// units, so callers may pass either form.
function tmuxNameOf(sid: string): string {
  return sid.startsWith("s:") ? sid.slice(2) : sid;
}

export const StripPolicy: IStripPolicy = {
  // No entry means nothing is on screen for this terminal, so the first press
  // summons; only an existing entry flips.
  toggle(entry) {
    return { open: entry ? !entry.open : true };
  },

  tmuxNameOf,

  // An entry is an explicit user decision and wins outright: open renders the
  // shell even with zero rows (the empty state names the sid). Without one the
  // strip auto-appears only when it has something to show.
  visible(entry, rowCount, hasCurrent) {
    if (entry) return entry.open;
    return rowCount > 0 || hasCurrent;
  },

  nativeIds(nodes, sid) {
    return nativeClaudeIds(nodes, tmuxNameOf(sid));
  },

  // Done/dead rows stay out of the strip on every scope: the bar answers
  // "how many shells are going on", the full trace page keeps the history.
  // Subagent threads run inside their parent's pane, so they are not shells.
  external(nodes, sid, scope) {
    const tmux = tmuxNameOf(sid);
    const going = nodes.filter(
      (node) => (node.status === "live" || node.status === "idle") && node.parentKind !== "subagent",
    );
    const native = nativeClaudeIds(going, tmux);
    if (scope === "all") return going.filter((node) => !native.has(node.id));
    // Parent links only: the cwd guess joins same-cwd sessions from other
    // tabs to this sid, and a tab is not a relation.
    const related = descendantsOf(going, native);
    return going.filter((node) => related.has(node.id) && !native.has(node.id));
  },

  setActivation(entry, showActive) {
    return { open: entry ? entry.open : true, showActive };
  },

  openAction(row, liveTmux) {
    return row.tmuxSession !== null && liveTmux.has(row.tmuxSession) ? "open" : "ignore";
  },

  // Coordinator defect (m-36e96eb8): related is parent links only, so a tab
  // with no linked lanes read "0 external shells" while dispatched lanes ran.
  effectiveScope(nodes, sid, chosen) {
    if (chosen !== null) return chosen;
    if (StripPolicy.external(nodes, sid, "related").length > 0) return "related";
    return StripPolicy.external(nodes, sid, "all").length > 0 ? "all" : "related";
  },
};
