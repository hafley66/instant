import { describe, expect, it, vi } from "vitest";
import claudeUsageRule from "../../src/plugins/metrics/0_claude-usage.rule.json";
import chatgptUsageRule from "../../src/plugins/metrics/0a_chatgpt-usage.rule.json";
import type { BrowserEffectsPort } from "./4_browserEffects";
import type { IntervalPipeSchedule } from "./0_types";
import { createBrowserScheduleRuntime, schedulePeriodMs } from "./5_scheduleRuntime";

const schedule: IntervalPipeSchedule = {
  source: { interval: { periodMs: 300_000 } },
  pipe: [{
    exhaustMap: {
      effect: {
        id: "reload-usage",
        op: "browsingContext.reload",
        input: {
          target: {
            url: "^https://example\\.com/usage$",
            idleForMs: 300_000,
            cardinality: "one",
          },
        },
      },
    },
  }],
};

describe("browser interval pipeline", () => {
  it("reads v2 and legacy host-clock periods", () => {
    expect({
      intervalPipe: schedulePeriodMs(schedule),
      legacy: schedulePeriodMs({ intervalMin: 7 }),
      passive: schedulePeriodMs("passive"),
    }).toMatchInlineSnapshot(`
      {
        "intervalPipe": 300000,
        "legacy": 420000,
        "passive": null,
      }
    `);
  });

  it("ships five-minute interval pipelines for both usage screens", () => {
    const schedules = [claudeUsageRule.schedule, chatgptUsageRule.schedule] as unknown as IntervalPipeSchedule[];
    expect(schedules.map((entry) => ({
      periodMs: schedulePeriodMs(entry),
      operator: entry.pipe[0].exhaustMap.effect.op,
      target: (entry.pipe[0].exhaustMap.effect.input as { target: { url: string } }).target.url,
    }))).toMatchInlineSnapshot(`
      [
        {
          "operator": "browsingContext.reload",
          "periodMs": 300000,
          "target": "^https://claude\\.ai/.*#settings/usage$",
        },
        {
          "operator": "browsingContext.reload",
          "periodMs": 300000,
          "target": "^https://chatgpt\\.com/.*#settings/Usage$",
        },
      ]
    `);
  });

  it("uses exhaustMap to drop a tick while the reload effect is active", async () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const reload = vi.fn(async () => blocked);
    const port: BrowserEffectsPort = {
      contexts: async () => [{
        id: 7,
        url: "https://example.com/usage",
        active: true,
        lastAccessed: 0,
      }],
      reload,
    };
    const events: unknown[] = [];
    const runtime = createBrowserScheduleRuntime(schedule, (event) => events.push(event), port);

    runtime.dispatch("usage");
    await expect.poll(() => reload.mock.calls.length).toBe(1);
    runtime.dispatch("usage");
    release();
    await expect.poll(() => events.length).toBe(1);
    runtime.close();

    const normalizedEvents = events.map((event) => ({
      ...(event as Record<string, unknown>),
      causationId: "usage:<timestamp>",
    }));
    expect({ reloads: reload.mock.calls, events: normalizedEvents }).toMatchInlineSnapshot(`
      {
        "events": [
          {
            "causationId": "usage:<timestamp>",
            "data": {
              "contexts": [
                7,
              ],
              "effectId": "reload-usage",
              "op": "browsingContext.reload",
              "type": "browser.effect.next",
            },
            "type": "browser.effect.next",
          },
        ],
        "reloads": [
          [
            7,
            false,
          ],
        ],
      }
    `);
  });
});
