import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { checkStatusProbes, startStatusPolling } from "./statusPolling";

afterEach(() => vi.useRealTimers());

describe("status polling", () => {
  it("loads immediately, refreshes every four seconds, and stops on teardown", async () => {
    vi.useFakeTimers();
    const bus = createEventBus<AppEvents>();
    const check = vi.fn(async () => ({ state: "up" as const }));
    const completed = vi.fn();
    bus.on("status.poll.completed").subscribe(completed);
    const subscription = startStatusPolling(bus, () => [{ id: "a", label: "A", check }]);

    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4000);
    expect(check).toHaveBeenCalledTimes(2);
    expect(completed).toHaveBeenCalledTimes(2);

    subscription.unsubscribe();
    await vi.advanceTimersByTimeAsync(8000);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("converts a failed probe to down without failing sibling probes", async () => {
    const rows = await checkStatusProbes([
      { id: "bad", label: "Bad", check: async () => { throw new Error("boom"); } },
      { id: "good", label: "Good", check: async () => ({ state: "idle" }) },
    ]);
    expect(rows[0]).toMatchObject({ id: "bad", report: { state: "down", detail: "Error: boom" } });
    expect(rows[1].report.state).toBe("idle");
  });

  it("does not overlap polls or accept a late response after teardown", async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const check = vi.fn(() => new Promise<{ state: "up" }>((done) => {
      resolve = () => done({ state: "up" });
    }));
    const bus = createEventBus<AppEvents>();
    const completed = vi.fn();
    bus.on("status.poll.completed").subscribe(completed);
    const subscription = startStatusPolling(bus, () => [{ id: "a", label: "A", check }]);
    await vi.advanceTimersByTimeAsync(8000);
    expect(check).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
  });
});

