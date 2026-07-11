import { describe, expect, it, vi } from "vitest";
import {
  GHCACHE_TIMEOUT_MS,
  applyWorktreeDeltaRows,
  queryWorktreeSnapshot,
} from "./ghcacheSnapshot";
import type { WorktreeRow } from "./state";

const row = { worktree: "/repo" } as WorktreeRow;
const response = (ok: boolean, status: number, rows: WorktreeRow[] = []) =>
  ({ ok, status, json: async () => rows }) as Response;

describe("ghcache worktree snapshot", () => {
  it("returns the daemon snapshot and preserves the two-second timeout", async () => {
    const scanLocal = vi.fn(async () => [] as WorktreeRow[]);
    const timeoutSignal = vi.fn(() => new AbortController().signal);
    const result = await queryWorktreeSnapshot({
      fetch: async () => response(true, 200, [row]),
      scanLocal,
      timeoutSignal,
    });
    expect(result).toEqual({ rows: [row], source: "ghcache" });
    expect(timeoutSignal).toHaveBeenCalledWith(GHCACHE_TIMEOUT_MS);
    expect(scanLocal).not.toHaveBeenCalled();
  });

  it("falls back on HTTP failure", async () => {
    const result = await queryWorktreeSnapshot({
      fetch: async () => response(false, 503),
      scanLocal: async () => [row],
      timeoutSignal: () => new AbortController().signal,
    });
    expect(result).toEqual({ rows: [row], source: "local", ghcacheError: "http", httpStatus: 503 });
  });

  it("falls back on timeout or transport failure", async () => {
    const result = await queryWorktreeSnapshot({
      fetch: async () => { throw new DOMException("timed out", "TimeoutError"); },
      scanLocal: async () => [row],
      timeoutSignal: () => new AbortController().signal,
    });
    expect(result).toEqual({ rows: [row], source: "local", ghcacheError: "unreachable" });
  });

  it("propagates a failed local fallback", async () => {
    await expect(queryWorktreeSnapshot({
      fetch: async () => response(false, 500),
      scanLocal: async () => { throw new Error("scan failed"); },
      timeoutSignal: () => new AbortController().signal,
    })).rejects.toThrow("scan failed");
  });

  it("keeps SSE upsert and delete behavior after the shared snapshot", () => {
    const changed = { ...row, branch: "feature" };
    expect(applyWorktreeDeltaRows([row], { event: "updated", payload: changed })).toEqual([changed]);
    expect(applyWorktreeDeltaRows([row], {
      event: "deleted",
      payload: { worktree: row.worktree },
    })).toEqual([]);
  });
});
