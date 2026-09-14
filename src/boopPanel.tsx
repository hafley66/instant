// Boop rail panel: lane roster (master table) with the mail stream drawn by
// @hafley66/marbler; a lane is a line, a mail is a dot, filtered = disabled.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSignal } from "@hafley66/signals/react";
import { commandEndpoint, invoke } from "./generated/native";
import { TreeTable, type TreeColumn } from "./treetable";
import { settings } from "./0_settings";
import type { ExpandedState, SortingState } from "@tanstack/react-table";
import { createMarbler, MarblerPanel, reduceTimeViewport } from "@hafley66/marbler";
import { buildGraphTree, flattenTree, activeOnlyTree, flattenExpandedTree, type GraphNode, type SessionGraph } from "./0_boopGraph";
import { boopRosterState } from "./0_boopPanelState";
import {
  lanesOfNodes,
  laneStats,
  stampsOf,
  subtreeLanes,
  toMarbleEvents,
  type BoopLaneEvent,
  type LaneStat,
} from "./0_boopPresentation";
import "./1_boopPanel.css";

// Rows are graph nodes (lanes and sessions, nested) carrying the per-poll
// rollups; the column array stays module-stable because rebuilt columns reset
// tanstack's sort state, killing header clicks.
export interface BoopRow extends GraphNode {
  mailCount: number;
  endedTs: number;
  dots: LaneStat["dots"];
  windowRange: [number, number] | null;
  subRows: BoopRow[];
}

const BOOP_COLUMNS: TreeColumn<BoopRow>[] = [
  {
    id: "route",
    header: "agent",
    tree: true,
    sortValue: (r) => r.label,
    // The label is the human name; the full stored identity stays on hover.
    cell: (r) => <span title={r.id}>{r.label}</span>,
    cellClass: (r) => (r.state === "live" ? "boop-open" : "boop-closed"),
  },
  { id: "kind", header: "kind", sortValue: (r) => r.kind, cell: (r) => r.kind, size: 64 },
  { id: "state", header: "state", sortValue: (r) => r.state, cell: (r) => r.state, size: 56 },
  { id: "harness", header: "harness", sortValue: (r) => r.harness ?? "", cell: (r) => r.harness ?? "" },
  { id: "cwd", header: "cwd", sortValue: (r) => r.cwd ?? "", cell: (r) => (r.cwd ?? "").split("/").filter(Boolean).slice(-2).join("/") },
  {
    id: "mails",
    header: "mail",
    sortValue: (r) => r.mailCount,
    cell: (r) => String(r.mailCount),
    size: 52,
  },
  {
    id: "started",
    header: "started",
    sortValue: (r) => r.startedTs,
    cell: (r) => (r.startedTs ? fmtAgo(r.startedTs, Date.now()) : "—"),
    size: 84,
  },
  {
    id: "updated",
    header: "updated",
    sortValue: (r) => r.lastTs,
    cell: (r) => (r.lastTs ? fmtAgo(r.lastTs, Date.now()) : "—"),
    size: 84,
  },
  {
    id: "ended",
    header: "ended",
    sortValue: (r) => r.finishedTs || r.endedTs,
    cell: (r) => {
      const at = r.finishedTs || r.endedTs;
      return r.state === "live" || !at ? "—" : fmtAgo(at, Date.now());
    },
    size: 92,
  },
  {
    id: "waterfall",
    header: "waterfall",
    cell: (r) => {
      if (!r.dots.length || !r.windowRange) return <span className="muted">—</span>;
      const span = r.windowRange[1] - r.windowRange[0] || 1;
      return (
        <span className="boop-spark" title={`${r.mailCount} mail`}>
          {r.dots.map((dot) => (
            <i
              key={dot.id}
              className={dot.cls}
              style={{ left: `${((dot.t - r.windowRange![0]) / span) * 100}%` }}
            />
          ))}
        </span>
      );
    },
    size: 160,
    maxSize: 420,
  },
];

