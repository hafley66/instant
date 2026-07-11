import type { EndpointTransport, Serializable } from "@hafley66/signals";
import { describe, expect, it, vi } from "vitest";
import {
  GHCACHE_TIMEOUT_MS,
  applyWorktreeDeltaRows,
  queryGhcacheSnapshot,
  queryWorktreeSnapshot,
} from "./ghcacheSnapshot";
import { paths } from "./generated/api";
import { createHttpEndpoint } from "./reactive/httpTransport";
import { runtimePorts } from "./reactive/ports";
import type { WorktreeRow } from "./state";

const row = { worktree: "/repo" } as WorktreeRow;
const endpoint = (transport: EndpointTransport) =>
  createHttpEndpoint(paths.worktrees.endpoint, transport);
const reply = (status: number, body: Serializable = null): EndpointTransport =>
  async () => ({ status, body });

describe("ghcache worktree snapshot", () => {
  it("returns the daemon snapshot and preserves the two-second timeout", async () => {
    const scanLocal = vi.fn(async () => [] as WorktreeRow[]);
    const abortSignal = vi.spyOn(runtimePorts, "abortSignal").mockReturnValue(
      new AbortController().signal,
    );
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify([row]),
    })));
    const result = await queryWorktreeSnapshot(scanLocal);
    expect(result).toEqual({ rows: [row], source: "ghcache" });
    expect(abortSignal).toHaveBeenCalledWith(GHCACHE_TIMEOUT_MS);
    expect(scanLocal).not.toHaveBeenCalled();
  });

  it("lets Status probe the daemon without triggering any local scan fallback", async () => {
    const result = await queryGhcacheSnapshot(endpoint(async () => {
      throw new DOMException("timed out", "TimeoutError");
    }));
    expect(result).toEqual({ rows: [], error: "unreachable" });
  });

  it("falls back on HTTP failure", async () => {
    const result = await queryWorktreeSnapshot(
      async () => [row],
      endpoint(reply(503)),
    );
    expect(result).toEqual({ rows: [row], source: "local", ghcacheError: "http", httpStatus: 503 });
  });

  it("falls back on timeout or transport failure", async () => {
    const result = await queryWorktreeSnapshot(
      async () => [row],
      endpoint(async () => { throw new DOMException("timed out", "TimeoutError"); }),
    );
    expect(result).toEqual({ rows: [row], source: "local", ghcacheError: "unreachable" });
  });

  it("propagates a failed local fallback", async () => {
    await expect(queryWorktreeSnapshot(
      async () => { throw new Error("scan failed"); },
      endpoint(reply(500)),
    )).rejects.toThrow("scan failed");
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
