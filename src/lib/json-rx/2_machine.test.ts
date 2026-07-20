import { firstValueFrom, of, toArray } from "rxjs";
import { describe, expect, it } from "vitest";
import { runMachine } from "./2_machine";
import type { Machine } from "./0_types";

const machine: Machine = {
  initial: { value: "watching", count: 0 },
  transition: (state, event) => {
    if (event.type !== "tick") return {};
    return {
      updates: [
        {
          op: "set",
          path: "/count",
          value: Number(state.count ?? 0) + 1,
        },
      ],
      events: [
        {
          type: "tick.handled",
          data: { count: Number(state.count ?? 0) + 1 },
        },
      ],
    };
  },
};

describe("json-rx machine scan", () => {
  it("reduces events into state and emitted events", async () => {
    const emissions = await firstValueFrom(
      runMachine(
        of(
          { type: "tick", data: {} },
          { type: "tick", data: {} },
        ),
        machine,
      ).pipe(toArray()),
    );

    expect(emissions).toMatchInlineSnapshot(`
      [
        {
          "effects": [],
          "event": {
            "data": {},
            "type": "tick",
          },
          "events": [
            {
              "data": {
                "count": 1,
              },
              "type": "tick.handled",
            },
          ],
          "state": {
            "count": 1,
            "value": "watching",
          },
        },
        {
          "effects": [],
          "event": {
            "data": {},
            "type": "tick",
          },
          "events": [
            {
              "data": {
                "count": 2,
              },
              "type": "tick.handled",
            },
          ],
          "state": {
            "count": 2,
            "value": "watching",
          },
        },
      ]
    `);
  });
});
