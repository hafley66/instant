// The boop panel's tree, built from boop's own session graph (`boop_session_graph`):
// lanes nest under their parent lane, harness sessions nest under the session
// that spawned them, and a session a lane is bound to is folded into that lane's
// row. agent_route alone is the live registry and forgets a lane once it is
// done; the graph keeps every spawn, so history nests too.

export type GraphIdent = { harness: string; id: string };

export type GraphSession = {
  session: GraphIdent;
  cwd: string | null;
  tmux: string | null;
  state: string | null;
  trace?: string | null;
  started_ts?: number | null;
  last_activity_ts: number | null;
  finished_ts?: number | null;
};

export type GraphEdge = {
  parent: GraphIdent;
  child: GraphIdent;
  kind: string;
  first_ts?: number | null;
  last_ts?: number | null;
};

export type GraphShell = {
  lane: string;
  parent_lane: string | null;
  harness: string | null;
  mode: string | null;
  session_id: string | null;
  session?: GraphIdent | null;
  trace?: string | null;
  cwd: string | null;
  tmux: string | null;
  tmux_session?: string | null;
  tmux_pane?: string | null;
  pid: number | null;
  state: string;
  started_ts?: number | null;
  registered_at?: string | null;
};

export type SessionGraph = {
  schema_version: number;
  sessions: GraphSession[];
  edges: GraphEdge[];
  shells: GraphShell[];
  trace_events?: unknown[];
};

export type GraphNode = {
  id: string;
  label: string;
  kind: "lane" | "session";
  harness: string | null;
  /** live: a process or pane answers; dead: a lane that ended; idle: a session with no liveness evidence. */
  state: "live" | "dead" | "idle";
  cwd: string | null;
  sessionId: string | null;
  parentId: string | null;
  startedTs: number;
  lastTs: number;
  finishedTs: number;
  children: GraphNode[];
};

export const sessionNodeId = (ident: GraphIdent) => `${ident.harness}:${ident.id}`;

function baseName(path: string | null): string {
  if (!path) return "";
  return path.replace(/\/$/, "").split("/").pop() ?? "";
}

// backend liveness dictionaries: shells carry "live"/"dead"/reported status,
// sessions carry "live"/"dead"/"idle" plus a finished_ts span. Anything that
// is neither is idle, not dead: an unprobed session is history, not an ending.
function shellState(state: string): GraphNode["state"] {
  if (state === "live") return "live";
  if (state === "dead") return "dead";
  return "idle";
}

function sessionState(session: GraphSession): GraphNode["state"] {
  if (session.state === "live") return "live";
  if (session.state === "dead" || session.finished_ts) return "dead";
  return "idle";
}

// Duplicate cwd bases would otherwise paint identical labels for distinct
// sessions. Only the collided rows gain a short id suffix, so common labels
// stay short and every row stays distinguishable.
function disambiguateSessionLabels(nodes: Map<string, GraphNode>): void {
  const seen = new Set<string>();
  for (const node of nodes.values()) {
    if (node.kind !== "session") continue;
    if (!seen.has(node.label)) {
      seen.add(node.label);
      continue;
    }
    const id = node.sessionId ?? node.id;
    let length = 6;
    let label = `${node.label} · ${id.slice(-length)}`;
    while (seen.has(label) && length < id.length) {
      length += 4;
      label = `${node.label} · ${id.slice(-length)}`;
    }
    node.label = label;
    seen.add(label);
  }
}

