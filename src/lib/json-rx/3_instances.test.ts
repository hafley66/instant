import { firstValueFrom, from, toArray } from "rxjs";
import { describe, expect, it } from "vitest";
import { runPartitionedMachine } from "./3_instances";
import type { Machine } from "./0_types";

describe("json-rx partitioned machines", () => {
  it("keeps state independent per partition key", async () => {
    const machine: Machine = {
      initial: { value: "watching", count: 0 },
      transition: (state) => ({
        updates: [{ op: "set", path: "/count", value: Number(state.count ?? 0) + 1 }],
      }),
    };
    const emissions = await firstValueFrom(
      runPartitionedMachine(
        from([
          { type: "tick", data: {}, partitionKey: "a" },
          { type: "tick", data: {}, partitionKey: "b" },
          { type: "tick", data: {}, partitionKey: "a" },
        ]),
        (event) => event.partitionKey ?? "global",
        machine,
      ).pipe(toArray()),
    );

    expect(emissions.map(({ partitionKey, state }) => ({ partitionKey, count: state.count })))
      .toMatchInlineSnapshot(`
        [
          {
            "count": 1,
            "partitionKey": "a",
          },
          {
            "count": 1,
            "partitionKey": "b",
          },
          {
            "count": 2,
            "partitionKey": "a",
          },
        ]
      `);
  });
});
