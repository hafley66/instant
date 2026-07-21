import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetricMatch } from "./0_types";
import { createMetricsDashboardState } from "./2_runtime";

describe("metrics dashboard polling", () => {
  afterEach(() => vi.useRealTimers());

  it("loads immediately and then every five seconds while subscribed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const load = vi.fn(async (): Promise<MetricMatch[]> => []);
    const states: Array<{ value: string; refreshedAt: number | null }> = [];
    const subscription = createMetricsDashboardState(load).subscribe((state) => {
      states.push({ value: state.value as string, refreshedAt: state.refreshedAt as number | null });
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(4_999);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(5_000);
    subscription.unsubscribe();
    await vi.advanceTimersByTimeAsync(5_000);

    expect({ calls: load.mock.calls.length, states }).toMatchInlineSnapshot(`
      {
        "calls": 3,
        "states": [
          {
            "refreshedAt": 0,
            "value": "empty",
          },
          {
            "refreshedAt": 5000,
            "value": "empty",
          },
          {
            "refreshedAt": 10000,
            "value": "empty",
          },
        ],
      }
    `);
  });
});
