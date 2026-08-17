import {
  boopAgentSnapshotSchema,
  projectAgentTimeline,
  projectAgentTree,
  type BoopAgentEvent,
  type BoopAgentSnapshot,
} from "@hafley66/boop-adapters";
import { z } from "zod";
import type {
  AgentEdgeFact,
  AgentGraphQuery,
  AgentExplorerSnapshot,
  BoopAgentGraph,
  BoopProducerGraph,
  BoopShellNode,
} from "./0_boopAgentExplorerTypes";

export const BOOP_AGENT_BIN = "/Users/chrishafley/.cargo/bin/boop";
export const BOOP_AGENT_SCHEMA_VERSION = 1;

export type RunBoopCommand = (query: AgentGraphQuery) => Promise<string>;
export type LoadBoopAgentGraph = (query: AgentGraphQuery) => Promise<BoopAgentGraph>;
export type ProjectAgentTimeline = (graph: BoopAgentGraph) => ReturnType<typeof projectAgentTimeline>;

const producerGraphSchema = z.object({
  schema_version: z.number(),
  sessions: z.array(z.object({
    session: z.object({ harness: z.string().min(1), id: z.string().min(1) }),
    cwd: z.string().nullable().optional(),
    tmux: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    last_activity_ts: z.number().nullable().optional(),
  })),
  edges: z.array(z.object({
    id: z.string().optional(),
    parent: z.object({ harness: z.string().min(1), id: z.string().min(1) }),
    child: z.object({ harness: z.string().min(1), id: z.string().min(1) }),
    kind: z.string().min(1),
    timestamp: z.number().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })),
  shells: z.array(z.object({
    lane: z.string().min(1),
    parent_lane: z.string().nullable().optional(),
    harness: z.string().nullable().optional(),
    mode: z.string().nullable().optional(),
    session_id: z.string().nullable().optional(),
    cwd: z.string().nullable().optional(),
    tmux: z.string().nullable().optional(),
    pid: z.number().nullable().optional(),
    state: z.string(),
  })),
  events: z.array(z.unknown()).optional(),
  trace_events: z.array(z.object({
    event_key: z.string().min(1),
    lane: z.string().min(1),
    trace: z.string().nullable().optional(),
    session: z.string().nullable().optional(),
    kind: z.string().min(1),
    from_lane: z.string().nullable().optional(),
    to_lane: z.string().nullable().optional(),
    started_ts: z.number().nullable().optional(),
    finished_ts: z.number().nullable().optional(),
    delivery_state: z.string().nullable().optional(),
    classification: z.string().nullable().optional(),
    detail: z.string(),
    created_ts: z.number(),
  })).optional(),
});

function identity(harness: string, id: string): string {
  return `${harness}:${id}`;
}

function shellNode(shell: BoopShellNode): BoopAgentGraph["nodes"][number] {
  const harness = shell.harness ?? "shell";
  const parentId = shell.parent_lane ? identity(harness, shell.parent_lane) : null;
  return {
    id: shell.lane,
    harness,
    sessionId: shell.session_id ?? shell.lane,
    parentId,
    label: shell.lane,
    status: shell.state,
    from: parentId ?? "user",
    why: shell.mode ?? "shell",
    cwd: shell.cwd ?? undefined,
    metadata: {
      lane: shell.lane,
      tmux: shell.tmux,
      pid: shell.pid,
    },
  };
}

type ProducerTraceEvent = {
  event_key: string;
  lane: string;
  trace?: string | null;
  session?: string | null;
  kind: string;
  from_lane?: string | null;
  to_lane?: string | null;
  started_ts?: number | null;
  finished_ts?: number | null;
  delivery_state?: string | null;
  classification?: string | null;
  detail: string;
  created_ts: number;
};

