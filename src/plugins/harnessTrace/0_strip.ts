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

// This tab's own harness session (the row joined to its tmux session) plus
// subagents descending from it. Transitive: a subagent of a subagent remains
// inside the TUI's own list regardless of which harness owns the pane.
function nativeSessionIds(
  nodes: AgentSessionNode[],
  sid: string,
  nativeSessionId?: string | null,
): Set<string> {
  const exact = nativeSessionId ? nodes.find((node) => node.id === nativeSessionId) : undefined;
  const roots = nodes.filter((node) => node.parentKind === null);
  const direct = roots.filter((node) => node.tmuxSession === sid);
  const claudeMatches = roots.filter(
    (node) => node.harness === "claude" && (node.tmuxMatches ?? []).includes(sid),
  );
  const joined = exact
    ? [exact]
    : direct.length > 0
      ? direct
      : claudeMatches;
  const native = new Set(joined.map((node) => node.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const node of nodes) {
      if (native.has(node.id)) continue;
      if (node.parentKind !== "subagent") continue;
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

// Scope + native subtraction, shared by the going-on table and history mode.
// Native and parent links resolve over ALL nodes: a native session that lost
// its pane (or finished) still anchors its descendants' related scope.
function inScope(
  all: AgentSessionNode[],
  subset: AgentSessionNode[],
  tmux: string,
  scope: "related" | "all",
  nativeSessionId?: string | null,
): AgentSessionNode[] {
  const native = nativeSessionIds(all, tmux, nativeSessionId);
  if (scope === "all") return subset.filter((node) => !native.has(node.id));
  const related = descendantsOf(all, native);
  return subset.filter((node) => related.has(node.id) && !native.has(node.id));
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

  nativeIds(nodes, sid, nativeSessionId) {
    return nativeSessionIds(nodes, tmuxNameOf(sid), nativeSessionId);
  },

  // Done/dead rows stay out of the strip on every scope: the bar answers
  // "how many shells are going on", the full trace page keeps the history.
  // Subagent threads run inside their parent's pane, and a session with no
  // pane at all is not a shell either (m-17f56e54); history keeps both.
  external(nodes, sid, scope, nativeSessionId) {
    const going = nodes.filter(
      (node) =>
        node.status === "live" &&
        node.parentKind !== "subagent" &&
        node.tmuxSession !== null,
    );
    return inScope(nodes, going, tmuxNameOf(sid), scope, nativeSessionId);
  },

  // History keeps done/dead and subagent threads (the waterfall draws them),
  // but the native exclusion and the scope hold like everywhere else.
  history(nodes, sid, scope, nativeSessionId) {
    return inScope(nodes, nodes, tmuxNameOf(sid), scope, nativeSessionId);
  },

  setActivation(entry, showActive) {
    return { open: entry ? entry.open : true, showActive };
  },

  openAction(row, liveTmux) {
    return row.tmuxSession !== null && liveTmux.has(row.tmuxSession) ? "open" : "ignore";
  },

  // Leak fix 2026-08-05: a tab WITH a native session but no children stays empty;
  // the widen to "all" only helps a spy tab joining no session of its own.
  effectiveScope(nodes, sid, chosen, nativeSessionId) {
    if (chosen !== null) return chosen;
    if (StripPolicy.external(nodes, sid, "related", nativeSessionId).length > 0) return "related";
    if (StripPolicy.nativeIds(nodes, sid, nativeSessionId).size > 0) return "related";
    return StripPolicy.external(nodes, sid, "all", nativeSessionId).length > 0 ? "all" : "related";
  },
};
