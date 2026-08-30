import { describe, it, expect, vi } from "vitest";

vi.stubGlobal("location", { search: "", hash: "" });
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const { candidateSessions, CANDIDATE_WINDOW_MS } = await import("./favorites");

const turn = (session: string, ts: number) => ({ session, harness: "codex", turn: 1, ts, role: "assistant", said: "x" });

describe("candidate sessions survive a harness whose ingestion trails", () => {
  it("asks the window first and stops there when it answers", async () => {
    const asked: number[] = [];
    const rows = await candidateSessions(async (since) => {
      asked.push(since);
      return [turn("a", 10), turn("b", 20), turn("a", 30)];
    }, 1_000_000_000);
    expect(rows).toEqual(["a", "b"]);
    expect(asked).toEqual([1_000_000_000 - CANDIDATE_WINDOW_MS]);
  });

  // The real case: codex's newest turn was 45 minutes old while the window was
  // 15, so every candidate was filtered out and the overlay had nothing to match.
  it("retries with no floor when the window comes back empty", async () => {
    const asked: number[] = [];
    const rows = await candidateSessions(async (since) => {
      asked.push(since);
      return since === 0 ? [turn("stale", 1)] : [];
    }, 1_000_000_000);
    expect(rows).toEqual(["stale"]);
    expect(asked).toEqual([1_000_000_000 - CANDIDATE_WINDOW_MS, 0]);
  });

  it("holds a window wide enough for the measured codex lag", () => {
    expect(CANDIDATE_WINDOW_MS).toBeGreaterThan(45 * 60 * 1000);
  });

  it("reports nothing when the harness has no turns at all", async () => {
    expect(await candidateSessions(async () => [])).toEqual([]);
  });
});
