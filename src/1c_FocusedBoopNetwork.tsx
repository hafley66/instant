import { Endpoint, Signal, SignalReact } from "@hafley66/signals/react";
import { from, map } from "rxjs";
import { useMemo, useRef } from "react";
import { invoke } from "./generated/native";
import { BoopNetworkGraph } from "./1a_BoopNetworkGraph";
import { boopNetworkEventSchema, parseBoopNetworkEvents, type BoopNetworkEvent } from "./1_boopNetwork";
import type { AgentSessionNode } from "./plugins/harnessTrace/0_types";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LIMIT = 2_000;
type Input = { sinceMs: number; limit: number };

const endpoint = new Endpoint<Input, BoopNetworkEvent[]>({
  request: (input) => ({ url: "native://boop_trace_events", method: "POST", body: input }),
  decode: (response) => boopNetworkEventSchema.array().parse(response.body),
}, (request) => from(invoke<string>("boop_trace_events", request.body as Record<string, unknown>)).pipe(
  map((text) => ({ status: 200, body: parseBoopNetworkEvents(text) })),
));

function FocusedBoopNetworkView(props: { nodes: AgentSessionNode[] }) {
  const model = useRef<ReturnType<typeof endpoint.createQuery> | null>(null);
  model.current ??= endpoint.createQuery(Signal<Input | undefined>({ sinceMs: Date.now() - WEEK_MS, limit: LIMIT }), { staleTime: 5_000 });
  const query = model.current.$();
  const ids = useMemo(() => new Set(props.nodes.map((node) => node.id)), [props.nodes]);
  const events = (model.current.data.$() ?? []).filter((event) =>
    ids.has(event.session ?? "") || ids.has(event.lane) || ids.has(event.from_lane ?? "") || ids.has(event.to_lane ?? ""),
  );
  if (query.isError) return <div className="session-empty">{String(query.error)}</div>;
  if (query.isLoading) return <div className="session-empty">loading family events…</div>;
  if (events.length === 0) return <div className="session-empty">no recorded messages or lifecycle events for this family</div>;
  return <BoopNetworkGraph events={events} />;
}

export const FocusedBoopNetwork = SignalReact(FocusedBoopNetworkView);