function fmtAgo(ts: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const BOOP_SORT: SortingState = [{ id: "updated", desc: true }];
// The graph read walks the process table and tmux, so it polls slower than
// the mail tail; a tick that lands mid-flight is dropped, never queued.
const GRAPH_POLL_MS = 3000;
const GRAPH_QUERY = commandEndpoint<SessionGraph>("boop_session_graph");

const POLL_MS = 1000;
// Full history on first paint; after that only the tail, merged in memory.
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function BoopPanelV2() {
  const sinceTs = useRef(Date.now() - LOOKBACK_MS);
  const graphQuery = useMemo(
    () => GRAPH_QUERY.createQuery({ historySinceMs: sinceTs.current }, { refetchInterval: GRAPH_POLL_MS }),
    [],
  );
  const graphState = useSignal(graphQuery.$);
  const graph = graphState.data ?? null;
  const [events, setEvents] = useState<BoopLaneEvent[]>([]);
  const onlyActive = useSignal(settings.boopOnlyActive.$);
  const roots = useMemo(() => (graph ? buildGraphTree(graph, sinceTs.current) : []), [graph]);
  // Active-only is a projection, not a root filter: a live agent under an
  // inactive ancestor hoists to its nearest live ancestor (or becomes a root),
  // so no inactive row is painted and no live agent is dropped.
  const visibleRoots = useMemo(() => (onlyActive ? activeOnlyTree(roots) : roots), [roots, onlyActive]);
  // All active nodes drive the mail rollups and the viewport domain; the
  // expansion-controlled subset drives the lower timeline's membership.
  const activeNodes = useMemo(() => flattenTree(visibleRoots), [visibleRoots]);
  // One controlled expansion for both panels: collapsing a roster row drops its
  // descendants from the timeline below too, so the timeline is not flooded by
  // rows the tree above has hidden.
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const isOpen = useCallback(
    (id: string) => expanded === true || Boolean(expanded[id]),
    [expanded],
  );
  const nodes = useMemo(() => flattenExpandedTree(visibleRoots, isOpen), [visibleRoots, isOpen]);
  // Every graph node, filtered or not: the roster's empty/loading decision must
  // key on what the graph knows, never on what the active filter left visible.
  const allNodeCount = useMemo(() => flattenTree(roots).length, [roots]);
  const lanes = useMemo(() => lanesOfNodes(nodes), [nodes]);
  const activeLanes = useMemo(() => lanesOfNodes(activeNodes), [activeNodes]);
  const [selected, setSelected] = useState<string | null>(null);
  const [invokeError, setInvokeError] = useState<string | null>(null);
  const lastTs = useRef(0);
  const marbler = useRef(createMarbler([]));

  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const since = lastTs.current === 0 ? Date.now() - LOOKBACK_MS : lastTs.current;
        const tail = await invoke<BoopLaneEvent[]>("boop_lane_events", { sinceMs: since });
        if (stopped) return;
        setInvokeError(null);
        if (tail.length) {
          lastTs.current = tail[tail.length - 1].ts + 1;
          setEvents((prior) => prior.concat(tail));
        }
      } catch (reason) {
        // Shown in the empty state; a silent catch here once read as
        // "no lanes" while the store was fine.
        if (!stopped) setInvokeError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);
  const storeError = invokeError ?? (graphState.isError
    ? (graphState.error instanceof Error ? graphState.error.message : String(graphState.error))
    : null);

  const rows = useMemo(() => toMarbleEvents(lanes, events), [lanes, events]);
  // Rollups and the domain span every active node, not just the expanded
  // subset, so collapsing a row never rescales the timeline or drops its mail.
  const allRows = useMemo(() => toMarbleEvents(activeLanes, events), [activeLanes, events]);
  const stats = useMemo(() => laneStats(allRows), [allRows]);
  const stamps = useMemo(() => stampsOf(allRows), [allRows]);
  const newest = Math.max(0, ...stamps);
  // Memoized: an unstable identity here fired the viewport effect on every
  // render and stomped in-flight navigator gestures.
  const windowRange = useMemo<[number, number] | null>(() => (stamps.length
    ? [Math.min(...stamps), Math.max(newest + POLL_MS, newest + 1)]
    : null), [stamps, newest]);

  // A selected root narrows the network view to its descendant subtree plus
  // mail peers. Click the row again to clear. Narrowing drills into the full
  // active subtree (a deliberate focus), while the unfiltered view shows only
  // the expansion-controlled rows so the timeline is not flooded.
  const shownRoot = selected && activeLanes.some((lane) => lane.route === selected) ? selected : null;
  const shown = useMemo(
    () => (shownRoot ? subtreeLanes(activeLanes, allRows, shownRoot) : rows),
    [shownRoot, activeLanes, allRows, rows],
  );

  useEffect(() => {
    marbler.current.source.$(shown);
    marbler.current.selectedId.$(shownRoot);
  }, [shown, shownRoot]);

  useEffect(() => {
    // Seeded-empty model starts with a degenerate range; while following,
    // chase the newest stamp. Value-equal writes are skipped.
    const vp = marbler.current.viewport.$();
    if (!windowRange) return;
    const fullSame = vp.full[0] === windowRange[0] && vp.full[1] === windowRange[1];
    if (vp.followLive) {
      // First paint has a degenerate seeded full; span the whole domain then.
      // Once full has settled, keep the user's span and chase the tail.
      const windowSpan = windowRange[1] - windowRange[0];
      const current = vp.visible[1] - vp.visible[0];
      const span = fullSame && current > 0 ? current : windowSpan;
      const visible: [number, number] = [
        Math.max(windowRange[0], windowRange[1] - span),
        windowRange[1],
      ];
      if (fullSame && vp.visible[0] === visible[0] && vp.visible[1] === visible[1]) return;
      marbler.current.viewport.$({ ...vp, full: windowRange, visible });
    } else if (!fullSame) {
      marbler.current.viewport.$({ ...vp, full: windowRange });
    }
  }, [shown, windowRange]);

  const toRow = (node: GraphNode): BoopRow => ({
    ...node,
    mailCount: stats.get(node.id)?.count ?? 0,
    endedTs: stats.get(node.id)?.endedTs ?? 0,
    dots: stats.get(node.id)?.dots ?? [],
    windowRange,
    subRows: node.children.map(toRow),
  });
  const data: BoopRow[] = useMemo(() => {
    return visibleRoots.map(toRow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRoots, stats, windowRange]);
  const hiddenByActive = onlyActive ? allNodeCount - activeNodes.length : 0;
  // Pending/errored/empty look identical to a person unless they are named
  // apart: a graph read still in flight reads as "no agents" otherwise.
  const roster = boopRosterState({
    laneCount: allNodeCount,
    shownCount: data.length,
    hiddenByActive,
    status: graphState.status,
    error: storeError,
  });
  const summaryAll = useMemo(() => {
    const open = activeLanes.filter((lane) => lane.state === "open").length;
    return [
      `${open} open · ${activeLanes.length - open} closed`,
      `${events.length} mail in window`,
    ];
  }, [activeLanes, events.length]);
  const summary = shownRoot
    ? [`showing ${shownRoot} + descendants`, `${shown.length} of ${rows.length} lanes`]
    : summaryAll;

  // Read-only viewport mirror for observability (tests and range display).
  // Viewport edits go through the marbler reducer exactly as its own gestures
  // do; follow and fit are the two states the navigator has no gesture for.
  const viewport = useSignal(marbler.current.viewport.$);
  const hovered = useSignal(marbler.current.hoveredId.$);
  const gesture = (g: Parameters<typeof reduceTimeViewport>[1]) => {
    marbler.current.viewport.$(reduceTimeViewport(marbler.current.viewport.$(), g));
  };

  return (
    <div className="v2-panel boop-panel">
      <div className="fs-list boop-master">
        <div className="boop-toolbar">
          <label className="boop-only-active">
            <input
              type="checkbox"
              checked={onlyActive}
              onChange={(e) => settings.boopOnlyActive.$(e.target.checked)}
            />
            active only
          </label>
          {hiddenByActive > 0 && (
            <span className="muted">{hiddenByActive} hidden by active-only</span>
          )}
        </div>
        {roster.kind === "rows" ? (
          <TreeTable<BoopRow>
            columns={BOOP_COLUMNS}
            data={data}
            getRowId={(r) => r.id}
            getSubRows={(r) => r.subRows}
            expanded={expanded}
            onExpandedChange={setExpanded}
            defaultSorting={BOOP_SORT}
            virtual
            rowClass={(r) => (r.id === selected ? "fs-selected" : undefined)}
            onRowClick={(r) => setSelected((prior) => (prior === r.id ? null : r.id))}
          />
        ) : (
          // No rows to show: render the state on its own, not under a tall
          // virtual table body that pushes the message below the fold.
          <div className="empty-help">
            {roster.kind === "loading" && (
              <>
                <h3>boop: reading the session graph…</h3>
                <p>Mail refreshes every second, the graph every three.</p>
              </>
            )}
            {roster.kind === "error" && (
              <>
                <h3>boop: store read failed</h3>
                <p className="act-warn">{roster.message}</p>
              </>
            )}
            {roster.kind === "hidden-by-active" && (
              <>
                <h3>
                  {roster.hidden} agent{roster.hidden === 1 ? "" : "s"} hidden by active-only
                </h3>
                <p>Turn off “active only” above to show finished and idle lanes.</p>
              </>
            )}
            {roster.kind === "empty" && (
              <>
                <h3>boop: no agents in the window</h3>
                <p>
                  Rows come from boop's session graph: every lane and harness
                  session active in the last 24 hours, nested by who spawned whom.
                  Mail refreshes every second, the graph every three.
                </p>
              </>
            )}
          </div>
        )}
      </div>
      <div
        className="boop-marbler"
        data-follow={viewport.followLive ? "1" : "0"}
        data-visible={`${Math.round(viewport.visible[0])}:${Math.round(viewport.visible[1])}`}
        data-lanes={shown.length}
        data-hovered={hovered ?? ""}
      >
        <div className="boop-timeline-controls">
          <span className="boop-tl-title">timeline</span>
          <button
            type="button"
            className={viewport.followLive ? "boop-tl-btn active" : "boop-tl-btn"}
            title="re-arm live tailing"
            onClick={() => gesture({ type: "follow", enabled: !viewport.followLive })}
          >
            {viewport.followLive ? "following" : "follow"}
          </button>
          <button type="button" className="boop-tl-btn" title="fit the whole window" onClick={() => gesture({ type: "fit" })}>
            fit
          </button>
          <span className="boop-tl-hint">drag to scrub · ctrl+wheel to zoom · dblclick fits</span>
          {stamps.length === 0 && <span className="muted">no mail in window</span>}
        </div>
        {shownRoot && (
          <button type="button" className="boop-narrow" onClick={() => setSelected(null)}>
            showing {shownRoot} + descendants ×
          </button>
        )}
        <MarblerPanel model={marbler.current} embedded summary={summary} navigatorMaxHeight={160} />
      </div>
    </div>
  );
}
