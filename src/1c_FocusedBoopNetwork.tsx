import { Endpoint, Signal, SignalReact } from "@hafley66/signals/react";
import { from, map } from "rxjs";
import { useMemo, useRef } from "react";
import type { MarbleEvent } from "@hafley66/marbler";
import { invoke } from "./generated/native";
import { BoopNetworkGraph, projectBoopEventsToMarbler } from "./1a_BoopNetworkGraph";
import { boopNetworkEventSchema, parseBoopNetworkEvents, type BoopNetworkEvent } from "./1_boopNetwork";
import type { AgentSessionNode } from "./plugins/harnessTrace/0_types";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LIMIT = 2_000;
type Input = { sinceMs: number; limit: number };

function familyRows(nodes: AgentSessionNode[], events: BoopNetworkEvent[]): MarbleEvent[] {
  const eventRows = new Map(projectBoopEventsToMarbler(events).map((row) => [row.id, row]));
  const children = new Map<string | null, AgentSessionNode[]>();
  for (const node of nodes) {
    const parent = nodes.some((candidate) => candidate.id === node.parentId) ? node.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  const build = (node: AgentSessionNode): MarbleEvent => {
    const timed = eventRows.get(node.id);
    const nested = children.get(node.id)?.map(build);
    const metadata = [node.model, node.provider, node.preset].filter(Boolean).join(" · ");
    return {
      id: node.id,
      name: node.id,
      method: node.harness.toUpperCase(),
      status: node.status === "live" ? 200 : node.status === "done" ? 204 : node.status === "dead" ? 410 : 102,
      type: [node.status, metadata].filter(Boolean).join(" · "),
      initiator: node.parentId ?? "user",
      size: node.tokens?.in == null ? "-" : `${node.tokens.in.toLocaleString()} tok`,
      start: timed?.start ?? null,
      duration: timed?.duration ?? null,
      from: timed?.from ?? node.parentId ?? "user",
      to: node.id,
      preview: timed?.preview ?? `${node.status} · ${node.cwd}`,
      phases: timed?.phases ?? [],
      frames: timed?.frames ?? [],
      parentId: node.parentId,
      children: nested?.length ? nested : undefined,
    };
  };
  return (children.get(null) ?? []).map(build);
}

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
  const data = model.current.data.$() ?? [];
  const events = useMemo(() => data.filter((event) =>
    ids.has(event.session ?? "") || ids.has(event.lane) || ids.has(event.from_lane ?? "") || ids.has(event.to_lane ?? ""),
  ), [data, ids]);
  if (query.isError) return <div className="session-empty">{String(query.error)}</div>;
  if (query.isLoading) return <div className="session-empty">loading family events…</div>;
  const rows = useMemo(() => familyRows(props.nodes, events), [props.nodes, events]);
  if (rows.length === 0) return <div className="session-empty">no focused family sessions in the last seven days</div>;
  return <BoopNetworkGraph events={events} rows={rows} expandAll />;
}

export const FocusedBoopNetwork = SignalReact(FocusedBoopNetworkView);
