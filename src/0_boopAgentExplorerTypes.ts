import type {
  AgentTimelineEvent,
  AgentTreeCommunication,
  AgentTreeRow,
  BoopAgentEdge,
  BoopAgentEvent,
  BoopAgentNode,
  BoopAgentSnapshot,
} from "@hafley66/boop-adapters";

export type {
  AgentTimelineEvent,
  AgentTreeCommunication,
  AgentTreeRow,
  BoopAgentEdge,
  BoopAgentEvent,
  BoopAgentNode,
  BoopAgentSnapshot,
};

export interface AgentGraphQuery {
  cwd?: string;
  includeHistory?: boolean;
}

export interface BoopSessionIdentity {
  harness: string;
  id: string;
}

export interface BoopSessionNode {
  session: BoopSessionIdentity;
  cwd?: string | null;
  tmux?: string | null;
  state?: string | null;
  last_activity_ts?: number | null;
}

export interface BoopSessionEdge {
  id?: string;
  parent: BoopSessionIdentity;
  child: BoopSessionIdentity;
  kind: string;
  timestamp?: number | null;
  metadata?: Record<string, unknown>;
}

export interface BoopShellNode {
  lane: string;
  parent_lane?: string | null;
  harness?: string | null;
  mode?: string | null;
  session_id?: string | null;
  cwd?: string | null;
  tmux?: string | null;
  pid?: number | null;
  state: string;
}

export interface BoopProducerGraph {
  schema_version: number;
  sessions: BoopSessionNode[];
  edges: BoopSessionEdge[];
  shells: BoopShellNode[];
  events?: unknown[];
  trace_events?: unknown[];
}

export interface BoopAgentGraph extends BoopAgentSnapshot {
  /** Producer edge facts are retained for endpoint/count display. */
  producerEdges: BoopSessionEdge[];
}

export interface AgentEdgeFact {
  id: string;
  from: string;
  to: string;
  kind: string;
  timestamp: number | null;
  occurrenceCount: number;
}

export interface AgentExplorerSnapshot {
  graph: BoopAgentGraph;
  tree: AgentTreeRow[];
  timeline: AgentTimelineEvent[];
  edges: AgentEdgeFact[];
}

export interface BoopExplorerUiState {
  cwd?: string;
  includeHistory: boolean;
  filter: string;
  selectedId: string | null;
  expanded: Record<string, boolean>;
}

export const EMPTY_EXPLORER_UI: BoopExplorerUiState = {
  includeHistory: false,
  filter: "",
  selectedId: null,
  expanded: {},
};

export const BOOP_AGENT_EXPLORER_PLUGIN_ID = "boop-agent-explorer";
