// Shared dock-strip presentation (CONTRACT2 + CONTRACT3): the AgentSessionNode
// tree's data path and table, factored out so the global bottom strip
// (DockStripPanel) and the per-terminal in-tab strip (InTabStrip) render the
// same columns and join logic from one source instead of drifting copy-paste.
import { useCallback, useEffect, useState } from "react";
import type { SortingState, ExpandedState } from "@tanstack/react-table";
import { invoke } from "../../generated/native";
import { claimFsWatch } from "../../fsWatch";
import { getHomeDir, relTime } from "../../core";
import { MAIL_DIR } from "./0_live";
import { TreeTable, type TreeColumn } from "../../treetable";
import { useApp } from "../../useStore";
import { store } from "../../state";
import { enrichRows, registrySeeds, routeTmuxBySession, settleRoutedStatus } from "./0_mail";
import { loadMailLedger } from "./HarnessTracePanel";
import { refreshSessions } from "../../worktrees";
import { buildAgentTree, toAgentNodes, type AgentTreeNode } from "./0_tree";
import { joinTmuxSession } from "./2_join";
import type { HarnessTraceSeed, AgentSessionNode, MailRegistry } from "./0_types";
import type { DirListing } from "../../state";

export const COLUMNS: TreeColumn<AgentTreeNode>[] = [
  {
    id: "session",
    header: "session",
    tree: true,
    cell: (r) => (
      <span className="s-name" title={r.id}>
        {r.id}
      </span>
    ),
    sortValue: (r) => r.id,
  },
  {
    id: "dot",
    header: "",
    cell: (r) => <span className={"dot" + (r.status === "live" ? " on" : "")} />,
  },
  {
    id: "harness",
    header: "harness",
    cell: (r) => <span className="s-proc">{r.harness}</span>,
    sortValue: (r) => r.harness,
  },
  {
    id: "link",
    header: "link",
    cell: (r) => <span className="s-meta">{r.parentKind ?? "—"}</span>,
    sortValue: (r) => r.parentKind ?? "",
  },
  {
    id: "from",
    header: "from",
    cell: (r) => r.from,
    sortValue: (r) => r.from,
  },
  {
    id: "why",
    header: "why",
    cell: (r) => (r.why ? <span title={r.why}>{r.why}</span> : null),
    sortValue: (r) => r.why,
  },
  {
    id: "status",
    header: "status",
    cell: (r) => <span className="s-meta">{r.status}</span>,
    sortValue: (r) => r.status,
  },
  {
    id: "last",
    header: "activity",
    cell: (r) => <span title={r.lastActivity}>{relTime(Date.parse(r.lastActivity) || 0)}</span>,
    sortValue: (r) => r.lastActivity,
  },
  {
    id: "cwd",
    header: "cwd",
    cell: (r) =>
      r.cwd ? (
        <span className="s-pwd" title={r.cwd}>
          {r.cwd}
        </span>
      ) : null,
    sortValue: (r) => r.cwd,
  },
  {
    id: "tmux",
    header: "tmux",
    cell: (r) =>
      r.tmuxSession ? (
        <span className="s-meta" title={`open ${r.tmuxSession}`}>
          {r.tmuxSession}
        </span>
      ) : (
        <span className="s-meta strip-unjoined">—</span>
      ),
    sortValue: (r) => r.tmuxSession ?? "",
  },
];

export function stripFilter(r: AgentTreeNode, q: string): boolean {
  const s = q.toLowerCase();
  return (
    r.harness.includes(s) ||
    r.id.toLowerCase().includes(s) ||
    r.from.toLowerCase().includes(s) ||
    r.why.toLowerCase().includes(s) ||
    (r.parentKind ?? "").includes(s) ||
    r.status.includes(s) ||
    r.cwd.toLowerCase().includes(s) ||
    (r.tmuxSession ?? "").includes(s)
  );
}

// The store tmux rows the strip joins against (same source TmuxPanelV2 reads).
// pwd = first pane path; chipPaths = the session's touched worktree paths.
function tmuxJoinRows(): { name: string; pwd: string; chipPaths: string[]; proc: string }[] {
  const sw = store.get().sessionWorktrees;
  return store.get().sessions.map((s) => ({
    name: s.name,
    pwd: (s.paths ?? [])[0] ?? "",
    chipPaths: sw[s.name] ?? [],
    proc: (s.commands ?? [])[0] ?? "",
  }));
}

