// Pure projection/range math for the session waterfall. No React, no store
// import: the d3 scale lives in the component, so this module runs headless in
// vitest like the rest of the 0_ modules. Everything is unix ms.
import type { AgentSessionNode, ISessionSpan, ISessionTick, IWaterfallBin, IWaterfallDomain, IWaterfallRange, TickType } from "./0_types";
import type { AiMessage } from "../../state";

// How many sessions the first paint covers. The whole domain is not an option:
// at real history sizes it puts every session in range, which is what fed the
// unbounded render and the per-session read fan-out.
export const DEFAULT_SESSION_LIMIT = 40;

// Overview density columns. Fixed, so the overview costs the same at 4 sessions
// and at 4000.
export const OVERVIEW_BINS = 60;

// Minimum horizontal gap between two drawn ticks on one lane. Ticks are r=3, so
// anything closer already overlaps; collapsing them caps a lane's circles at
// plotW/MIN_TICK_PX regardless of how many messages the session holds.
export const MIN_TICK_PX = 3;

// Which tick survives when several land in one pixel bucket. A human prompt and
// a dispatch say more about what happened than the assistant turns between them.
const TICK_RANK: Record<TickType, number> = {
  dispatch: 0,
  user: 1,
  tool: 2,
  reasoning: 3,
  assistant: 4,
};

export function toSpan(node: AgentSessionNode, nowMs: number): ISessionSpan {
  // start = Date.parse(ts)||nowMs fallback; end = Date.parse(lastActivity)||nowMs;
  // end = Math.max(end, start); live statuses render end = nowMs so the bar breathes.
  const start = Date.parse(node.ts) || nowMs;
  let end = Date.parse(node.lastActivity) || nowMs;
  end = Math.max(end, start);
  if (node.status === "live") end = Math.max(end, nowMs);
  return { id: node.id, harness: node.harness, start, end };
}

export function tickType(msg: AiMessage): TickType {
  // tool subtypes and codex tool-result names ride subtype; reasoning is its
  // own subtype; user prompts read off role; everything else is assistant.
  const st = msg.subtype;
  if (st?.includes("tool")) return "tool";
  if (st === "reasoning") return "reasoning";
  // Harness transcripts store bus-injected coordinator lines as role=user;
  // the [bus m-*] stamp (1_leg injectedLine) is what tells them apart.
  if (msg.role === "user") return /^\[bus [^\]]+\]/.test(msg.preview) ? "dispatch" : "user";
  if (st) return "tool";
  return "assistant";
}

export function tickFrom(msg: AiMessage): ISessionTick {
  // { sessionId: msg.session_id, ts: msg.ts, type: tickType(msg), preview: msg.preview }
  return { sessionId: msg.session_id, ts: msg.ts, type: tickType(msg), preview: msg.preview };
}

export function sessionSpans(nodes: AgentSessionNode[], nowMs: number): ISessionSpan[] {
  // nodes.map(toSpan) — spans for every node, including done/dead history.
  return nodes.map((n) => toSpan(n, nowMs));
}

export function domainOf(spans: ISessionSpan[], nowMs: number): IWaterfallDomain {
  // pad = max(1, (maxEnd - minStart) * 0.02); start = minStart - pad;
  // end = Math.max(maxEnd, nowMs) + pad. Empty set degrades to a zero-width
  // domain at the clock so the overview has somewhere to sit.
  if (!spans.length) return { start: nowMs, end: nowMs };
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const s of spans) {
    if (s.start < minStart) minStart = s.start;
    if (s.end > maxEnd) maxEnd = s.end;
  }
  const pad = Math.max(1, (maxEnd - minStart) * 0.02);
  return { start: minStart - pad, end: Math.max(maxEnd, nowMs) + pad };
}

