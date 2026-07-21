import { Observable, Subject, firstValueFrom, take } from "rxjs";
import { describe, expect, it } from "vitest";
import { claudeUsageV1, claudeUsageV2 } from "../../plugins/metrics/1_v2_definitions";
import { compileAutomationV2, type NetworkResponse } from "./9_v2_runtime";

const response: NetworkResponse = {
  method: "GET",
  pageUrl: "https://claude.ai/new#settings/usage",
  requestUrl: "https://claude.ai/api/organizations/test/usage",
  status: 200,
  ts: 1_784_579_986_984,
  body: {
    five_hour: { utilization: 9, resets_at: "2026-07-20T23:29:59.963706+00:00" },
    seven_day: { utilization: 83, resets_at: "2026-07-23T17:59:59.963733+00:00" },
    extra_usage: { used_credits: 0, monthly_limit: 10_000, utilization: 0, is_enabled: false },
  },
};

const source = "jsonrx://instant/sources/browser/network-response/claude-usage";

describe("automation.v2 runtime", () => {
  it("keeps the v1 Claude rule and emits an equivalent v2 dashboard envelope", async () => {
    const network$ = new Subject<NetworkResponse>();
    const runtime = compileAutomationV2(claudeUsageV2, { [source]: network$ });
    const emission = firstValueFrom(runtime.roots["claude.usage"].pipe(take(1)));
    network$.next(response);

    expect({
      v1: { id: claudeUsageV1.id, mode: claudeUsageV1.mode, stream: claudeUsageV1.emit?.stream },
      v2: { id: claudeUsageV2.id, stream: (await emission).stream, fields: Object.keys((await emission).matches[0]).sort() },
    }).toMatchInlineSnapshot(`
      {
        "v1": {
          "id": "claude-usage",
          "mode": "netcapture",
          "stream": "claude.usage",
        },
        "v2": {
          "fields": [
            "extra_enabled",
            "extra_monthly_limit",
            "extra_percent",
            "extra_used_credits",
            "five_hour_percent",
            "five_hour_resets_at",
            "seven_day_percent",
            "seven_day_resets_at",
          ],
          "id": "jsonrx://instant/automations/claude-usage",
          "stream": "claude.usage",
        },
      }
    `);
  });

  it("shares one source acquisition and releases it after the final subscriber", () => {
    const network$ = new Subject<NetworkResponse>();
    let acquisitions = 0;
    let releases = 0;
    const counted$ = new Observable<NetworkResponse>((subscriber) => {
      acquisitions += 1;
      const subscription = network$.subscribe(subscriber);
      return () => {
        releases += 1;
        subscription.unsubscribe();
      };
    });
    const runtime = compileAutomationV2(claudeUsageV2, { [source]: counted$ });
    const left = runtime.roots["claude.usage"].subscribe();
    const right = runtime.roots["claude.usage"].subscribe();
    left.unsubscribe();
    right.unsubscribe();

    expect({ acquisitions, releases }).toMatchInlineSnapshot(`
      {
        "acquisitions": 1,
        "releases": 1,
      }
    `);
  });
});