function eventFromProducer(
  row: ProducerTraceEvent,
  identityFor: (value: string | null | undefined) => string | undefined,
): BoopAgentEvent {
  const nodeId = identityFor(row.session) ?? identityFor(row.lane) ?? "unknown";
  const from = identityFor(row.from_lane);
  const to = identityFor(row.to_lane);
  return {
    id: row.event_key,
    kind: row.kind,
    nodeId,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    message: row.detail,
    preview: row.detail,
    ...(row.started_ts == null ? {} : { start: row.started_ts }),
    ...(row.finished_ts == null ? {} : { end: row.finished_ts }),
    metadata: {
      ...(row.trace == null ? {} : { trace: row.trace }),
      ...(row.delivery_state == null ? {} : { deliveryState: row.delivery_state }),
      ...(row.classification == null ? {} : { classification: row.classification }),
      createdTs: row.created_ts,
    },
  };
}

function producerToSnapshot(input: BoopProducerGraph): BoopAgentGraph {
  const nodes = input.sessions.map((session) => ({
    id: session.session.id,
    harness: session.session.harness,
    sessionId: session.session.id,
    label: session.session.id,
    status: session.state ?? "unknown",
    cwd: session.cwd ?? undefined,
    metadata: { tmux: session.tmux, lastActivityTs: session.last_activity_ts },
  }));
  const shells = input.shells.map(shellNode);
  const allNodes = [...nodes, ...shells];
  const identities = new Map<string, string>();
  for (const node of allNodes) {
    identities.set(identity(node.harness, node.id), identity(node.harness, node.id));
    identities.set(node.id, identity(node.harness, node.id));
    const metadata = node.metadata;
    if (metadata && typeof metadata === "object" && "lane" in metadata && typeof metadata.lane === "string") identities.set(metadata.lane, identity(node.harness, node.id));
  }
  const identityFor = (value: string | null | undefined): string | undefined => value ? identities.get(value) : undefined;
  const edges = input.edges.map((edge) => ({
    id: edge.id,
    from: identity(edge.parent.harness, edge.parent.id),
    to: identity(edge.child.harness, edge.child.id),
    kind: edge.kind,
    metadata: {
      ...(edge.timestamp == null ? {} : { timestamp: edge.timestamp }),
      ...edge.metadata,
    },
  }));
  const events = (input.trace_events as ProducerTraceEvent[] | undefined ?? []).map((event) => eventFromProducer(event, identityFor));
  return {
    schemaVersion: "boop-agent/1",
    nodes: allNodes,
    edges,
    events,
    producerEdges: input.edges,
  };
}

function canonicalSnapshot(input: unknown): BoopAgentGraph | null {
  if (!input || typeof input !== "object") return null;
  const row = input as Record<string, unknown>;
  if (typeof row.schemaVersion !== "string" || !Array.isArray(row.nodes) || !Array.isArray(row.edges) || !Array.isArray(row.events)) return null;
  const snapshot = boopAgentSnapshotSchema.parse(row) as BoopAgentSnapshot;
  return {
    ...snapshot,
    producerEdges: snapshot.edges.map((edge) => ({
      id: edge.id,
      parent: { harness: edge.from.split(":", 1)[0] ?? "", id: edge.from.split(":").slice(1).join(":") },
      child: { harness: edge.to.split(":", 1)[0] ?? "", id: edge.to.split(":").slice(1).join(":") },
      kind: edge.kind ?? "edge",
      timestamp: null,
      metadata: edge.metadata,
    })),
  };
}

export function parseBoopAgentGraph(input: unknown): BoopAgentGraph {
  const canonical = canonicalSnapshot(input);
  if (canonical) return canonical;
  const producer = producerGraphSchema.parse(input);
  if (producer.schema_version !== BOOP_AGENT_SCHEMA_VERSION) {
    throw new Error(`unsupported Boop agent graph schema version: ${producer.schema_version}`);
  }
  return producerToSnapshot(producer);
}

function edgeKey(from: string, to: string, kind: string): string {
  return `${from}->${to}:${kind}`;
}

