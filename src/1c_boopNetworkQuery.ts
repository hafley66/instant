// Reusable Boop trace-events query/model shared by the standalone Network
// panel and the focused-family Marbler strip. The endpoint is module-scoped so
// its query cache survives strip close/reopen: reopening reads the retained
// data immediately and only a stale refresh hits the wire (staleTime governs).
// The typed Endpoint.createQuery(Signal(...)) pattern is the single sanctioned
// trace-events fetch; no raw fetch effect, polling loop, or hand-rolled loading.
import { Endpoint, Signal } from "@hafley66/signals/react";
import { invoke } from "./generated/native";
import { from, map } from "rxjs";
import { boopNetworkEventSchema, parseBoopNetworkEvents, type BoopNetworkEvent } from "./1_boopNetwork";

export const HISTORY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const EVENT_LIMIT = 2_000;

export type NetworkInput = { sinceMs: number; limit: number };
export type RunBoopNetworkCommand = (query: NetworkInput) => Promise<string>;

let runEvents: RunBoopNetworkCommand | null = null;
export function setBoopTraceEventsRunner(run: RunBoopNetworkCommand): void {
  runEvents = run;
}

export const boopTraceEventsEndpoint = new Endpoint<NetworkInput, BoopNetworkEvent[]>({
  request: (input) => ({ url: "native://boop_trace_events", method: "POST", body: input }),
  decode: (response) => boopNetworkEventSchema.array().parse(response.body),
}, (request) => from(
  runEvents
    ? runEvents(request.body as NetworkInput)
    : invoke<string>("boop_trace_events", request.body as Record<string, unknown>),
).pipe(map((text) => ({ status: 200, body: parseBoopNetworkEvents(text) }))));

export function createBoopTraceModel(staleTime = 5_000) {
  const input = Signal<NetworkInput | undefined>({ sinceMs: Date.now() - HISTORY_WINDOW_MS, limit: EVENT_LIMIT });
  const query = boopTraceEventsEndpoint.createQuery(input, { staleTime });
  return { input, query };
}

// Module-scoped model so the query (and its retained data) outlive the panel
// that reads it. Reopening the strip reuses this same model: cached events
// render on mount and only a stale refresh re-fetches.
let sharedModel: ReturnType<typeof createBoopTraceModel> | null = null;

export function useBoopTraceEvents(): {
  events: BoopNetworkEvent[];
  refetch: () => void;
} {
  const model = sharedModel ??= createBoopTraceModel();
  const events = model.query.data.$() ?? [];
  return { events, refetch: () => model.query.refetch() };
}
