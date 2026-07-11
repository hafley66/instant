import type { WorktreeRow } from "./state";

export const GHCACHE_BASE = "http://127.0.0.1:7748";
export const GHCACHE_TIMEOUT_MS = 2000;

export interface WorktreeSnapshot {
  rows: WorktreeRow[];
  source: "ghcache" | "local";
  ghcacheError?: "http" | "unreachable";
  httpStatus?: number;
}

export interface GhcacheSnapshotPorts {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  timeoutSignal(ms: number): AbortSignal;
}

export interface GhcacheSnapshot {
  rows: WorktreeRow[];
  error?: "http" | "unreachable";
  httpStatus?: number;
}

export interface WorktreeSnapshotPorts extends GhcacheSnapshotPorts {
  scanLocal(): Promise<WorktreeRow[]>;
}

export type WorktreeDelta = {
  event: string;
  payload: WorktreeRow | { worktree: string };
};

export function applyWorktreeDeltaRows(rows: WorktreeRow[], message: WorktreeDelta): WorktreeRow[] {
  if (message.event === "deleted") {
    const path = (message.payload as { worktree: string }).worktree;
    return rows.filter((row) => row.worktree !== path);
  }
  const row = message.payload as WorktreeRow;
  if (!row?.worktree) return rows;
  const next = rows.slice();
  const index = next.findIndex((existing) => existing.worktree === row.worktree);
  if (index >= 0) next[index] = row;
  else next.push(row);
  return next;
}

export async function queryGhcacheSnapshot(ports: GhcacheSnapshotPorts): Promise<GhcacheSnapshot> {
  try {
    const response = await ports.fetch(`${GHCACHE_BASE}/worktrees`, {
      signal: ports.timeoutSignal(GHCACHE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { rows: [], error: "http", httpStatus: response.status };
    }
    return { rows: (await response.json()) as WorktreeRow[] };
  } catch {
    return { rows: [], error: "unreachable" };
  }
}

export async function queryWorktreeSnapshot(
  ports: WorktreeSnapshotPorts,
): Promise<WorktreeSnapshot> {
  const ghcache = await queryGhcacheSnapshot(ports);
  if (!ghcache.error) return { rows: ghcache.rows, source: "ghcache" };
  const rows = await ports.scanLocal();
  if (ghcache.error === "http") {
    return {
      rows,
      source: "local",
      ghcacheError: "http",
      httpStatus: ghcache.httpStatus,
    };
  }
  return { rows, source: "local", ghcacheError: "unreachable" };
}

export const timeoutSignal = (ms: number) => AbortSignal.timeout(ms);
