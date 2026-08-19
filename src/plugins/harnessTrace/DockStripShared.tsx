// Shared dock-strip presentation (CONTRACT2 + CONTRACT3): the AgentSessionNode
// tree's data path and table, factored out so the global bottom strip
// (DockStripPanel) and the per-terminal in-tab strip (InTabStrip) render the
// same columns and join logic from one source instead of drifting copy-paste.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { SortingState, ExpandedState } from "@tanstack/react-table";
import { invoke } from "../../generated/native";
import { claimFsWatch } from "../../fsWatch";
import { getHomeDir, relTime } from "../../core";
import { MAIL_DIR } from "./0_live";
import { TreeTable, type TreeColumn } from "../../treetable";
import { store } from "../../state";
import { enrichRows, registrySeeds, resolveRouteSessions, routeTmuxBySession, settleRoutedStatus, tmuxLiveNames } from "./0_mail";
import { loadMailLedger } from "./HarnessTracePanel";
import { buildAgentTree, toAgentNodes, type AgentTreeNode } from "./0_tree";
import { assignTmuxPanes, joinTmuxSessions } from "./2_join";
import type { HarnessTraceSeed, AgentSessionNode, MailRegistry, MailTokens } from "./0_types";
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
    id: "tokens",
    header: "tokens",
    cell: (r) => (
      <span className="s-meta" title={r.tokens ? `in ${r.tokens.in} @ ${r.tokens.at}` : "not swept"}>
        {r.tokens ? fmtTokens(r.tokens.in) : "-"}
      </span>
    ),
    sortValue: (r) => r.tokens?.in ?? -1,
  },
  {
    id: "harness",
    header: "harness",
    cell: (r) => <span className="s-proc">{r.harness}</span>,
    sortValue: (r) => r.harness,
  },
  {
    id: "model",
    header: "model",
    cell: (r) => <span className="s-meta" title={r.model ?? "not recorded"}>{r.model ?? "—"}</span>,
    sortValue: (r) => r.model ?? "",
  },
  {
    id: "provider",
    header: "provider",
    cell: (r) => <span className="s-meta" title={r.provider ?? "not recorded"}>{r.provider ?? "—"}</span>,
    sortValue: (r) => r.provider ?? "",
  },
  {
    id: "preset",
    header: "preset",
    cell: (r) => <span className="s-meta" title={r.preset ?? "not recorded"}>{r.preset ?? "—"}</span>,
    sortValue: (r) => r.preset ?? "",
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
    id: "started",
    header: "started",
    cell: (r) => <span title={r.ts}>{relTime(Date.parse(r.ts) || 0)}</span>,
    sortValue: (r) => r.ts,
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
    (r.model ?? "").toLowerCase().includes(s) ||
    (r.provider ?? "").toLowerCase().includes(s) ||
    (r.preset ?? "").toLowerCase().includes(s) ||
    r.id.toLowerCase().includes(s) ||
    r.from.toLowerCase().includes(s) ||
    r.why.toLowerCase().includes(s) ||
    (r.parentKind ?? "").includes(s) ||
    r.status.includes(s) ||
    r.cwd.toLowerCase().includes(s) ||
    (r.tmuxSession ?? "").includes(s)
  );
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

// The store tmux rows the strip joins against (same source TmuxPanelV2 reads).
// pwd = first pane path; chipPaths = the session's touched worktree paths.
function tmuxJoinRows(
  sessions: Session[],
  sessionWorktrees: Record<string, string[]>,
): { name: string; pwd: string; chipPaths: string[]; proc: string }[] {
  return sessions.map((s) => ({
    name: s.name,
    pwd: (s.paths ?? [])[0] ?? "",
    chipPaths: sessionWorktrees[s.name] ?? [],
    proc: (s.commands ?? [])[0] ?? "",
  }));
}

