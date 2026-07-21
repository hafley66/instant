import { Subject, lastValueFrom, merge, take, toArray } from "rxjs";
import { describe, expect, it } from "vitest";
import { compileAutomationV2, type HostEvent, type NetworkResponse } from "./8_v2-runtime";
import { claudeUsageV2 } from "./9_claude-v2.fixture";
import { codexUsageV2 } from "./11_codex-v2.fixture";

const snapshotSource = "jsonrx://instant/sources/codex/rate-limits-read";
const updateSource = "jsonrx://instant/sources/codex/rate-limits-updated";
const claudeSource = "jsonrx://instant/sources/browser/network-response/claude-usage";

const snapshot: HostEvent = {
  type: "codex.usage.snapshot",
  url: "codex-app-server://account/rateLimits/read",
  ts: 1_784_580_000_000,
  data: {
    provider: "Codex",
    primary_percent: 31,
    primary_resets_at: "2026-07-20T23:00:00.000Z",
    secondary_percent: 64,
    secondary_resets_at: "2026-07-23T18:00:00.000Z",
    credit_balance: 18.5,
    has_credits: true,
    plan_type: "plus",
  },
};

const update: HostEvent = {
  type: "codex.usage.updated",
  url: "codex-app-server://account/rateLimits/updated",
  ts: 1_784_580_030_000,
  data: {
    primary_percent: 33,
    primary_resets_at: "2026-07-20T23:00:00.000Z",
  },
};

const claudeResponse: NetworkResponse = {
  method: "GET",
  pageUrl: "https://claude.ai/new#settings/usage",
  requestUrl: "https://claude.ai/api/organizations/test/usage",
  status: 200,
  ts: 1_784_580_020_000,
  body: {
    five_hour: { utilization: 10, resets_at: "2026-07-20T23:30:00.000Z" },
    seven_day: { utilization: 83, resets_at: "2026-07-23T18:00:00.000Z" },
    extra_usage: { used_credits: 0, monthly_limit: 10_000, utilization: 0, is_enabled: false },
  },
};