// Join each flat node to its tmux session: a registry route's recorded tmux
// name wins (the cwd guess cannot tell apart sessions sharing a directory),
// else untildify and match. Derived in render so a store change re-joins
// without a reload.
function attachTmux(nodes: AgentSessionNode[], routeTmux: Map<string, string>): AgentSessionNode[] {
  const rows = tmuxJoinRows();
  const home = getHomeDir();
  return nodes.map((n) => {
    const routed = routeTmux.get(n.id);
    if (routed !== undefined) return { ...n, tmuxSession: routed };
    const cwd = n.cwd.startsWith("~") ? home + n.cwd.slice(1) : n.cwd;
    return { ...n, tmuxSession: joinTmuxSession(cwd, rows) };
  });
}

export interface AgentTreeState {
  // The tmux-joined flat node set, for hosts that index it themselves.
  nodes: AgentSessionNode[];
  tree: AgentTreeNode[];
  // Mail agent name -> session id, for row actions that address the mailbox.
  registry: MailRegistry;
  error: string;
  load: () => void;
}

// The shared data path: rust rows + mail ledger -> frozen nodes -> tmux join ->
// tree. Both strips call this; DocStripPanel adds a mail fs-watch live leg on
// top and InTabStrip indexes the flat nodes into its own external-only tree.
export function useAgentTree(): AgentTreeState {
  useApp();
  const [flat, setFlat] = useState<AgentSessionNode[]>([]);
  const [registry, setRegistry] = useState<MailRegistry>({});
  const [routeTmux, setRouteTmux] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState("");
  const load = useCallback(() => {
    // The tmux list is the done-signal input (settleRoutedStatus); refresh it
    // alongside the rows or a lane spawned since boot settles as done. Swallow
    // failures: hosts without a real list_sessions (the e2e page) stay on the
    // seeded store list.
    void refreshSessions().catch(() => {});
    invoke<HarnessTraceSeed[]>("harness_trace_rows")
      .then(async (storeSeeds) => {
        const mail = await loadMailLedger();
        const liveTmux = new Set(store.get().sessions.map((s) => s.name));
        const seeds = [...storeSeeds, ...registrySeeds(mail.directory, storeSeeds, liveTmux)];
        const flatRows = enrichRows(seeds, mail.envelopes, mail.registry);
        setFlat(toAgentNodes(flatRows, mail.envelopes, mail.registry));
        setRegistry(mail.registry);
        setRouteTmux(routeTmuxBySession(mail.directory));
        setError("");
      })
      .catch((reason: unknown) => setError(String(reason)));
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  // Live leg (HarnessTracePanel precedent): a dispatch writes the mail dir,
  // so the strip re-reads without waiting for its refresh button; the watch
  // claims only when the dir exists and releases on unmount.
  useEffect(() => {
    let release: (() => void) | null = null;
    let disposed = false;
    void invoke<DirListing>("list_dir", { path: MAIL_DIR })
      .then(() => claimFsWatch(MAIL_DIR, () => load(), false))
      .then((releaseClaim) => {
        if (disposed) releaseClaim();
        else release = releaseClaim;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      release?.();
    };
  }, [load]);
  const liveTmux = new Set(store.get().sessions.map((s) => s.name));
  const nodes = settleRoutedStatus(attachTmux(flat, routeTmux), routeTmux, liveTmux);
  return { nodes, tree: buildAgentTree(nodes), registry, error, load };
}

export interface AgentStripTableProps {
  tree: AgentTreeNode[];
  error: string;
  onRowClick: (r: AgentTreeNode) => void;
  sorting?: SortingState;
  onSortingChange?: (s: SortingState) => void;
  defaultExpanded?: ExpandedState;
  virtual?: boolean;
  controls?: boolean;
}

// The shared table: the same columns/data config for both strips, with the host
// providing its own chrome (header bar) around it. `virtual` is off for the
// auto-height, capped in-tab strip and on for the fixed-height dock strip.
export function AgentStripTable(props: AgentStripTableProps) {
  if (props.error) return <div className="session-empty">{props.error}</div>;
  return (
    <TreeTable<AgentTreeNode>
      columns={COLUMNS}
      data={props.tree}
      getSubRows={(r) => r.children}
      getRowId={(r) => r.id}
      virtual={props.virtual}
      sorting={props.sorting}
      onSortingChange={props.onSortingChange}
      controls={props.controls}
      defaultExpanded={props.defaultExpanded ?? {}}
      filter={stripFilter}
      searchPlaceholder="filter sessions…"
      rowTitle={(r) => r.why || r.cwd}
      rowClass={(r) => (r.tmuxSession ? "dock-strip-row" : "dock-strip-row unjoined")}
      onRowClick={props.onRowClick}
    />
  );
}
