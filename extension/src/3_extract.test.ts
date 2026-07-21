import { describe, expect, it } from "vitest";
import { extractResponse } from "./3_extract";
import chatgptUsageRule from "../../src/plugins/metrics/0a_chatgpt-usage.rule.json";
import type { Rule } from "./0_types";

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

  it("extracts the ChatGPT usage response captured in the HAR", async () => {
    const out = await extractResponse(chatgptUsageRule as unknown as Rule, {
      plan_type: "prolite",
      rate_limit: {
        primary_window: { used_percent: 89, reset_at: 1_784_949_856 },
        secondary_window: null,
      },
      additional_rate_limits: [{
        limit_name: "GPT-5.3-Codex-Spark",
        rate_limit: { primary_window: { used_percent: 0, reset_at: 1_785_204_885 } },
      }],
      credits: { has_credits: false, balance: "0" },
      rate_limit_reset_credits: { available_count: 2 },
    });

    expect(out).toMatchInlineSnapshot(`
      [
        {
          "credit_balance": 0,
          "has_credits": false,
          "plan_type": "prolite",
          "primary_percent": 89,
          "primary_resets_at": "2026-07-25T03:24:16.000Z",
          "provider": "Codex",
          "reset_credits_available": 2,
          "spark_percent": 0,
          "spark_resets_at": "2026-07-28T02:14:45.000Z",
        },
      ]
    `);
  });
});