// Join each flat node to its tmux session: routes pin, then going sessions
// claim panes exclusively via assignTmuxPanes (bar count == distinct panes).
function attachTmux(
  nodes: AgentSessionNode[],
  routeTmux: Map<string, string>,
  rows: ReturnType<typeof tmuxJoinRows>,
): AgentSessionNode[] {
  const home = getHomeDir();
  const untilde = (p: string) => (p.startsWith("~") ? home + p.slice(1) : p);
  const assigned = assignTmuxPanes(
    nodes.map((n) => ({
      id: n.id,
      harness: n.harness,
      cwd: untilde(n.cwd),
      lastActivity: n.lastActivity,
      routedTmux: routeTmux.get(n.id) ?? null,
      going: n.status === "live" && n.parentKind !== "subagent",
    })),
    rows,
  );
  return nodes.map((n) => {
    const routed = routeTmux.get(n.id);
    return {
      ...n,
      tmuxSession: assigned.get(n.id) ?? null,
      tmuxMatches: routed !== undefined ? [routed] : joinTmuxSessions(untilde(n.cwd), rows),
    };
  });
}

// Single-owner live feed (stripfix law: never a per-terminal fs-watch). One
// mail-dir claim and one liveness poll serve every mounted strip and preview.
const LIVENESS_POLL_MS = 5_000;
const MAIL_DEBOUNCE_MS = 75;

export interface StripFeedListener {
  onMail: () => void;
  onLiveNames: (names: string[]) => void;
}

const feedListeners = new Set<StripFeedListener>();
let stopFeed: (() => void) | null = null;

function startFeed(): () => void {
  let releaseClaim: (() => void) | null = null;
  let claiming = false;
  let disposed = false;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const notifyMail = () => {
    clearTimeout(debounce);
    // A batch mail update is one reload, not one reload per line.
    debounce = setTimeout(() => {
      for (const listener of feedListeners) listener.onMail();
    }, MAIL_DEBOUNCE_MS);
  };
  const claimMailWatch = () => {
    if (disposed || claiming || releaseClaim) return;
    claiming = true;
    void invoke<{ entries: unknown[] }>("list_dir", { path: MAIL_DIR })
      .then(() => claimFsWatch(MAIL_DIR, notifyMail, false))
      .then((claim) => {
        claiming = false;
        if (disposed) claim();
        else releaseClaim = claim;
      })
      .catch(() => {
        claiming = false;
      });
  };
  claimMailWatch();
  // A lane's tmux dying is what grades it done (settleRoutedStatus) and no
  // event reports it; poll only the cheap liveness call, never the seed walk.
  const timer = window.setInterval(() => {
    claimMailWatch(); // heals a mail dir that did not exist at the first claim
    void invoke<Session[]>("list_sessions")
      .then((sessions) => {
        const names = tmuxLiveNames(sessions);
        if (names) for (const listener of feedListeners) listener.onLiveNames(names);
      })
      .catch(() => {});
  }, LIVENESS_POLL_MS);
  return () => {
    disposed = true;
    clearTimeout(debounce);
    window.clearInterval(timer);
    releaseClaim?.();
  };
}