export function projectAgentEdges(graph: BoopAgentGraph): AgentEdgeFact[] {
  const byKey = new Map<string, AgentEdgeFact>();
  const add = (from: string, to: string, kind: string, timestamp: number | null, id?: string) => {
    if (!from || !to) return;
    const key = id ?? edgeKey(from, to, kind);
    const current = byKey.get(key);
    if (current) {
      current.occurrenceCount += 1;
      if (current.timestamp === null && timestamp !== null) current.timestamp = timestamp;
      return;
    }
    byKey.set(key, { id: key, from, to, kind, timestamp, occurrenceCount: 1 });
  };
  for (const edge of graph.edges) {
    add(edge.from, edge.to, edge.kind ?? "edge", typeof edge.metadata?.timestamp === "number" ? edge.metadata.timestamp : null, edge.id);
  }
  for (const event of graph.events) {
    if (event.from && event.to) {
      const timestamp = typeof event.start === "number" ? event.start : null;
      add(event.from, event.to, event.kind, timestamp, undefined);
    }
  }
  return [...byKey.values()];
}

const ACTIVE_AGENT_STATES = new Set(["live", "running", "active"]);

function epochMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

export function recentAgentGraph(graph: BoopAgentGraph, sinceMs: number): BoopAgentGraph {
  const activity = new Map<string, number>();
  const note = (id: string | undefined, value: unknown) => {
    if (!id) return;
    const timestamp = epochMs(value);
    if (timestamp !== null && timestamp > (activity.get(id) ?? 0)) activity.set(id, timestamp);
  };
  for (const node of graph.nodes) {
    const id = identity(node.harness, node.id);
    note(id, node.metadata?.lastActivityTs);
  }
  for (const edge of graph.edges) {
    note(edge.from, edge.metadata?.timestamp);
    note(edge.to, edge.metadata?.timestamp);
  }
  for (const event of graph.events) {
    const timestamp = event.end ?? event.start ?? event.metadata?.createdTs;
    note(event.nodeId, timestamp);
    note(event.from, timestamp);
    note(event.to, timestamp);
  }

  const keep = new Set<string>();
  for (const node of graph.nodes) {
    const id = identity(node.harness, node.id);
    if (ACTIVE_AGENT_STATES.has(node.status?.toLowerCase() ?? "") || (activity.get(id) ?? 0) >= sinceMs) keep.add(id);
  }
  // A recent child needs its historical parents so projectAgentTree can retain
  // the path. Walk to a fixed point because parent chains can be arbitrarily deep.
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) {
      if (keep.has(edge.to) && !keep.has(edge.from)) {
        keep.add(edge.from);
        changed = true;
      }
    }
  }
  const nodes = graph.nodes.filter((node) => keep.has(identity(node.harness, node.id)));
  const edges = graph.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to));
  const events = graph.events.filter((event) => {
    const timestamp = epochMs(event.end ?? event.start ?? event.metadata?.createdTs);
    return timestamp !== null && timestamp >= sinceMs && keep.has(event.nodeId);
  });
  const producerEdges = graph.producerEdges.filter((edge) =>
    keep.has(identity(edge.parent.harness, edge.parent.id)) && keep.has(identity(edge.child.harness, edge.child.id))
  );
  return { ...graph, nodes, edges, events, producerEdges };
}

export function projectBoopAgentGraph(graph: BoopAgentGraph, sinceMs?: number): AgentExplorerSnapshot {
  const source = sinceMs === undefined ? graph : recentAgentGraph(graph, sinceMs);
  return {
    graph: source,
    tree: projectAgentTree(source),
    timeline: projectAgentTimeline(source),
    edges: projectAgentEdges(source),
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function boopAgentGraphCommand(query: AgentGraphQuery, bin = BOOP_AGENT_BIN): string {
  const args = [bin, "agent", "sessions", "--format", "json"];
  if (query.cwd) args.push("--cwd", shellQuote(query.cwd));
  if (query.includeHistory) args.push("--history");
  return args.map((arg, index) => {
    if (index === 0 || /^[A-Za-z0-9_./-]+$/.test(arg) || arg.startsWith("'")) return arg;
    return shellQuote(arg);
  }).join(" ");
}

export class BoopAgentExplorerClient {
  constructor(private readonly run: RunBoopCommand) {}

  async load(query: AgentGraphQuery): Promise<BoopAgentGraph> {
    const text = await this.run(query);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Boop agent graph was not JSON: ${String(error)}`);
    }
    return parseBoopAgentGraph(parsed);
  }
}

export const projectTimeline: ProjectAgentTimeline = projectAgentTimeline;
