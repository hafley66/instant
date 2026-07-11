import { Endpoint } from "@hafley66/signals";
import { firstValueFrom } from "rxjs";
import { HttpStatusError, paths } from "./generated/api";
import { HTTP_TIMEOUT_MS, httpTransport } from "./reactive/httpTransport";
import type { WorktreeRow } from "./state";

export const GHCACHE_TIMEOUT_MS = HTTP_TIMEOUT_MS;

export interface WorktreeSnapshot {
  rows: WorktreeRow[];
  source: "ghcache" | "local";
  ghcacheError?: "http" | "unreachable";
  httpStatus?: number;
}

export interface GhcacheSnapshot {
  rows: WorktreeRow[];
  error?: "http" | "unreachable";
  httpStatus?: number;
}

// One application-wide endpoint contract. Status and Worktrees share this;
// only Worktrees layers the expensive local Rust fallback around it.
export const ghcacheWorktreesEndpoint = paths.worktrees.endpoint(httpTransport);

export async function queryGhcacheSnapshot(
  endpoint: Endpoint<void, WorktreeRow[]> = ghcacheWorktreesEndpoint,
): Promise<GhcacheSnapshot> {
  try {
    return { rows: await firstValueFrom(endpoint.execute(undefined)) };
  } catch (error) {
    if (error instanceof HttpStatusError) {
      return { rows: [], error: "http", httpStatus: error.status };
    }
    return { rows: [], error: "unreachable" };
  }
}

export async function queryWorktreeSnapshot(
  scanLocal: () => Promise<WorktreeRow[]>,
  endpoint: Endpoint<void, WorktreeRow[]> = ghcacheWorktreesEndpoint,
): Promise<WorktreeSnapshot> {
  const ghcache = await queryGhcacheSnapshot(endpoint);
  if (!ghcache.error) return { rows: ghcache.rows, source: "ghcache" };
  const rows = await scanLocal();
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
