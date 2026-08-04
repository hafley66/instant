// Dock-strip tree shaping: pure functions that turn the flat seam+mail rows
// into the tree the strip renders. No fs, no invoke, so vitest covers them
// directly. Tree law (CONTRACT2): top-level = parentId null; children hang
// under their parent; an orphan child (parentId not in the set) is promoted to
// top-level, never dropped; dispatch children are attached from the mail ledger.
import type {
  AgentSessionNode,
  HarnessTraceRow,
  IAgentTreeIndex,
  MailEnvelope,
  MailRegistry,
} from "./0_types";

export interface AgentTreeNode extends AgentSessionNode {
  children: AgentTreeNode[];
}

// Map the flat panel rows into the frozen model. The strip keys on the session
// id (frozen `id: session id`), carries the rust parent linkage, and keeps the
// from/why the flat join already attached. Dispatch parents (cross-harness:
// parentKind "dispatch") are then resolved from the mail ledger.
export function toAgentNodes(
  rows: HarnessTraceRow[],
  envelopes: MailEnvelope[],
  registry: MailRegistry,
): AgentSessionNode[] {
  const nodes = rows.map((r) => ({
    id: r.sessionId,
    harness: r.harness,
    parentId: r.parentId ?? null,
    parentKind: r.parentKind ?? null,
    from: r.from,
    why: r.why,
    ts: r.ts,
    lastActivity: r.lastActivity,
    status: r.status,
    cwd: r.cwd,
    // The tmux join happens on the panel (it reads the store); trees leave it
    // null so the pure shaping fns keep no store dependency.
    tmuxSession: null,
    tmuxMatches: [],
  }));
  return resolveDispatchParents(nodes, envelopes, registry);
}

// Attach a "dispatch" parent to a cross-harness session: the envelope that
// dispatched it (to -> session id via the registry) has a `from` whose session
// id the registry maps; when that sender is itself a live node, it becomes the
// parent. Unresolvable senders stay top-level (parentId stays null).
export function resolveDispatchParents(
  nodes: AgentSessionNode[],
  envelopes: MailEnvelope[],
  registry: MailRegistry,
): AgentSessionNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  const bySession = new Map<string, MailEnvelope>();
  const oldestFirst = [...envelopes].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const envelope of oldestFirst) {
    const target = registry[envelope.to] ?? envelope.to;
    if (!bySession.has(target)) bySession.set(target, envelope);
  }
  return nodes.map((node) => {
    if (node.parentId !== null || node.parentKind !== null) return node;
    const envelope = bySession.get(node.id);
    if (!envelope) return node;
    const senderId = registry[envelope.from];
    if (senderId && ids.has(senderId)) {
      return { ...node, parentId: senderId, parentKind: "dispatch" };
    }
    return node;
  });
}

// Topological sort into roots + children for the TreeTable's getSubRows. Nodes
// with parentId null are roots; others hang under their parent by id. A child
// whose parent is absent (deleted session, race) is promoted to a root rather
// than dropped, so the session always survives somewhere in the tree.
export function buildAgentTree(nodes: AgentSessionNode[]): AgentTreeNode[] {
  const byId = new Map<string, AgentTreeNode>();
  for (const node of nodes) byId.set(node.id, { ...node, children: [] });
  const roots: AgentTreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId === null) {
      roots.push(node);
      continue;
    }
    const parent = byId.get(node.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

// Adjacency for the lazy path: same roots/orphan-promotion law as
// buildAgentTree, but children stay unbuilt until materializeAgentTree asks for
// an expanded branch. Insertion order within a parent is the caller's order.
export function indexAgentTree(nodes: AgentSessionNode[]): IAgentTreeIndex {
  const ids = new Set(nodes.map((n) => n.id));
  const byParent = new Map<string, AgentSessionNode[]>();
  const roots: AgentSessionNode[] = [];
  for (const node of nodes) {
    if (node.parentId === null || !ids.has(node.parentId)) {
      roots.push(node);
      continue;
    }
    const siblings = byParent.get(node.parentId);
    if (siblings) siblings.push(node);
    else byParent.set(node.parentId, [node]);
  }
  return {
    roots,
    childrenOf: (id) => byParent.get(id) ?? [],
    hasChildren: (id) => byParent.has(id),
    size: nodes.length,
  };
}

// Build the AgentTreeNode forest for the currently expanded ids only. A
// collapsed node gets `children: []`; its twisty comes from hasChildren, so the
// row model stays roots-sized until a branch opens. A cycle in the parent links
// (never emitted by the readers, cheap to survive) stops at the repeated id.
export function materializeAgentTree(
  index: IAgentTreeIndex,
  expanded: Record<string, boolean>,
): AgentTreeNode[] {
  const open = (nodes: AgentSessionNode[], seen: Set<string>): AgentTreeNode[] =>
    nodes.map((node) => {
      if (!expanded[node.id] || seen.has(node.id)) return { ...node, children: [] };
      const next = new Set(seen).add(node.id);
      return { ...node, children: open(index.childrenOf(node.id), next) };
    });
  return open(index.roots, new Set());
}

// In-tab strip (CONTRACT3): keep only the roots whose tree contains at least one
// node joined to the given tmux session. The whole containing tree survives
// unchanged with its nesting (including unjoined children), never flattened; a
// root whose subtree has no matching node is dropped.
export function filterForestByTmux(roots: AgentTreeNode[], sid: string): AgentTreeNode[] {
  return roots.filter((root) => treeContainsTmux(root, sid));
}

function treeContainsTmux(root: AgentTreeNode, sid: string): boolean {
  if ((root.tmuxMatches ?? []).includes(sid)) return true;
  return root.children.some((child) => treeContainsTmux(child, sid));
}
