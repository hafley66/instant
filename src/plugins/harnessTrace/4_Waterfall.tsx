// The session history waterfall (history mode of the in-tab strip): a d3-brush
// overview on top, one bar per session below with a tick per message, and the
// TreeTable reusing COLUMNS constrained to the brushed range. The d3 brush is
// isolated in the BrushOverview host; every pure projection lives in
// 0_waterfall.ts and is unit-tested.
//
// Three separate bounds keep this linear in what is on screen rather than in
// how much history exists: the opening range covers DEFAULT_SESSION_LIMIT
// sessions, the lanes are virtualized so only the scroller's window renders,
// and each lane's ticks are collapsed to one per pixel column. The per-session
// message read is driven off the same window, so history size never sets the
// number of concurrent IPC calls.
import { useEffect, useMemo, useRef, useState } from "react";
import { scaleUtc } from "d3-scale";
import { brushX } from "d3-brush";
import { select } from "d3-selection";
import { useVirtualizer } from "@tanstack/react-virtual";
import { getHomeDir } from "../../core";
import { harnessAdapter, type HarnessId } from "../../harness";
import { TreeTable } from "../../treetable";
import { COLUMNS } from "./DockStripShared";
import {
  binSpans,
  binsPath,
  decimateTicks,
  defaultRange,
  domainOf,
  sessionSpans,
  tickFrom,
  ticksInRange,
  visibleSessionIds,
} from "./0_waterfall";
import type { AgentSessionNode } from "./0_types";
import type { AgentTreeNode } from "./0_tree";
import type { AiMessage } from "../../state";
import type { ISessionTick, ISessionSpan, IWaterfallDomain, IWaterfallRange, TickType } from "./0_types";

export interface WaterfallProps {
  // Full in-scope node set: history, not just the going-on subset.
  nodes: AgentSessionNode[];
  // Clock, injected for deterministic tests.
  nowMs: number;
  // Row click: openSession + push the agent-session view.
  onOpen: (sessionId: string) => void;
  onLayout: () => void;
}

const ROW_H = 18;
const BRUSH_H = 42;
const LABEL_W = 76;
const DEFAULT_W = 640;
// The lane scroller's height. The strip caps at 240px total, so the plot takes
// six lanes and leaves the table below room to be worth reading.
const LANES_H = ROW_H * 6;
const LANE_OVERSCAN = 3;
// Callers pass a live clock, so quantize before it reaches the span/domain math:
// an unrounded Date.now() gives every render a new domain, which rebuilds the
// brush and re-runs every memo below it.
const CLOCK_STEP_MS = 60_000;

const TYPE_FILL: Record<TickType, string> = {
  user: "#3b82f6",
  assistant: "#22c55e",
  tool: "#f59e0b",
  reasoning: "#a855f7",
  dispatch: "#ef4444",
};

const ADAPTER_HARNESSES = new Set<HarnessId>(["claude", "opencode", "codex", "kimi"]);

function clampRange(range: IWaterfallRange, domain: IWaterfallDomain): IWaterfallRange {
  return { start: Math.max(domain.start, range.start), end: Math.min(domain.end, range.end) };
}

// The brush overview: one host component owns the imperative d3-brush instance
// so the interaction stays in a single place and the pure math stays unit-tested.
// The session density behind the brush is drawn as OVERVIEW_BINS columns, never
// one rect per session.
function BrushOverview(props: {
  domain: IWaterfallDomain;
  spans: ISessionSpan[];
  plotW: number;
  range: IWaterfallRange;
  // null = the user cleared the brush, so the caller falls back to the default.
  onRange: (r: IWaterfallRange | null) => void;
}) {
  const { domain, spans, plotW, range, onRange } = props;
  const gRef = useRef<SVGGElement>(null);
  const onRangeRef = useRef(onRange);
  onRangeRef.current = onRange;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const x = useMemo(() => scaleUtc().domain([domain.start, domain.end]).range([0, plotW]), [domain, plotW]);

  const density = useMemo(
    () => binsPath(binSpans(spans, domain), plotW, BRUSH_H - 16),
    [spans, domain, plotW],
  );

  useEffect(() => {
    const g = gRef.current;
    if (!g) return;
    g.textContent = "";
    const brush = brushX()
      .extent([[0, 0], [plotW, BRUSH_H]])
      .handleSize(8)
      .on("brush end", (event) => {
        // A programmatic move carries no sourceEvent. Only a human gesture may
        // pin the range; without this the placement below would immediately
        // read back as a user selection and freeze the default.
        if (!event.sourceEvent) return;
        const sel = event.selection as [number, number] | null | undefined;
        if (!sel) {
          onRangeRef.current(null);
          return;
        }
        const lo = Math.min(sel[0], sel[1]);
        const hi = Math.max(sel[0], sel[1]);
        onRangeRef.current({ start: x.invert(lo).getTime(), end: x.invert(hi).getTime() });
      });
    const sel = select(g);
    sel.call(brush);
    // Place the handles on whatever range is current, so a rescale (resize, or
    // new history widening the domain) keeps showing the same window.
    const lo = Math.max(0, Math.min(plotW, x(rangeRef.current.start)));
    const hi = Math.max(lo + 1, Math.min(plotW, x(rangeRef.current.end)));
    sel.call(brush.move, [lo, hi]);
  }, [x, plotW]);

  return (
    <svg className="waterfall-overview" width={plotW + LABEL_W} height={BRUSH_H} role="img" aria-label="waterfall brush">
      <path className="waterfall-mini" transform={`translate(${LABEL_W},2)`} d={density} fill="#4b5563" opacity={0.55} />
      <g transform={`translate(${LABEL_W},0)`} ref={gRef} />
    </svg>
  );
}