export function defaultRange(
  spans: ISessionSpan[],
  domain: IWaterfallDomain,
  limit = DEFAULT_SESSION_LIMIT,
): IWaterfallRange {
  // The newest `limit` sessions, ending at the domain's right edge. Count, not
  // wall clock: session activity is bursty, so an hour-wide window shows nothing
  // after an idle night and everything during a fan-out. At or below the limit
  // this is the whole domain, so small histories still open fully brushed.
  if (spans.length <= limit) return { start: domain.start, end: domain.end };
  const starts = spans.map((s) => s.start).sort((a, b) => b - a);
  return { start: starts[limit - 1], end: domain.end };
}

export function spansInRange(spans: ISessionSpan[], r: IWaterfallRange): ISessionSpan[] {
  // Keep spans whose [start,end] closed interval intersects [r.start,r.end].
  return spans.filter((s) => s.start <= r.end && s.end >= r.start);
}

export function ticksInRange(ticks: ISessionTick[], r: IWaterfallRange): ISessionTick[] {
  // Keep ticks with r.start <= ts <= r.end.
  return ticks.filter((t) => t.ts >= r.start && t.ts <= r.end);
}

export function visibleSessionIds(spans: ISessionSpan[], r: IWaterfallRange): Set<string> {
  // spansInRange(...).map(span.id)
  return new Set(spansInRange(spans, r).map((s) => s.id));
}

export function decimateTicks(
  ticks: ISessionTick[],
  r: IWaterfallRange,
  plotW: number,
  minPx = MIN_TICK_PX,
): ISessionTick[] {
  // Bucket each tick by its pixel column, keep the highest-ranked type per
  // bucket, emit in time order. Output length <= plotW/minPx + 1, which is what
  // makes one lane's node count a function of the plot's width and nothing else.
  const buckets = Math.max(1, Math.floor(plotW / minPx));
  const width = r.end - r.start;
  const best = new Map<number, ISessionTick>();
  for (const t of ticks) {
    const frac = width > 0 ? (t.ts - r.start) / width : 0;
    const bucket = Math.max(0, Math.min(buckets, Math.round(frac * buckets)));
    const held = best.get(bucket);
    if (!held || TICK_RANK[t.type] < TICK_RANK[held.type]) best.set(bucket, t);
  }
  return [...best.values()].sort((a, b) => a.ts - b.ts);
}

export function binsPath(bins: IWaterfallBin[], plotW: number, height: number): string {
  // One step-area path for the whole density strip. A rect per column would put
  // the overview's node count back under the bin count; a path holds it at one
  // element no matter how many columns or sessions there are.
  if (!bins.length || plotW <= 0 || height <= 0) return "";
  const peak = bins.reduce((m, b) => Math.max(m, b.count), 0);
  if (peak <= 0) return "";
  const step = plotW / bins.length;
  const parts = [`M0,${height}`];
  for (let i = 0; i < bins.length; i++) {
    const y = height * (1 - bins[i].count / peak);
    parts.push(`L${(i * step).toFixed(2)},${y.toFixed(2)}`, `L${((i + 1) * step).toFixed(2)},${y.toFixed(2)}`);
  }
  parts.push(`L${plotW.toFixed(2)},${height}`, "Z");
  return parts.join("");
}

export function binSpans(spans: ISessionSpan[], domain: IWaterfallDomain, bins = OVERVIEW_BINS): IWaterfallBin[] {
  // Overlap count per column via a difference array, so this stays linear in
  // spans instead of spans*bins. A zero-width domain has nothing to lay out.
  const width = domain.end - domain.start;
  if (width <= 0 || bins <= 0) return [];
  const step = width / bins;
  const delta = new Array<number>(bins + 1).fill(0);
  for (const s of spans) {
    const lo = Math.max(0, Math.min(bins - 1, Math.floor((s.start - domain.start) / step)));
    const hi = Math.max(0, Math.min(bins - 1, Math.floor((s.end - domain.start) / step)));
    delta[lo] += 1;
    delta[hi + 1] -= 1;
  }
  const out: IWaterfallBin[] = [];
  let running = 0;
  for (let i = 0; i < bins; i++) {
    running += delta[i];
    out.push({ start: domain.start + i * step, end: domain.start + (i + 1) * step, count: running });
  }
  return out;
}
