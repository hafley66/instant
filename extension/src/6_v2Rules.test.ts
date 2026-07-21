import { describe, expect, it } from "vitest";
import chatgptUsageRule from "../../src/plugins/metrics/0a_chatgpt-usage.rule.json";
import type { Rule } from "./0_types";
import { createV2RuleRuntime, ruleToAutomationV2 } from "./6_v2Rules";

const rule = chatgptUsageRule as unknown as Rule;

describe("v2 rule adapter", () => {
  it("lowers a network rule into an automation.v2 circuit", () => {
    const automation = ruleToAutomationV2(rule);
    expect({
      version: automation.version,
      bindings: automation.bindings,
      flow: automation.circuit.flows["jsonrx://instant/rules/chatgpt-codex-usage/flow"],
      output: automation.outputs[0],
    }).toMatchInlineSnapshot(`
      {
        "bindings": {
          "sources": {
            "jsonrx://instant/rules/chatgpt-codex-usage/network-response": {
              "kind": "browser.network.response",
              "page": {
                "host": "^chatgpt\\.com$",
              },
              "request": {
                "methods": [
                  "GET",
                ],
                "url": "/backend-api/wham/usage",
              },
            },
          },
        },
        "flow": {
          "expression": {
            "node": "chatgpt-codex-usage.share",
            "shareReplay": {
              "bufferSize": 1,
              "input": {
                "node": "chatgpt-codex-usage.project",
                "project": {
                  "fields": {
                    "credit_balance": "$number(credits.balance)",
                    "has_credits": "credits.has_credits",
                    "plan_type": "plan_type",
                    "primary_percent": "rate_limit.primary_window.used_percent",
                    "primary_resets_at": "$fromMillis(rate_limit.primary_window.reset_at * 1000)",
                    "provider": "'Codex'",
                    "reset_credits_available": "rate_limit_reset_credits.available_count",
                    "secondary_percent": "rate_limit.secondary_window.used_percent",
                    "secondary_resets_at": "$fromMillis(rate_limit.secondary_window.reset_at * 1000)",
                    "spark_percent": "additional_rate_limits[limit_name='GPT-5.3-Codex-Spark'].rate_limit.primary_window.used_percent",
                    "spark_resets_at": "$fromMillis(additional_rate_limits[limit_name='GPT-5.3-Codex-Spark'].rate_limit.primary_window.reset_at * 1000)",
                  },
                  "from": "$.body",
                  "input": {
                    "node": "chatgpt-codex-usage.source",
                    "source": {
                      "ref": "jsonrx://instant/rules/chatgpt-codex-usage/network-response",
                    },
                  },
                  "language": "jsonata",
                },
              },
              "refCount": true,
            },
          },
        },
        "output": {
          "flow": "jsonrx://instant/rules/chatgpt-codex-usage/flow",
          "kind": "instant.dashboard.emit",
          "schema": {
            "properties": {
              "credit_balance": {
                "title": "Credit balance",
                "type": "number",
              },
              "has_credits": {
                "title": "Credits available",
                "type": "boolean",
              },
              "plan_type": {
                "title": "Plan",
                "type": "string",
              },
              "primary_percent": {
                "maximum": 100,
                "minimum": 0,
                "title": "Primary usage",
                "type": "number",
              },
              "primary_resets_at": {
                "format": "date-time",
                "title": "Primary reset",
                "type": "string",
              },
              "provider": {
                "title": "Provider",
                "type": "string",
              },
              "reset_credits_available": {
                "title": "Reset credits available",
                "type": "number",
              },
              "secondary_percent": {
                "maximum": 100,
                "minimum": 0,
                "title": "Secondary usage",
                "type": "number",
              },
              "secondary_resets_at": {
                "format": "date-time",
                "title": "Secondary reset",
                "type": "string",
              },
              "spark_percent": {
                "maximum": 100,
                "minimum": 0,
                "title": "Codex Spark usage",
                "type": "number",
              },
              "spark_resets_at": {
                "format": "date-time",
                "title": "Codex Spark reset",
                "type": "string",
              },
            },
            "type": "object",
          },
          "stream": "codex.usage",
        },
        "version": "automation.v2",
      }
    `);
  });

  it("runs the ChatGPT response through the v2 compiler", async () => {
    const emissions: unknown[] = [];
    const traces: unknown[] = [];
    const runtime = createV2RuleRuntime(rule, {
      emission: (_rule, emission) => emissions.push(emission),
      traces: (_rule, entries) => traces.push(...entries),
    });
    runtime.next({
      method: "GET",
      pageUrl: "https://chatgpt.com/#settings/Usage",
      requestUrl: "https://chatgpt.com/backend-api/wham/usage",
      status: 200,
      ts: 1,
      body: {
        plan_type: "prolite",
        rate_limit: { primary_window: { used_percent: 89, reset_at: 1_784_949_856 }, secondary_window: null },
        additional_rate_limits: [],
        credits: { has_credits: false, balance: "0" },
        rate_limit_reset_credits: { available_count: 2 },
      },
    });
    await expect.poll(() => emissions).toHaveLength(1);
    runtime.close();

    expect({ emissions, traceCount: traces.length }).toMatchInlineSnapshot(`
      {
        "emissions": [
          {
            "matches": [
              {
                "credit_balance": 0,
                "has_credits": false,
                "plan_type": "prolite",
                "primary_percent": 89,
                "primary_resets_at": "2026-07-25T03:24:16.000Z",
                "provider": "Codex",
                "reset_credits_available": 2,
              },
            ],
            "ruleId": "chatgpt-codex-usage",
            "schema": {
              "properties": {
                "credit_balance": {
                  "title": "Credit balance",
                  "type": "number",
                },
                "has_credits": {
                  "title": "Credits available",
                  "type": "boolean",
                },
                "plan_type": {
                  "title": "Plan",
                  "type": "string",
                },
                "primary_percent": {
                  "maximum": 100,
                  "minimum": 0,
                  "title": "Primary usage",
                  "type": "number",
                },
                "primary_resets_at": {
                  "format": "date-time",
                  "title": "Primary reset",
                  "type": "string",
                },
                "provider": {
                  "title": "Provider",
                  "type": "string",
                },
                "reset_credits_available": {
                  "title": "Reset credits available",
                  "type": "number",
                },
                "secondary_percent": {
                  "maximum": 100,
                  "minimum": 0,
                  "title": "Secondary usage",
                  "type": "number",
                },
                "secondary_resets_at": {
                  "format": "date-time",
                  "title": "Secondary reset",
                  "type": "string",
                },
                "spark_percent": {
                  "maximum": 100,
                  "minimum": 0,
                  "title": "Codex Spark usage",
                  "type": "number",
                },
                "spark_resets_at": {
                  "format": "date-time",
                  "title": "Codex Spark reset",
                  "type": "string",
                },
              },
              "type": "object",
            },
            "stream": "codex.usage",
            "ts": 1,
            "url": "https://chatgpt.com/#settings/Usage",
          },
        ],
        "traceCount": 11,
      }
    `);
  });
});
