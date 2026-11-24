import type { Subscription } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const log: string[] = [];
const scans: { resolve(value: unknown): void; reject(error: unknown): void }[] = [];
const sources: { onmessage?: (ev: { data: string }) => void; onerror?: () => void; close(): void }[] = [];

vi.mock("./0_settings", () => ({
  settings: {
    scanRoot: { $: () => " /repos " },
    autoWorktrees: { $: (next?: unknown) => (next ? void log.push(`autoWorktrees ${JSON.stringify(next)}`) : [{ worktree: "/repos/a" }, { worktree: "/repos/z" }]) },
  },
}));
vi.mock("./generated/native", () => ({ invoke: vi.fn() }));
vi.mock("./generated/api", () => ({
  paths: {
    events: {
      connect: () => {
        const source = { close: () => void log.push("sse closed") };
        sources.push(source);
        log.push("sse opened");
        return source;
      },
    },
  },
}));
vi.mock("./state", () => {
  let worktrees: unknown[] = [];
  return {
    store: {
      get: () => ({ worktrees }),
      set: (patch: { worktrees: unknown[] }) => {
        worktrees = patch.worktrees;
        log.push(`rows ${JSON.stringify(worktrees)}`);
      },
    },
  };
});
vi.mock("./ghcacheSnapshot", () => ({
  queryWorktreeSnapshot: () =>
    new Promise((resolve, reject) => {
      log.push("scan started");
      scans.push({ resolve, reject });
    }),
  applyWorktreeDeltaRows: (rows: unknown[], delta: { payload: unknown }) => [...rows, delta.payload],
}));

const { worktreePanelShown, worktreeScanFlow, worktreeScanRequested, worktreeScanSettled } = await import("./1_worktreeScan");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("worktree scan flow", () => {
  let running: Subscription;
  let settled: Subscription;

  beforeEach(() => {
    log.length = 0;
    scans.length = 0;
    sources.length = 0;
    vi.spyOn(console, "error").mockImplementation((...args) => void log.push(`console.error ${args.join(" ")}`));
    settled = worktreeScanSettled.subscribe(() => log.push("settled"));
    running = worktreeScanFlow().subscribe();
  });
  afterEach(() => {
    running.unsubscribe();
    settled.unsubscribe();
  });

  it("swallows requests while a scan runs, applies ghcache deltas, and reconnects after an SSE error", async () => {
    worktreeScanRequested.next();
    worktreeScanRequested.next();
    scans[0].resolve({ rows: [{ worktree: "/repos/a" }], source: "ghcache" });
    await settle();
    sources[0].onmessage?.({ data: JSON.stringify({ entity_type: "worktree", event: "upsert", payload: { worktree: "/repos/b" } }) });
    sources[0].onmessage?.({ data: JSON.stringify({ entity_type: "pr", event: "upsert", payload: {} }) });
    sources[0].onmessage?.({ data: "not json" });
    sources[0].onerror?.();
    worktreeScanRequested.next();
    scans[1].resolve({ rows: [], source: "ghcache" });
    await settle();
    running.unsubscribe();

    expect(log).toMatchInlineSnapshot(`
      [
        "scan started",
        "rows [{"worktree":"/repos/a"}]",
        "autoWorktrees [{"worktree":"/repos/z"}]",
        "sse opened",
        "settled",
        "rows [{"worktree":"/repos/a"},{"worktree":"/repos/b"}]",
        "sse closed",
        "scan started",
        "rows []",
        "sse opened",
        "settled",
        "sse closed",
      ]
    `);
  });

  it("scans on panel show only until one scan has settled, and a failed scan counts", async () => {
    worktreePanelShown.next();
    scans[0].reject(new Error("daemon down"));
    await settle();
    worktreePanelShown.next();
    worktreeScanRequested.next();
    scans[1].resolve({ rows: [{ worktree: "/repos/c" }], source: "local" });
    await settle();

    expect(log).toMatchInlineSnapshot(`
      [
        "scan started",
        "console.error scan_worktrees: Error: daemon down",
        "settled",
        "scan started",
        "rows [{"worktree":"/repos/c"}]",
        "settled",
      ]
    `);
  });
});
