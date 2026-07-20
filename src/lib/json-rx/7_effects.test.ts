import { filter, firstValueFrom } from "rxjs";
import { describe, expect, test, vi } from "vitest";
import type { Machine } from "./0_types";
import { createEffectMachineRuntime } from "./7_effects";

const machine: Machine = {
  initial: { value: "idle", completed: 0 },
  transition: (state, event) => {
    if (event.type === "schedule.tick") {
      return {
        updates: [{ op: "set", path: "/value", value: "running" }],
        effects: [{ id: "reload", op: "browsingContext.reload", input: { target: { url: "example" } } }],
      };
    }
    if (event.type === "browser.effect.next") {
      return {
        updates: [
          { op: "set", path: "/value", value: "idle" },
          { op: "set", path: "/completed", value: Number(state.completed) + 1 },
        ],
      };
    }
    return {};
  },
};

describe("JSON-Rx effect machine runtime", () => {
  test("interprets effects sequentially and feeds correlated results into the same machine", async () => {
    const interpret = vi.fn(async (effect, cause) => ({
      type: "browser.effect.next",
      causationId: effect.id ?? cause.id,
      data: { contexts: [42] },
    }));
    const runtime = createEffectMachineRuntime(machine, interpret);
    const result = firstValueFrom(runtime.emissions$.pipe(
      filter((emission) => emission.event.type === "browser.effect.next"),
    ));

    runtime.dispatch({ type: "schedule.tick", id: "tick-1", data: {} });

    await expect(result).resolves.toMatchInlineSnapshot(`
      {
        "effects": [],
        "event": {
          "causationId": "reload",
          "data": {
            "contexts": [
              42,
            ],
          },
          "type": "browser.effect.next",
        },
        "events": [],
        "state": {
          "completed": 1,
          "value": "idle",
        },
      }
    `);
    expect(interpret.mock.calls).toMatchInlineSnapshot(`
      [
        [
          {
            "id": "reload",
            "input": {
              "target": {
                "url": "example",
              },
            },
            "op": "browsingContext.reload",
          },
          {
            "data": {},
            "id": "tick-1",
            "type": "schedule.tick",
          },
        ],
      ]
    `);
    runtime.close();
  });
});
