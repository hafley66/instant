import claudeUsageRule from "../../src/plugins/metrics/0_claude-usage.rule.json";
import type { AutomationV2 } from "./7_v2-schema";

export const claudeUsageV1 = claudeUsageRule;

export const claudeUsageV2 = {
  version: "automation.v2",
  profile: "rxjs-7.8",
  id: "jsonrx://instant/automations/claude-usage",
  enabled: true,
  bindings: {
    sources: {
      "jsonrx://instant/sources/browser/network-response/claude-usage": {
        kind: "browser.network.response",
        page: { host: "^claude\\.ai$" },
        request: {
          methods: ["GET"],
          url: "/api/organizations/[^/]+/usage",
        },
      },
    },
  },
  circuit: {
    reducers: {},
    sources: {
      "jsonrx://instant/sources/browser/network-response/claude-usage": {},
    },
    flows: {
      "jsonrx://instant/flows/claude-usage": {
        expression: {
          node: "claude-usage.share",
          shareReplay: {
            bufferSize: 1,
            refCount: true,
            input: {
              node: "claude-usage.project",
              project: {
                input: {
                  node: "claude-usage.network-response",
                  source: {
                    ref: "jsonrx://instant/sources/browser/network-response/claude-usage",
                  },
                },
                from: "$.body",
                language: "jsonata",
                fields: Object.fromEntries(
                  Object.entries(claudeUsageRule.response.extract).map(([field, path]) => [field, path]),
                ),
              },
            },
          },
        },
      },
    },
  },
  outputs: [
    {
      kind: "instant.dashboard.emit",
      flow: "jsonrx://instant/flows/claude-usage",
      stream: claudeUsageRule.emit.stream,
      schema: claudeUsageRule.emit.schema,
    },
  ],
} satisfies AutomationV2;
