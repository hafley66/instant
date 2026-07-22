import { Subject, type Subscription } from "rxjs";
import {
  compileAutomationV2,
  type AutomationV2,
  type AutomationV2Trace,
  type DashboardEmission,
  type NetworkResponse,
} from "@hafley66/json-rx";
import type { ExpressionTrace, Rule } from "./0_types";

export type V2RuleRuntime = {
  next: (response: NetworkResponse) => void;
  close: () => void;
};

export type V2RuleCallbacks = {
  emission: (rule: Rule, emission: DashboardEmission) => void;
  traces: (rule: Rule, traces: ExpressionTrace[]) => void;
};

function sourceRef(rule: Rule): string {
  return `jsonrx://instant/rules/${encodeURIComponent(rule.id)}/network-response`;
}

function flowRef(rule: Rule): string {
  return `jsonrx://instant/rules/${encodeURIComponent(rule.id)}/flow`;
}

export function ruleToAutomationV2(rule: Rule): AutomationV2 {
  if (rule.mode !== "netcapture" || !rule.response?.extract || !rule.emit) {
    throw new Error(`Rule cannot lower to a v2 network automation: ${rule.id}`);
  }
  const source = sourceRef(rule);
  const flow = flowRef(rule);
  return {
    version: "automation.v2",
    profile: "rxjs-7.8",
    id: `jsonrx://instant/rules/${encodeURIComponent(rule.id)}`,
    enabled: rule.enabled !== false,
    bindings: {
      sources: {
        [source]: {
          kind: "browser.network.response",
          page: { host: rule.host },
          request: {
            methods: rule.request?.methods ?? ["GET"],
            url: rule.request?.url ?? rule.url ?? ".*",
          },
        },
      },
      hosts: {},
    },
    circuit: {
      sources: { [source]: {} },
      reducers: {},
      flows: {
        [flow]: {
          expression: {
            node: `${rule.id}.share`,
            shareReplay: {
              bufferSize: 1,
              refCount: true,
              input: {
                node: `${rule.id}.map`,
                map: {
                  input: { node: `${rule.id}.source`, source: { ref: source } },
                  from: "$.body",
                  language: "jsonata",
                  fields: rule.response.extract,
                },
              },
            },
          },
        },
      },
    },
    outputs: [{
      kind: "instant.dashboard.emit",
      flow,
      stream: rule.emit.stream,
      schema: (rule.emit.schema ?? { type: "object" }) as Record<string, unknown>,
    }],
  };
}

function extensionTrace(rule: Rule, trace: AutomationV2Trace): ExpressionTrace {
  return {
    ruleId: rule.id,
    phase: "extract",
    path: trace.path,
    language: trace.language,
    expression: trace.expression,
    outcome: trace.outcome,
    ...(trace.result !== undefined ? { result: trace.result } : {}),
    ...(trace.reason ? { reason: trace.reason } : {}),
  };
}

export function createV2RuleRuntime(rule: Rule, callbacks: V2RuleCallbacks): V2RuleRuntime {
  const source = sourceRef(rule);
  const responses = new Subject<NetworkResponse>();
  let traces: ExpressionTrace[] = [];
  const runtime = compileAutomationV2(ruleToAutomationV2(rule), { [source]: responses }, {
    trace: (entry) => {
      if (rule.diagnostics === "all" || (rule.diagnostics === "errors" && entry.outcome !== "passed")) {
        traces.push(extensionTrace(rule, entry));
      }
    },
  });
  const subscriptions: Subscription[] = Object.values(runtime.roots).map((root) => root.subscribe({
    next: (emission) => {
      if (traces.length) callbacks.traces(rule, traces);
      traces = [];
      callbacks.emission(rule, { ...emission, ruleId: rule.id });
    },
  }));
  return {
    next: (response) => responses.next(response),
    close: () => {
      for (const subscription of subscriptions) subscription.unsubscribe();
      responses.complete();
    },
  };
}