// The tree. `sinceTs` drops sessions with no activity in the window unless a
// lane binds them or a kept session descends from them (ancestors stay so
// the family remains connected). Lanes are always kept.
export function buildGraphTree(graph: SessionGraph, sinceTs: number): GraphNode[] {
  const nodes = new Map<string, GraphNode>();
  const laneNames = new Set(graph.shells.map((shell) => shell.lane));
  const ownerOfSession = new Map<string, string>();

  for (const shell of graph.shells) {
    const boundId = shell.session?.id ?? shell.session_id ?? null;
    if (boundId) ownerOfSession.set(boundId, shell.lane);
    nodes.set(shell.lane, {
      id: shell.lane,
      label: shell.lane,
      kind: "lane",
      harness: shell.harness,
      state: shellState(shell.state),
      cwd: shell.cwd,
      sessionId: boundId,
      parentId: shell.parent_lane && laneNames.has(shell.parent_lane) ? shell.parent_lane : null,
      startedTs: shell.started_ts ?? 0,
      lastTs: shell.started_ts ?? 0,
      finishedTs: 0,
      children: [],
    });
  }

  const byId = new Map(graph.sessions.map((session) => [session.session.id, session] as const));
  const parentOf = new Map<string, string>();
  for (const edge of graph.edges) parentOf.set(edge.child.id, edge.parent.id);

  const keep = new Set<string>();
  for (const session of graph.sessions) {
    const active = (session.last_activity_ts ?? session.started_ts ?? 0) >= sinceTs;
    if (active || ownerOfSession.has(session.session.id)) keep.add(session.session.id);
  }
  // Ancestors of kept sessions stay, so a child never dangles.
  for (const id of [...keep]) {
    let cursor = parentOf.get(id);
    let guard = 0;
    while (cursor && guard++ < 64 && !keep.has(cursor)) {
      if (byId.has(cursor)) keep.add(cursor);
      cursor = parentOf.get(cursor);
    }
  }

  // A kept session either folds into the lane bound to it or becomes its own row.
  const nodeIdOfSession = (id: string): string | null => {
    const owner = ownerOfSession.get(id);
    if (owner) return owner;
    return keep.has(id) ? sessionNodeId({ harness: byId.get(id)?.session.harness ?? "?", id }) : null;
  };

  for (const session of graph.sessions) {
    const id = session.session.id;
    if (!keep.has(id)) continue;
    const started = session.started_ts ?? 0;
    const last = session.last_activity_ts ?? started;
    const owner = ownerOfSession.get(id);
    if (owner) {
      const lane = nodes.get(owner)!;
      lane.startedTs = lane.startedTs || started;
      lane.lastTs = Math.max(lane.lastTs, last);
      lane.finishedTs = session.finished_ts ?? 0;
      if (!lane.cwd) lane.cwd = session.cwd;
      continue;
    }
    nodes.set(sessionNodeId(session.session), {
      id: sessionNodeId(session.session),
      label: `${session.session.harness} · ${baseName(session.cwd) || id.slice(0, 8)}`,
      kind: "session",
      harness: session.session.harness,
      state: sessionState(session),
      cwd: session.cwd,
      sessionId: id,
      parentId: null,
      startedTs: started,
      lastTs: last,
      finishedTs: session.finished_ts ?? 0,
      children: [],
    });
  }

  disambiguateSessionLabels(nodes);

  // Spawn edges: a child hangs under whichever row carries its parent session.
  // A lane that already names a parent lane keeps that edge.
  for (const edge of graph.edges) {
    const childNodeId = nodeIdOfSession(edge.child.id);
    const parentNodeId = nodeIdOfSession(edge.parent.id);
    if (!childNodeId || !parentNodeId || childNodeId === parentNodeId) continue;
    const child = nodes.get(childNodeId);
    const parent = nodes.get(parentNodeId);
    if (!child || !parent) continue;
    if (child.parentId === null) child.parentId = parentNodeId;
  }

  // Attach, then drop any cycle by refusing a parent that is a descendant.
  const roots: GraphNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent && !isDescendant(nodes, parent, node.id)) parent.children.push(node);
    else {
      node.parentId = null;
      roots.push(node);
    }
  }
  const byRecent = (a: GraphNode, b: GraphNode) => b.lastTs - a.lastTs || a.id.localeCompare(b.id);
  const sortDeep = (list: GraphNode[]) => {
    list.sort(byRecent);
    for (const node of list) sortDeep(node.children);
  };
  sortDeep(roots);
  return roots;
}

function isDescendant(nodes: Map<string, GraphNode>, start: GraphNode, target: string): boolean {
  let cursor: GraphNode | undefined = start;
  let guard = 0;
  while (cursor && guard++ < 64) {
    if (cursor.id === target) return true;
    cursor = cursor.parentId ? nodes.get(cursor.parentId) : undefined;
  }
  return false;
}

export function flattenTree(roots: GraphNode[]): GraphNode[] {
  const out: GraphNode[] = [];
  const walk = (list: GraphNode[]) => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(roots);
  return out;
}

// The rows a tree actually paints: a node always, its children only while the
// node's id is open. Same predicate marbler's own model uses, so a controlled
// tree and the timeline below it share one membership.
export function flattenExpandedTree(roots: GraphNode[], isOpen: (id: string) => boolean): GraphNode[] {
  const out: GraphNode[] = [];
  const walk = (list: GraphNode[]) => {
    for (const node of list) {
      out.push(node);
      if (node.children.length && isOpen(node.id)) walk(node.children);
    }
  };
  walk(roots);
  return out;
}

// The requested view: every live agent, no inactive row anywhere. An inactive
// ancestor is not painted as a placeholder; its live descendants hoist to the
// nearest live ancestor (or become roots), preserving stored ids and the
// visible parent edge. Collapsed by default, expansion then walks live
// children only.
export function activeOnlyTree(roots: GraphNode[]): GraphNode[] {
  const out: GraphNode[] = [];
  const liveStack: GraphNode[] = [];
  const visit = (node: GraphNode) => {
    const live = node.state === "live";
    if (live) {
      const visible: GraphNode = {
        ...node,
        parentId: liveStack.length ? liveStack[liveStack.length - 1].id : null,
        children: [],
      };
      const parent = liveStack[liveStack.length - 1];
      if (parent) parent.children.push(visible);
      else out.push(visible);
      liveStack.push(visible);
    }
    for (const child of node.children) visit(child);
    if (live) liveStack.pop();
  };
  for (const root of roots) visit(root);
  return out;
}

// Every node id under `rootId`, the root included.
export function subtreeIds(roots: GraphNode[], rootId: string): Set<string> {
  const ids = new Set<string>();
  const find = (list: GraphNode[]): GraphNode | null => {
    for (const node of list) {
      if (node.id === rootId) return node;
      const hit = find(node.children);
      if (hit) return hit;
    }
    return null;
  };
  const root = find(roots);
  if (!root) return ids;
  for (const node of flattenTree([root])) ids.add(node.id);
  return ids;
}
