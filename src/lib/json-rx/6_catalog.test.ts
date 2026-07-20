import { firstValueFrom, of, toArray } from "rxjs";
import { describe, expect, it } from "vitest";
import { createJsonRxCatalog } from "./6_catalog";
import { runMachine } from "./2_machine";

describe("json-rx reusable definitions", () => {
  it("resolves a fresh machine for a reusable reference", async () => {
    const catalog = createJsonRxCatalog([
      {
        id: "counter",
        create: () => ({
          initial: { value: "ready", count: 0 },
          transition: (state) => ({
            updates: [{ op: "set", path: "/count", value: Number(state.count ?? 0) + 1 }],
          }),
        }),
      },
    ]);
    const machine = catalog.machine({ ref: "counter" });
    const emissions = await firstValueFrom(
      of(
        { type: "tick", data: {} },
        { type: "tick", data: {} },
      ).pipe(
        (events$) => runMachine(events$, machine),
        toArray(),
      ),
    );

    expect(emissions.map((emission) => emission.state.count)).toMatchInlineSnapshot(`
      [
        1,
        2,
      ]
    `);
  });
});
