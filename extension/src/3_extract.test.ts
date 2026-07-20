import { describe, expect, it } from "vitest";
import { extractResponse } from "./3_extract";

describe("extractResponse", () => {
  it("maps JSONata expressions into metric fields", async () => {
    const out = await extractResponse(
      {
        id: "usage",
        host: "claude\\.ai",
        mode: "netcapture",
        response: {
          extract: {
            percent: "five_hour.utilization * 100",
            reset: "five_hour.resets_at",
          },
        },
        enabled: true,
      },
      { five_hour: { utilization: 0.42, resets_at: "later" } },
    );
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "percent": 42,
          "reset": "later",
        },
      ]
    `);
  });
});
