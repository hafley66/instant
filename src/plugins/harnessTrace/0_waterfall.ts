// Pure projection/range math for the session waterfall. No React, no store
// import: the d3 scale lives in the component, so this module runs headless in
// vitest like the rest of the 0_ modules. Everything is unix ms.
import type { AgentSessionNode, ISessionSpan, ISessionTick, IWaterfallDomain, IWaterfallRange, TickType } from "./0_types";
import type { AiMessage } from "../../state";

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
  if (msg.role === "user") return "user";
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

export function defaultRange(domain: IWaterfallDomain): IWaterfallRange {
  // Whole domain: history mode's first paint shows everything; the brush then
  // narrows it. The default (Show active) never shows the brush at all.
  return { start: domain.start, end: domain.end };
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
