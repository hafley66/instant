import { Endpoint, Signal, SignalReact } from "@hafley66/signals/react";
import { useMemo, useRef } from "react";
import { from, map } from "rxjs";
import { TreeTable, type TreeColumn } from "./treetable";
import { invoke } from "./generated/native";
import { boopNetworkEventSchema, parseBoopNetworkEvents, type BoopNetworkEvent } from "./1_boopNetwork";
import type { AgentSessionNode } from "./plugins/harnessTrace/0_types";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LIMIT = 2_000;
type Input = { sinceMs: number; limit: number };
type Phase = { start: number; end: number; kind: "send" | "receive" | "work" | "error" };
type FamilyRow = AgentSessionNode & { children?: FamilyRow[]; phases: Phase[] };

const endpoint = new Endpoint<Input, BoopNetworkEvent[]>({
  request: (input) => ({ url: "native://boop_trace_events", method: "POST", body: input }),
  decode: (response) => boopNetworkEventSchema.array().parse(response.body),
}, (request) => from(invoke<string>("boop_trace_events", request.body as Record<string, unknown>)).pipe(
  map((text) => ({ status: 200, body: parseBoopNetworkEvents(text) })),
));

function phaseKind(event: BoopNetworkEvent): Phase["kind"] {
  if (event.kind.includes("error") || event.classification === "failed") return "error";
  if (event.kind.includes("delivery") && event.to_lane === event.lane) return "receive";
  if (event.kind.includes("delivery") || event.from_lane) return "send";
  return "work";
}

function familyRows(nodes: AgentSessionNode[], events: BoopNetworkEvent[]): FamilyRow[] {
  const ids = new Set(nodes.map((node) => node.id));
  const phases = new Map<string, Phase[]>();
  for (const event of events) {
    const id = ids.has(event.session ?? "") ? event.session! : ids.has(event.lane) ? event.lane : null;
    if (!id) continue;
    const start = event.started_ts ?? event.created_ts;
    const end = Math.max(start + 1, event.finished_ts ?? start + 1);
    phases.set(id, [...(phases.get(id) ?? []), { start, end, kind: phaseKind(event) }]);
  }
  const children = new Map<string | null, AgentSessionNode[]>();
  for (const node of nodes) {
    const parent = ids.has(node.parentId ?? "") ? node.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  const build = (node: AgentSessionNode): FamilyRow => ({
    ...node,
    phases: phases.get(node.id) ?? [],
    children: children.get(node.id)?.map(build),
  });
  return (children.get(null) ?? []).map(build);
}

function FocusedBoopNetworkView(props: { nodes: AgentSessionNode[] }) {
  const model = useRef<ReturnType<typeof endpoint.createQuery> | null>(null);
  model.current ??= endpoint.createQuery(Signal<Input | undefined>({ sinceMs: Date.now() - WEEK_MS, limit: LIMIT }), { staleTime: 5_000 });
  const query = model.current.$();
  const events = model.current.data.$() ?? [];
  const rows = useMemo(() => familyRows(props.nodes, events), [props.nodes, events]);
  const bounds = useMemo(() => {
    const times = rows.flatMap(function collect(row): number[] {
      return [...row.phases.flatMap((phase) => [phase.start, phase.end]), ...(row.children ?? []).flatMap(collect)];
    });
    if (times.length === 0) return { start: 0, span: 1 };
    const start = Math.min(...times);
    return { start, span: Math.max(1, Math.max(...times) - start) };
  }, [rows]);
  const columns = useMemo<TreeColumn<FamilyRow>[]>(() => [
    { id: "session", header: "Session", tree: true, sortValue: (row) => Date.parse(row.ts), cell: (row) => <><b>{row.id}</b><small>{row.cwd}</small></> },
    { id: "harness", header: "Harness", sortValue: (row) => row.harness, cell: (row) => row.harness },
    { id: "status", header: "Status", sortValue: (row) => row.status, cell: (row) => row.status },
    { id: "model", header: "Model", sortValue: (row) => row.model, cell: (row) => [row.model, row.provider, row.preset].filter(Boolean).join(" · ") || "-" },
    { id: "tokens", header: "Tokens", sortValue: (row) => row.tokens?.in, cell: (row) => row.tokens?.in?.toLocaleString() ?? "-" },
    { id: "waterfall", header: "Events over time", cell: (row) => <div className="family-waterfall">{row.phases.map((phase, index) => <i key={index} className={`family-phase ${phase.kind}`} style={{ left: `${((phase.start - bounds.start) / bounds.span) * 100}%`, width: `${Math.max(0.35, ((phase.end - phase.start) / bounds.span) * 100)}%` }} />)}</div> },
  ], [bounds]);
  if (query.isError) return <div className="session-empty">{String(query.error)}</div>;
  if (query.isLoading) return <div className="session-empty">loading family events…</div>;
  if (rows.length === 0) return <div className="session-empty">no focused family sessions in the last seven days</div>;
  return <div className="focused-family-table" data-testid="focused-family-table"><TreeTable
    columns={columns}
    data={rows}
    getRowId={(row) => row.id}
    getSubRows={(row) => row.children}
    defaultExpandedAll
    virtual
    rowTitle={(row) => `${row.id} · ${row.status}`}
  /></div>;
}

export const FocusedBoopNetwork = SignalReact(FocusedBoopNetworkView);
