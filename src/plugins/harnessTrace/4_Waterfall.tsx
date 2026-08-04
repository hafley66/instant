// The session history waterfall (history mode of the in-tab strip): a d3-brush
// overview on top, one bar per session below with a tick per message, and the
// TreeTable reusing COLUMNS constrained to the brushed range. The d3 brush is
// isolated in the BrushOverview host; every pure projection lives in
// 0_waterfall.ts and is unit-tested.
import { useEffect, useMemo, useRef, useState } from "react";
import { scaleUtc } from "d3-scale";
import { brushX } from "d3-brush";
import { select } from "d3-selection";
import { getHomeDir } from "../../core";
import { harnessAdapter, type HarnessId } from "../../harness";
import { TreeTable } from "../../treetable";
import { COLUMNS } from "./DockStripShared";
import { sessionSpans, tickFrom, ticksInRange, visibleSessionIds, defaultRange, domainOf } from "./0_waterfall";
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
function BrushOverview(props: {
  domain: IWaterfallDomain;
  spans: ISessionSpan[];
  plotW: number;
  onRange: (r: IWaterfallRange) => void;
}) {
  const { domain, spans, plotW, onRange } = props;
  const gRef = useRef<SVGGElement>(null);
  const onRangeRef = useRef(onRange);
  onRangeRef.current = onRange;
  const x = useMemo(() => scaleUtc().domain([domain.start, domain.end]).range([0, plotW]), [domain, plotW]);

  useEffect(() => {
    const g = gRef.current;
    if (!g) return;
    g.textContent = "";
    const brush = brushX()
      .extent([[0, 0], [plotW, BRUSH_H]])
      .handleSize(8)
      .on("brush end", (event) => {
        const sel = event.selection as [number, number] | null | undefined;
        if (!sel) {
          onRangeRef.current(defaultRange(domain));
          return;
        }
        const lo = Math.min(sel[0], sel[1]);
        const hi = Math.max(sel[0], sel[1]);
        onRangeRef.current({ start: x.invert(lo).getTime(), end: x.invert(hi).getTime() });
      });
    const sel = select(g);
    sel.call(brush);
    // Default selection = the whole domain (history mode opens to everything).
    sel.call(brush.move, [0, plotW]);
  }, [x, plotW, domain]);

  const mini = useMemo(
    () => (i: number) => ({
      left: x(spans[i].start),
      width: Math.max(1, x(spans[i].end) - x(spans[i].start)),
    }),
    [x, spans],
  );

  return (
    <svg className="waterfall-overview" width={plotW + LABEL_W} height={BRUSH_H} role="img" aria-label="waterfall brush">
      {spans.map((s, i) => {
        const m = mini(i);
        return (
          <g key={s.id} className="waterfall-mini" transform={`translate(${LABEL_W},0)`}>
            <rect x={m.left} y={2} width={m.width} height={BRUSH_H - 16} fill="#4b5563" opacity={0.55} />
          </g>
        );
      })}
      <g transform={`translate(${LABEL_W},0)`} ref={gRef} />
    </svg>
  );
}

export function Waterfall({ nodes, nowMs, onOpen, onLayout }: WaterfallProps) {
  const spans = useMemo(() => sessionSpans(nodes, nowMs), [nodes, nowMs]);
  const domain = useMemo(() => domainOf(spans, nowMs), [spans, nowMs]);
  const [rawRange, setRawRange] = useState<IWaterfallRange>(() => defaultRange(domain));
  // Keep the brush window inside the domain when the node set changes.
  const range = useMemo(() => clampRange(rawRange, domain), [rawRange, domain]);

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

  const x = useMemo(
    () => scaleUtc().domain([range.start, range.end]).range([0, Math.max(1, width - LABEL_W)]),
    [range, width],
  );

  const visible = useMemo(() => visibleSessionIds(spans, range), [spans, range]);

  // Lazy per-session message cache: filled for sessions whose span intersects
  // the current range, never all history up front. Held in refs so history mode
  // owns them and releases them on unmount. `loading` guards against duplicate
  // IPC for in-flight reads; reads are never invalidated by re-renders (the
  // parent's nodes array churns identity), they land and populate the cache.
  const cache = useRef(new Map<string, ISessionTick[]>());
  const loading = useRef(new Set<string>());
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
  useEffect(() => {
    const visible = visibleSessionIds(spans, range);
    for (const id of visible) {
      if (cache.current.has(id) || loading.current.has(id)) continue;
      const node = nodesRef.current.find((n) => n.id === id);
      if (!node || !ADAPTER_HARNESSES.has(node.harness as HarnessId)) {
        cache.current.set(id, []);
        continue;
      }
      loading.current.add(id);
      const cwd = node.cwd.startsWith("~") ? getHomeDir() + node.cwd.slice(1) : node.cwd;
      harnessAdapter(node.harness as HarnessId)
        .read(node.id, cwd)
        .then((msgs: AiMessage[]) => {
          cache.current.set(id, msgs.map(tickFrom));
          loading.current.delete(id);
          if (alive.current) bump(1);
        })
        .catch(() => {
          cache.current.set(id, []);
          loading.current.delete(id);
          if (alive.current) bump(1);
        });
    }
  }, [range, spans]);

  const rows: AgentTreeNode[] = useMemo(
    () => nodes.filter((n) => visible.has(n.id)).map((n) => ({ ...n, children: [] })),
    [nodes, visible],
  );

  const plotW = Math.max(1, width - LABEL_W);
  const svgH = rows.length * ROW_H + 4;

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
      <div className="waterfall" data-testid="waterfall">
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
      <BrushOverview domain={domain} spans={spans} plotW={plotW} onRange={setRawRange} />
      <svg className="waterfall-plot" width={width} height={svgH} role="img" aria-label="session watermark plot">
        {rows.map((n, i) => {
          const s = spans.find((sp) => sp.id === n.id);
          if (!s) return null;
          const y = i * ROW_H + 2;
          const left = s.start > range.end || s.end < range.start;
          if (left) return null;
          const lx = x(s.start);
          const w = Math.max(1, x(s.end) - x(s.start));
          const ticks = ticksInRange(cache.current.get(n.id) ?? [], range);
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
      <TreeTable<AgentTreeNode>
        columns={COLUMNS}
        data={rows}
        getRowId={(r) => r.id}
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
  ".waterfall-plot{display:block;background:var(--panel-bg)}",
  ".waterfall-plot .waterfall-bar{fill:var(--waterfall-bar,#2a2f3a);stroke:var(--frame)}",
  ".waterfall-plot .waterfall-id{font-size:10px;fill:var(--panel-fg)}",
  ".waterfall-plot .waterfall-tick{stroke:#fff;stroke-width:.5}",
  "svg.waterfall-overview g.brush rect.overlay{cursor:crosshair}",
].join("");
