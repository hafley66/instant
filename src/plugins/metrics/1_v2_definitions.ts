import claudeUsageRule from "./0_claude-usage.rule.json";
import {
  CODEX_HOST_URLS,
  CODEX_HOST_STATUS,
  codexHostSources,
  CodexUsageSchema,
  type CodexHostAdapter,
} from "../../lib/json-rx/10_codex_host";
import {
  compileAutomationV2,
  type AutomationV2Runtime,
} from "../../lib/json-rx/9_v2_runtime";
import type { AutomationV2 } from "../../lib/json-rx/8_v2_schema";

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
        request: { methods: ["GET"], url: "/api/organizations/[^/]+/usage" },
      },
    },
  },
  circuit: {
    sources: { "jsonrx://instant/sources/browser/network-response/claude-usage": {} },
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
                  source: { ref: "jsonrx://instant/sources/browser/network-response/claude-usage" },
                },
                from: "$.body",
                fields: Object.fromEntries(
                  Object.entries(claudeUsageRule.response.extract).map(([field, path]) => [field, `$.${path}`]),
                ),
              },
            },
          },
        },
      },
    },
    machines: {},
  },
  outputs: [{
    kind: "instant.dashboard.emit",
    flow: "jsonrx://instant/flows/claude-usage",
    stream: claudeUsageRule.emit.stream,
    schema: claudeUsageRule.emit.schema,
  }],
} satisfies AutomationV2;

export const codexUsageSchema = {
  type: "object",
  properties: {
    provider: { type: "string", title: "Provider" },
    primary_percent: { type: ["number", "null"], title: "Primary usage", minimum: 0, maximum: 100 },
    primary_resets_at: { type: ["string", "null"], format: "date-time", title: "Primary reset" },
    secondary_percent: { type: ["number", "null"], title: "Secondary usage", minimum: 0, maximum: 100 },
    secondary_resets_at: { type: ["string", "null"], format: "date-time", title: "Secondary reset" },
    credit_balance: { type: ["number", "null"], title: "Credit balance" },
    has_credits: { type: ["boolean", "null"], title: "Credits available" },
    plan_type: { type: ["string", "null"], title: "Plan" },
  },
};

const snapshotSource = "jsonrx://instant/sources/codex/rate-limits-read";
const updateSource = "jsonrx://instant/sources/codex/rate-limits-updated";
const machineRef = "jsonrx://instant/machines/codex-usage";
const flowRef = "jsonrx://instant/flows/codex-usage";
const codexFields = Object.keys(codexUsageSchema.properties);

export const codexUsageV2 = {
  version: "automation.v2",
  profile: "rxjs-7.8",
  id: "jsonrx://instant/automations/codex-usage",
  enabled: true,
  bindings: {
    sources: {
      [snapshotSource]: { kind: "host.event", operation: "account/rateLimits/read" },
      [updateSource]: { kind: "host.event", operation: "account/rateLimits/updated" },
    },
  },
  circuit: {
    sources: { [snapshotSource]: {}, [updateSource]: {} },
    machines: {
      [machineRef]: {
        initial: {
          value: "loading",
          context: Object.fromEntries(codexFields.map((field) => [field, field === "provider" ? "Codex" : null])),
        },
        on: {
          "codex.usage.snapshot": {
            target: "ready",
            replaceContext: "$.data",
          },
          "codex.usage.updated": {
            target: "ready",
            patchContext: Object.fromEntries(codexFields.map((field) => [field, `$.data.${field}`])),
          },
        },
      },
    },
    flows: {
      [flowRef]: {
        expression: {
          node: "codex-usage.share",
          shareReplay: {
            bufferSize: 1,
            refCount: true,
            input: {
              node: "codex-usage.project-context",
              project: {
                from: "$.context",
                fields: Object.fromEntries(codexFields.map((field) => [field, `$.${field}`])),
                input: {
                  node: "codex-usage.machine",
                  machine: {
                    ref: machineRef,
                    input: {
                      node: "codex-usage.events",
                      merge: {
                        inputs: [
                          { node: "codex-usage.snapshot-source", source: { ref: snapshotSource } },
                          { node: "codex-usage.update-source", source: { ref: updateSource } },
                        ],
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  outputs: [{ kind: "instant.dashboard.emit", flow: flowRef, stream: "codex.usage", schema: codexUsageSchema }],
} satisfies AutomationV2;

export const codexSourceRefs = { snapshot: snapshotSource, updated: updateSource } as const;

export function compileCodexUsage(host: CodexHostAdapter, now: () => number = Date.now): AutomationV2Runtime {
  const sources = codexHostSources(host, now);
  return compileAutomationV2(codexUsageV2, {
    [snapshotSource]: sources.snapshot,
    [updateSource]: sources.updated,
  });
}

export { CODEX_HOST_STATUS, CODEX_HOST_URLS, CodexUsageSchema };
