import { useCallback, useEffect } from "react";
import { Signal } from "@hafley66/signals";
import { invoke } from "../../generated/native";
import { tildify } from "../../core";
import type { AgentSessionNode, Harness, ParentKind, SessionStatus } from "./0_types";

type GraphIdentity = { harness: string; id: string };
type GraphSession = {
  session: GraphIdentity;
  cwd?: string | null;
  tmux?: string | null;
  state?: string | null;
  trace?: string | null;
  started_ts?: number | null;
  last_activity_ts?: number | null;
  finished_ts?: number | null;
};
type GraphEdge = {
  parent: GraphIdentity;
  child: GraphIdentity;
  kind: string;
};
type GraphShell = {
  lane: string;
  parent_lane?: string | null;
  harness?: string | null;
  session_id?: string | null;
  session?: GraphIdentity | null;
  trace?: string | null;
  cwd?: string | null;
  tmux?: string | null;
  tmux_session?: string | null;
  tmux_pane?: string | null;
  state: string;
  started_ts?: number | null;
  registered_at?: string | null;
};
type BoopGraph = { sessions: GraphSession[]; edges: GraphEdge[]; shells: GraphShell[] };
export type BoopFamilyQuery = {
  include_history: boolean;
  tmux: string;
  history_since_ts: number;
};

const statusOf = (state: string | null | undefined): SessionStatus =>
  state === "live" ? "live" : state === "idle" ? "idle" : state === "dead" ? "dead" : "done";
const iso = (ts: number | null | undefined, fallback: number) => new Date(ts ?? fallback).toISOString();
const harnessOf = (value: string | null | undefined): Harness =>
  value === "claude" || value === "opencode" || value === "codex" || value === "kimi" ? value : "shell";
const identityKey = (identity: GraphIdentity) => `${identity.harness}:${identity.id}`;
const parentKindOf = (kind: string): ParentKind =>
  kind === "subagent" || kind === "dispatch" ? kind : (kind as ParentKind);

export function normalizeBoopFamily(raw: BoopGraph, now = Date.now()): AgentSessionNode[] {
  const parentByChild = new Map<string, GraphEdge>();
  for (const edge of raw.edges) parentByChild.set(identityKey(edge.child), edge);
  const nodes = raw.sessions.map((session): AgentSessionNode => {
    const edge = parentByChild.get(identityKey(session.session));
    return {
      id: session.session.id,
      harness: harnessOf(session.session.harness),
      parentId: edge?.parent.id ?? null,
      parentKind: edge ? parentKindOf(edge.kind) : null,
      from: "user",
      why: "",
      ts: iso(session.started_ts, now),
      lastActivity: iso(session.last_activity_ts ?? session.finished_ts ?? session.started_ts, now),
      status: statusOf(session.state),
      cwd: session.cwd ? tildify(session.cwd) : "",
      tmuxSession: session.tmux ?? null,
      tmuxMatches: session.tmux ? [session.tmux] : [],
    };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const shell of raw.shells) {
    const sessionId = shell.session?.id ?? shell.session_id ?? null;
    const existing = sessionId ? byId.get(sessionId) : undefined;
    const tmux = shell.tmux_session ?? (shell.tmux && !shell.tmux.startsWith("%") ? shell.tmux : null);
    if (existing) {
      existing.tmuxSession = tmux ?? existing.tmuxSession;
      existing.tmuxMatches = [...new Set([...(existing.tmuxMatches ?? []), ...(tmux ? [tmux] : [])])];
      continue;
    }
    nodes.push({
      id: shell.lane,
      harness: harnessOf(shell.harness),
      parentId: shell.parent_lane ?? null,
      parentKind: shell.parent_lane ? "dispatch" : null,
      from: "user",
      why: "",
      ts: iso(shell.started_ts, shell.registered_at ? Date.parse(shell.registered_at) : now),
      lastActivity: iso(shell.started_ts, shell.registered_at ? Date.parse(shell.registered_at) : now),
      status: statusOf(shell.state),
      cwd: shell.cwd ? tildify(shell.cwd) : "",
      tmuxSession: tmux,
      tmuxMatches: tmux ? [tmux] : [],
    });
  }
  // Shell session references can be parent evidence for a route whose lane id
  // differs from its transcript id. Preserve the route's explicit parent lane.
  for (const shell of raw.shells) {
    const sessionId = shell.session?.id ?? shell.session_id;
    const node = sessionId ? byId.get(sessionId) : undefined;
    if (node && shell.parent_lane && node.parentId === null) {
      node.parentId = shell.parent_lane;
      node.parentKind = "dispatch";
    }
  }
  return nodes;
}

type FamilyEntry = {
  data: AgentSessionNode[] | null;
  error: string;
  promise: Promise<void> | null;
  generation: number;
  consumers: number;
  disposeTimer: ReturnType<typeof setTimeout> | null;
};
const cache = new Map<string, FamilyEntry>();
const cacheVersion = Signal(0);
const entryFor = (key: string): FamilyEntry => {
  const existing = cache.get(key);
  if (existing) return existing;
  const entry: FamilyEntry = { data: null, error: "", promise: null, generation: 0, consumers: 0, disposeTimer: null };
  cache.set(key, entry);
  return entry;
};

function keyOf(query: BoopFamilyQuery): string {
  return JSON.stringify(query);
}

function publish(): void {
  cacheVersion.$(cacheVersion.$() + 1);
}

function fetchFamily(query: BoopFamilyQuery, refresh: boolean): void {
  const key = keyOf(query);
  const entry = entryFor(key);
  if (!refresh && (entry.data || entry.promise)) return;
  const generation = ++entry.generation;
  entry.error = "";
  entry.promise = invoke<string>("boop_agent_graph", query as unknown as Record<string, unknown>)
    .then((payload) => {
      if (generation !== entry.generation) return;
      const graph = typeof payload === "string" ? JSON.parse(payload) as BoopGraph : payload as unknown as BoopGraph;
      entry.data = normalizeBoopFamily(graph);
    })
    .catch((reason: unknown) => {
      if (generation === entry.generation) entry.error = String(reason);
    })
    .finally(() => {
      if (generation === entry.generation) entry.promise = null;
      publish();
    });
  publish();
}

export function useBoopFamily(query: BoopFamilyQuery | null): {
  nodes: AgentSessionNode[];
  error: string;
  load: () => void;
} {
  const key = query ? keyOf(query) : "disabled";
  cacheVersion.$();
  useEffect(() => {
    if (!query) return;
    const entry = entryFor(key);
    entry.consumers += 1;
    if (entry.disposeTimer) {
      clearTimeout(entry.disposeTimer);
      entry.disposeTimer = null;
    }
    fetchFamily(query, false);
    return () => {
      entry.consumers -= 1;
      if (entry.consumers !== 0) return;
      entry.disposeTimer = setTimeout(() => {
        if (entry.consumers !== 0) return;
        entry.generation += 1;
        cache.delete(key);
        publish();
      });
    };
  }, [key, query]);
  const load = useCallback(() => {
    if (query) fetchFamily(query, true);
  }, [query]);
  if (!query) return { nodes: [], error: "", load: () => {} };
  const entry = entryFor(key);
  return { nodes: entry.data ?? [], error: entry.error, load };
}

export function focusedFamilyQuery(sid: string): BoopFamilyQuery {
  return {
    include_history: true,
    tmux: sid.startsWith("s:") ? sid.slice(2) : sid,
    history_since_ts: Date.now() - 7 * 24 * 60 * 60 * 1000,
  };
}
