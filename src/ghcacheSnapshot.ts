import type { WorktreeRow } from "./state";

export const GHCACHE_BASE = "http://127.0.0.1:7748";
export const GHCACHE_TIMEOUT_MS = 2000;

export interface WorktreeSnapshot {
  rows: WorktreeRow[];
  source: "ghcache" | "local";
  ghcacheError?: "http" | "unreachable";
  httpStatus?: number;
}

export interface WorktreeSnapshotPorts {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  scanLocal(): Promise<WorktreeRow[]>;
  timeoutSignal(ms: number): AbortSignal;
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

export async function queryWorktreeSnapshot(
  ports: WorktreeSnapshotPorts,
): Promise<WorktreeSnapshot> {
  try {
    const response = await ports.fetch(`${GHCACHE_BASE}/worktrees`, {
      signal: ports.timeoutSignal(GHCACHE_TIMEOUT_MS),
    });
    if (!response.ok) {
      return {
        rows: await ports.scanLocal(),
        source: "local",
        ghcacheError: "http",
        httpStatus: response.status,
      };
    }
    return { rows: (await response.json()) as WorktreeRow[], source: "ghcache" };
  } catch {
    return {
      rows: await ports.scanLocal(),
      source: "local",
      ghcacheError: "unreachable",
    };
  }
}

export const timeoutSignal = (ms: number) => AbortSignal.timeout(ms);
