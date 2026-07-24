export interface CassSwarmProvider {
  name: string;
  source?: string;
  status?: string;
  freshness_ms?: number | null;
  warning?: string;
  error_kind?: string;
}

export interface CassSwarmSummary {
  ready_count?: number;
  in_progress_count?: number;
  blocked_count?: number;
  active_agent_count?: number;
  active_reservation_count?: number;
  dirty_worktree?: boolean;
  recommended_action?: string;
}

export interface CassSwarmBeads {
  ready?: Record<string, unknown>[];
  in_progress?: Record<string, unknown>[];
  blocked?: Record<string, unknown>[];
}

export interface CassSwarmStatus {
  schema_version?: string;
  status?: string;
  providers?: CassSwarmProvider[];
  summary?: CassSwarmSummary;
  beads?: CassSwarmBeads;
  agents?: Record<string, unknown>[];
  reservations?: Record<string, unknown>[];
}

export type CassSwarmRow = {
  id: string;
  kind: "provider" | "agent" | "reservation" | "work" | "message" | "call";
  status: string;
  title: string;
  detail: string;
  children?: CassSwarmRow[];
};
