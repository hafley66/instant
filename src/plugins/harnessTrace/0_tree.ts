// Dock-strip tree shaping: pure functions that turn the flat seam+mail rows
// into the tree the strip renders. No fs, no invoke, so vitest covers them
// directly. Tree law (CONTRACT2): top-level = parentId null; children hang
// under their parent; an orphan child (parentId not in the set) is promoted to
// top-level, never dropped; dispatch children are attached from the mail ledger.
import type {
  AgentSessionNode,
  HarnessTraceRow,
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

// In-tab strip (CONTRACT3): keep only the roots whose tree contains at least one
// node joined to the given tmux session. The whole containing tree survives
// unchanged with its nesting (including unjoined children), never flattened; a
// root whose subtree has no matching node is dropped.
export function filterForestByTmux(roots: AgentTreeNode[], sid: string): AgentTreeNode[] {
  return roots.filter((root) => treeContainsTmux(root, sid));
}

function treeContainsTmux(root: AgentTreeNode, sid: string): boolean {
  if (root.tmuxSession === sid) return true;
  return root.children.some((child) => treeContainsTmux(child, sid));
}