export function Waterfall({ nodes, nowMs, onOpen, onLayout }: WaterfallProps) {
  const clock = Math.floor(nowMs / CLOCK_STEP_MS) * CLOCK_STEP_MS;
  const spans = useMemo(() => sessionSpans(nodes, clock), [nodes, clock]);
  const spanById = useMemo(() => new Map(spans.map((s) => [s.id, s])), [spans]);

  // Domain and range are rebuilt from a churning `nodes` identity, so both are
  // re-wrapped on their numeric values: an unchanged window must not hand the
  // brush effect and the fetch effect a fresh object every render.
  const rawDomain = useMemo(() => domainOf(spans, clock), [spans, clock]);
  const domain = useMemo(
    () => ({ start: rawDomain.start, end: rawDomain.end }),
    [rawDomain.start, rawDomain.end],
  );

  // null until the user brushes: the opening window then keeps tracking the
  // newest sessions as history loads in, instead of freezing on the empty
  // domain the first render saw.
  const [brushed, setBrushed] = useState<IWaterfallRange | null>(null);
  const rawRange = useMemo(
    () => (brushed ? clampRange(brushed, domain) : defaultRange(spans, domain)),
    [brushed, domain, spans],
  );
  const range = useMemo(
    () => ({ start: rawRange.start, end: rawRange.end }),
    [rawRange.start, rawRange.end],
  );

  const [width, setWidth] = useState(DEFAULT_W);
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = Math.max(1, width - LABEL_W);
  const x = useMemo(() => scaleUtc().domain([range.start, range.end]).range([0, plotW]), [range, plotW]);

  const visible = useMemo(() => visibleSessionIds(spans, range), [spans, range]);

  const rows: AgentTreeNode[] = useMemo(
    () =>
      nodes
        .filter((n) => visible.has(n.id))
        .map((n) => ({ ...n, children: [] }))
        .sort((a, b) => (spanById.get(b.id)?.start ?? 0) - (spanById.get(a.id)?.start ?? 0)),
    [nodes, visible, spanById],
  );

  // Lane windowing. Only the scroller's slice of `rows` reaches the SVG, so the
  // bar/label/tick node count is set by LANES_H and never by rows.length.
  const lanesRef = useRef<HTMLDivElement>(null);
  const laneVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => lanesRef.current,
    estimateSize: () => ROW_H,
    overscan: LANE_OVERSCAN,
  });
  const laneItems = laneVirtualizer.getVirtualItems();
  const lanesH = laneVirtualizer.getTotalSize();

  // Lazy per-session message cache: filled for the lanes the scroller is
  // actually showing, never for every session in range and never all history up
  // front. Held in refs so history mode owns them and releases them on unmount.
  // `loading` guards against duplicate IPC for in-flight reads; reads are never
  // invalidated by re-renders (the parent's nodes array churns identity), they
  // land and populate the cache.
  const cache = useRef(new Map<string, ISessionTick[]>());
  const loading = useRef(new Set<string>());
  // The node.lastActivity seen when each session's messages were last fetched,
  // so a live session refetches when a refresh brings newer activity, and only
  // then (render churn with unchanged data triggers no re-read).
  const fetchedActivity = useRef(new Map<string, string>());
  const alive = useRef(true);
  const [, bump] = useState(0);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // The window's id list, as a value the effect can depend on: laneItems is a
  // fresh array every render, so the ids are joined into a key instead.
  const windowIds = laneItems.map((item) => rows[item.index]?.id).filter((id): id is string => !!id);
  const windowKey = windowIds.join(",");
  useEffect(() => {
    for (const id of windowKey ? windowKey.split(",") : []) {
      if (loading.current.has(id)) continue;
      const node = nodesRef.current.find((n) => n.id === id);
      if (!node || !ADAPTER_HARNESSES.has(node.harness as HarnessId)) {
        cache.current.set(id, []);
        continue;
      }
      const cached = cache.current.get(id);
      const lastFetched = fetchedActivity.current.get(id);
      // Fetch when never loaded, or a live session's activity advanced.
      const stale = cached === undefined || (node.status === "live" && lastFetched !== node.lastActivity);
      if (!stale) continue;
      loading.current.add(id);
      const cwd = node.cwd.startsWith("~") ? getHomeDir() + node.cwd.slice(1) : node.cwd;
      harnessAdapter(node.harness as HarnessId)
        .read(node.id, cwd)
        .then((msgs: AiMessage[]) => {
          cache.current.set(id, msgs.map(tickFrom));
          fetchedActivity.current.set(id, node.lastActivity);
          loading.current.delete(id);
          if (alive.current) bump((v) => v + 1);
        })
        .catch(() => {
          cache.current.set(id, []);
          fetchedActivity.current.set(id, node.lastActivity);
          loading.current.delete(id);
          if (alive.current) bump((v) => v + 1);
        });
    }
  }, [windowKey]);

  // Refit the term slot when the brush changes the visible row set.
  const lastRangeRef = useRef(range);
  useEffect(() => {
    if (lastRangeRef.current.start !== range.start || lastRangeRef.current.end !== range.end) {
      lastRangeRef.current = range;
      onLayout();
    }
  }, [range, onLayout]);

  if (!rows.length) {
    return (
      <div className="waterfall" data-testid="waterfall" ref={hostRef}>
        <div className="strip-empty">no sessions in range</div>
        <style>{STYLE}</style>
      </div>
    );
  }

  return (
    <div className="waterfall" data-testid="waterfall" ref={hostRef}>
      <style>{STYLE}</style>
      <div className="waterfall-head">
        <span data-testid="waterfall-count">
          {rows.length} session{rows.length === 1 ? "" : "s"}
        </span>
        <span className="spy-spacer" />
        <span className="waterfall-clock">{new Date(nowMs).toLocaleTimeString()}</span>
      </div>
      <BrushOverview domain={domain} spans={spans} plotW={plotW} range={range} onRange={setBrushed} />
      <div className="waterfall-lanes" ref={lanesRef}>
        <svg
          className="waterfall-plot"
          width={width}
          height={Math.max(1, lanesH)}
          role="img"
          aria-label="session watermark plot"
        >
          {laneItems.map((item) => {
            const n = rows[item.index];
            const s = n && spanById.get(n.id);
            if (!n || !s) return null;
            const y = item.start + 2;
            const lx = x(s.start);
            const w = Math.max(1, x(s.end) - x(s.start));
            const ticks = decimateTicks(ticksInRange(cache.current.get(n.id) ?? [], range), range, plotW);
            return (
              <g key={n.id} className="waterfall-row" transform={`translate(${LABEL_W},0)`} data-title={n.id}>
                <rect className="waterfall-bar" x={lx} y={y} width={w} height={ROW_H - 4} rx={2} />
                {ticks.map((t, ti) => (
                  <circle
                    key={ti}
                    className="waterfall-tick"
                    cx={x(t.ts)}
                    cy={y + (ROW_H - 4) / 2}
                    r={3}
                    fill={TYPE_FILL[t.type]}
                  >
                    <title>{`${t.type} ${new Date(t.ts).toISOString()}`}</title>
                  </circle>
                ))}
                <text className="waterfall-id" x={-LABEL_W + 4} y={y + 12}>
                  {n.id}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <TreeTable<AgentTreeNode>
        columns={COLUMNS}
        data={rows}
        getRowId={(r) => r.id}
        virtual
        searchPlaceholder="filter sessions…"
        rowTitle={(r) => r.why || r.cwd}
        rowClass={(r) => (r.tmuxSession ? "dock-strip-row" : "dock-strip-row unjoined")}
        onRowClick={(r) => onOpen(r.id)}
      />
    </div>
  );
}

const STYLE = [
  ".waterfall{display:flex;flex-direction:column;min-height:0}",
  ".waterfall-head{display:flex;align-items:center;gap:8px;padding:2px 8px}",
  ".waterfall-clock{font-size:10px;opacity:.7}",
  ".waterfall-overview{display:block;background:var(--panel-bg)}",
  ".waterfall-overview .selection,.waterfall-overview .handle{stroke:var(--frame)}",
  `.waterfall-lanes{flex:none;max-height:${LANES_H}px;overflow-y:auto;overflow-x:hidden}`,
  ".waterfall-plot{display:block;background:var(--panel-bg)}",
  ".waterfall-plot .waterfall-bar{fill:var(--waterfall-bar,#2a2f3a);stroke:var(--frame)}",
  ".waterfall-plot .waterfall-id{font-size:10px;fill:var(--panel-fg)}",
  ".waterfall-plot .waterfall-tick{stroke:#fff;stroke-width:.5}",
  "svg.waterfall-overview g.brush rect.overlay{cursor:crosshair}",
].join("");