export function claimStripFeed(listener: StripFeedListener): () => void {
  feedListeners.add(listener);
  if (feedListeners.size === 1) stopFeed = startFeed();
  return () => {
    feedListeners.delete(listener);
    if (feedListeners.size === 0) {
      stopFeed?.();
      stopFeed = null;
    }
  };
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

let traceSeeds: HarnessTraceSeed[] | null = null;
let traceSeedsRequest: Promise<HarnessTraceSeed[]> | null = null;

export function invalidateAgentTreeRows(): void {
  traceSeeds = null;
}

function loadTraceSeeds(refresh = false): Promise<HarnessTraceSeed[]> {
  if (refresh) traceSeeds = null;
  if (traceSeeds) return Promise.resolve(traceSeeds);
  if (traceSeedsRequest) return traceSeedsRequest;
  traceSeedsRequest = invoke<HarnessTraceSeed[]>("harness_trace_rows")
    .then((rows) => {
      traceSeeds = rows;
      return rows;
    })
    .finally(() => {
      traceSeedsRequest = null;
    });
  return traceSeedsRequest;
}

// The shared data path: rust rows + mail ledger -> frozen nodes -> tmux join ->
// tree. Every host shares the single-owner live feed through this hook;
// InTabStrip indexes the flat nodes into its own external-only tree.
export function useAgentTree(enabled = true): AgentTreeState {
  // Narrow store read: the join consumes sessions + sessionWorktrees only, so
  // unrelated store writes must not rebuild every node identity downstream.
  const sessions = useSyncExternalStore(
    useCallback((cb: () => void) => store.subscribe(cb, ["sessions"]), []),
    () => store.get().sessions,
  );
  const sessionWorktrees = useSyncExternalStore(
    useCallback((cb: () => void) => store.subscribe(cb, ["sessionWorktrees"]), []),
    () => store.get().sessionWorktrees,
  );
  const [flat, setFlat] = useState<AgentSessionNode[]>([]);
  const [registry, setRegistry] = useState<MailRegistry>({});
  const [routeTmux, setRouteTmux] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState("");
  // The tmux names list_sessions reported on the last load; null until one
  // answers, and on hosts that have no list to give (the e2e page), which is
  // when the store's seeded sessions stand in.
  const [liveNames, setLiveNames] = useState<string[] | null>(null);
  const loadRows = useCallback((refresh = false) => {
    if (!enabled) return;
    // The live tmux list is what grades a routed lane done (settleRoutedStatus),
    // so it is read WITH the rows: a lane spawned since boot is missing from the
    // store's list and would render done. Read straight through list_sessions —
    // refreshSessions is the tmux panel's own path and carries its worktree scan
    // and session-list DOM render, neither of which a strip load owes.
    Promise.all([
      invoke<Session[]>("list_sessions").catch(() => null),
      loadTraceSeeds(refresh),
    ])
      .then(async ([sessions, storeSeeds]) => {
        const names = tmuxLiveNames(sessions);
        // null = learned nothing; one transient failure must not downgrade
        // every routed lane to done (REVIEW-reactive finding 6).
        setLiveNames((prev) => names ?? prev);
        const mail = await loadMailLedger();
        const liveTmux = new Set(names ?? store.get().sessions.map((s) => s.name));
        // One agent, one row: an unresolved route folds onto the store session
        // sharing its harness+cwd instead of seeding a duplicate (m-17f56e54).
        const resolved = { ...resolveRouteSessions(mail.directory, storeSeeds, getHomeDir()), ...mail.registry };
        const seeds = [...storeSeeds, ...registrySeeds(mail.directory, storeSeeds, liveTmux, mail.envelopes, Date.now(), resolved)];
        // Token stamps ride the registry routes keyed by session id, so they
        // merge onto the flat rows after the seed walk (store-backed lanes too).
        const tokensBySession = new Map<string, MailTokens | null>();
        for (const agent of Object.values(mail.directory)) {
          const sid = agent.sessionId || resolved[agent.id] || agent.id;
          if (agent.tokens) tokensBySession.set(sid, agent.tokens);
        }
        const flatRows = enrichRows(seeds, mail.envelopes, resolved).map((r) => ({
          ...r,
          tokens: tokensBySession.get(r.sessionId) ?? null,
        }));
        setFlat(toAgentNodes(flatRows, mail.envelopes, resolved));
        setRegistry(resolved);
        setRouteTmux(routeTmuxBySession(mail.directory, resolved));
        setError("");
      })
      .catch((reason: unknown) => setError(String(reason)));
  }, [enabled]);
  const load = useCallback(() => loadRows(true), [loadRows]);
  useEffect(() => {
    if (!enabled) return;
    loadRows();
    return claimStripFeed({ onMail: () => loadRows(true), onLiveNames: setLiveNames });
  }, [enabled, loadRows]);
  // Memoized on honest deps: every consumer memo (external, index, spans, row
  // models) keys on node identity, so it must move only when the inputs move.
  const liveTmux = useMemo(
    () => new Set(liveNames ?? sessions.map((s) => s.name)),
    [liveNames, sessions],
  );
  const nodes = useMemo(
    () =>
      settleRoutedStatus(
        attachTmux(flat, routeTmux, tmuxJoinRows(sessions, sessionWorktrees)),
        routeTmux,
        liveTmux,
      ),
    [flat, routeTmux, sessions, sessionWorktrees, liveTmux],
  );
  const tree = useMemo(() => buildAgentTree(nodes), [nodes]);
  return { nodes, tree, liveTmux, registry, error, load };
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
