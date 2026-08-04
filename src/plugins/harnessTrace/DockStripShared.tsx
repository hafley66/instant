// Shared dock-strip presentation (CONTRACT2 + CONTRACT3): the AgentSessionNode
// tree's data path and table, factored out so the global bottom strip
// (DockStripPanel) and the per-terminal in-tab strip (InTabStrip) render the
// same columns and join logic from one source instead of drifting copy-paste.
import { useCallback, useEffect, useState } from "react";
import type { SortingState, ExpandedState } from "@tanstack/react-table";
import { invoke } from "../../generated/native";
import { getHomeDir, relTime } from "../../core";
import { TreeTable, type TreeColumn } from "../../treetable";
import { useApp } from "../../useStore";
import { store } from "../../state";
import { enrichRows, registrySeeds, routeTmuxBySession, settleRoutedStatus, tmuxLiveNames } from "./0_mail";
import { loadMailLedger } from "./HarnessTracePanel";
import { buildAgentTree, toAgentNodes, type AgentTreeNode } from "./0_tree";
import { joinTmuxSession, joinTmuxSessions } from "./2_join";
import type { HarnessTraceSeed, AgentSessionNode, MailRegistry } from "./0_types";
import type { Session } from "../../state";

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
    if (routed !== undefined) return { ...n, tmuxSession: routed, tmuxMatches: [routed] };
    const cwd = n.cwd.startsWith("~") ? home + n.cwd.slice(1) : n.cwd;
    return { ...n, tmuxSession: joinTmuxSession(cwd, rows), tmuxMatches: joinTmuxSessions(cwd, rows) };
  });
}

export interface AgentTreeState {
  // The tmux-joined flat node set, for hosts that index it themselves.
  nodes: AgentSessionNode[];
  tree: AgentTreeNode[];
  // The tmux names the last list_sessions reported; a row click checks it
  // (StripPolicy.openAction) before openSession may reach the bridge.
  liveTmux: Set<string>;
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
  // The tmux names list_sessions reported on the last load; null until one
  // answers, and on hosts that have no list to give (the e2e page), which is
  // when the store's seeded sessions stand in.
  const [liveNames, setLiveNames] = useState<string[] | null>(null);
  const load = useCallback(() => {
    // The live tmux list is what grades a routed lane done (settleRoutedStatus),
    // so it is read WITH the rows: a lane spawned since boot is missing from the
    // store's list and would render done. Read straight through list_sessions —
    // refreshSessions is the tmux panel's own path and carries its worktree scan
    // and session-list DOM render, neither of which a strip load owes.
    Promise.all([
      invoke<Session[]>("list_sessions").catch(() => null),
      invoke<HarnessTraceSeed[]>("harness_trace_rows"),
    ])
      .then(async ([sessions, storeSeeds]) => {
        const names = tmuxLiveNames(sessions);
        setLiveNames(names);
        const mail = await loadMailLedger();
        const liveTmux = new Set(names ?? store.get().sessions.map((s) => s.name));
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
  const liveTmux = new Set(liveNames ?? store.get().sessions.map((s) => s.name));
  const nodes = settleRoutedStatus(attachTmux(flat, routeTmux), routeTmux, liveTmux);
  return { nodes, tree: buildAgentTree(nodes), liveTmux, registry, error, load };
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
