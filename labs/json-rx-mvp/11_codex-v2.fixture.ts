import type { AutomationV2 } from "./7_v2-schema";

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
    sources: {
      [snapshotSource]: {},
      [updateSource]: {},
    },
    machines: {
      [machineRef]: {
        initial: {
          value: "loading",
          context: {
            provider: "Codex",
            primary_percent: null,
            primary_resets_at: null,
            secondary_percent: null,
            secondary_resets_at: null,
            credit_balance: null,
            has_credits: null,
            plan_type: null,
          },
        },
        on: {
          "codex.usage.snapshot": {
            target: "ready",
            replaceContext: "$.data",
          },
          "codex.usage.updated": {
            target: "ready",
            patchContext: {
              primary_percent: "$.data.primary_percent",
              primary_resets_at: "$.data.primary_resets_at",
            },
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
                fields: Object.fromEntries(
                  Object.keys(codexUsageSchema.properties).map((field) => [field, `$.${field}`]),
                ),
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
  outputs: [
    {
      kind: "instant.dashboard.emit",
      flow: flowRef,
      stream: "codex.usage",
      schema: codexUsageSchema,
    },
  ],
} satisfies AutomationV2;