describe("Codex usage scan", () => {
  it("keeps sparse updates complete when they arrive before a snapshot", async () => {
    const snapshots$ = new Subject<HostEvent>();
    const updates$ = new Subject<HostEvent>();
    const runtime = compileAutomationV2(codexUsageV2, {
      [snapshotSource]: snapshots$,
      [updateSource]: updates$,
    });
    const emission = lastValueFrom(runtime.roots["codex.usage"].pipe(take(1)));

    updates$.next(update);

    expect((await emission).matches[0]).toMatchInlineSnapshot(`
      {
        "credit_balance": null,
        "has_credits": null,
        "plan_type": null,
        "primary_percent": 33,
        "primary_resets_at": "2026-07-20T23:00:00.000Z",
        "provider": "Codex",
        "secondary_percent": null,
        "secondary_resets_at": null,
      }
    `);
  });

  it("replaces the accumulator from a snapshot and patches it from an update", async () => {
    const snapshots$ = new Subject<HostEvent>();
    const updates$ = new Subject<HostEvent>();
    const runtime = compileAutomationV2(codexUsageV2, {
      [snapshotSource]: snapshots$,
      [updateSource]: updates$,
    });
    const emissions = lastValueFrom(runtime.roots["codex.usage"].pipe(take(2), toArray()));

    snapshots$.next(snapshot);
    updates$.next(update);

    expect(await emissions).toMatchInlineSnapshot(`
      [
        {
          "matches": [
            {
              "credit_balance": 18.5,
              "has_credits": true,
              "plan_type": "plus",
              "primary_percent": 31,
              "primary_resets_at": "2026-07-20T23:00:00.000Z",
              "provider": "Codex",
              "secondary_percent": 64,
              "secondary_resets_at": "2026-07-23T18:00:00.000Z",
            },
          ],
          "ruleId": "jsonrx://instant/automations/codex-usage",
          "schema": {
            "properties": {
              "credit_balance": {
                "title": "Credit balance",
                "type": [
                  "number",
                  "null",
                ],
              },
              "has_credits": {
                "title": "Credits available",
                "type": [
                  "boolean",
                  "null",
                ],
              },
              "plan_type": {
                "title": "Plan",
                "type": [
                  "string",
                  "null",
                ],
              },
              "primary_percent": {
                "maximum": 100,
                "minimum": 0,
                "title": "Primary usage",
                "type": [
                  "number",
                  "null",
                ],
              },
              "primary_resets_at": {
                "format": "date-time",
                "title": "Primary reset",
                "type": [
                  "string",
                  "null",
                ],
              },
              "provider": {
                "title": "Provider",
                "type": "string",
              },
              "secondary_percent": {
                "maximum": 100,
                "minimum": 0,
                "title": "Secondary usage",
                "type": [
                  "number",
                  "null",
                ],
              },
              "secondary_resets_at": {
                "format": "date-time",
                "title": "Secondary reset",
                "type": [
                  "string",
                  "null",
                ],
              },
            },
            "type": "object",
          },
          "stream": "codex.usage",
          "ts": 1784580000000,
          "url": "codex-app-server://account/rateLimits/read",
        },
        {
          "matches": [
            {
              "credit_balance": 18.5,
              "has_credits": true,
              "plan_type": "plus",
              "primary_percent": 33,
              "primary_resets_at": "2026-07-20T23:00:00.000Z",
              "provider": "Codex",
              "secondary_percent": 64,
              "secondary_resets_at": "2026-07-23T18:00:00.000Z",
            },
          ],
          "ruleId": "jsonrx://instant/automations/codex-usage",
          "schema": {
            "properties": {
              "credit_balance": {
                "title": "Credit balance",
                "type": [
                  "number",
                  "null",
                ],
              },
              "has_credits": {
                "title": "Credits available",
                "type": [
                  "boolean",
                  "null",
                ],
              },
              "plan_type": {
                "title": "Plan",
                "type": [
                  "string",
                  "null",
                ],
              },
              "primary_percent": {
                "maximum": 100,
                "minimum": 0,
                "title": "Primary usage",
                "type": [
                  "number",
                  "null",
                ],
              },
              "primary_resets_at": {
                "format": "date-time",
                "title": "Primary reset",
                "type": [
                  "string",
                  "null",
                ],
              },
              "provider": {
                "title": "Provider",
                "type": "string",
              },
              "secondary_percent": {
                "maximum": 100,
                "minimum": 0,
                "title": "Secondary usage",
                "type": [
                  "number",
                  "null",
                ],
              },
              "secondary_resets_at": {
                "format": "date-time",
                "title": "Secondary reset",
                "type": [
                  "string",
                  "null",
                ],
              },
            },
            "type": "object",
          },
          "stream": "codex.usage",
          "ts": 1784580030000,
          "url": "codex-app-server://account/rateLimits/updated",
        },
      ]
    `);
  });

  it("feeds Claude and Codex emissions into one dashboard row stream", async () => {
    const claude$ = new Subject<NetworkResponse>();
    const snapshots$ = new Subject<HostEvent>();
    const updates$ = new Subject<HostEvent>();
    const claude = compileAutomationV2(claudeUsageV2, { [claudeSource]: claude$ });
    const codex = compileAutomationV2(codexUsageV2, {
      [snapshotSource]: snapshots$,
      [updateSource]: updates$,
    });
    const rows = lastValueFrom(
      merge(claude.roots["claude.usage"], codex.roots["codex.usage"]).pipe(take(2), toArray()),
    );

    snapshots$.next(snapshot);
    claude$.next(claudeResponse);

    expect((await rows).map((row) => ({
      stream: row.stream,
      url: row.url,
      fields: Object.keys(row.matches[0]).sort(),
    }))).toMatchInlineSnapshot(`
      [
        {
          "fields": [
            "credit_balance",
            "has_credits",
            "plan_type",
            "primary_percent",
            "primary_resets_at",
            "provider",
            "secondary_percent",
            "secondary_resets_at",
          ],
          "stream": "codex.usage",
          "url": "codex-app-server://account/rateLimits/read",
        },
        {
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
          "stream": "claude.usage",
          "url": "https://claude.ai/new#settings/usage",
        },
      ]
    `);
  });
});
