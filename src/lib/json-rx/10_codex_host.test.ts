import { Subject, firstValueFrom, take, toArray } from "rxjs";
import { describe, expect, it } from "vitest";
import {
  createFakeCodexHostAdapter,
  normalizeCodexRateLimits,
  normalizeCodexRateLimitsUpdate,
  type CodexHostAdapter,
  type CodexRateLimitsSnapshot,
  type CodexRateLimitsUpdate,
} from "./10_codex_host";
import { compileCodexUsage } from "../../plugins/metrics/1_v2_definitions";

const snapshot: CodexRateLimitsSnapshot = {
  provider: "Codex",
  primary_percent: 31,
  primary_resets_at: "2026-07-20T23:00:00.000Z",
  secondary_percent: 64,
  secondary_resets_at: "2026-07-23T18:00:00.000Z",
  credit_balance: 18.5,
  has_credits: true,
  plan_type: "plus",
};

describe("Codex host boundary", () => {
  it("acquires the snapshot operation when the dashboard root subscribes", () => {
    let reads = 0;
    const host: CodexHostAdapter = {
      rateLimitsRead: () => {
        reads += 1;
        return new Subject<CodexRateLimitsSnapshot>();
      },
      rateLimitsUpdated$: new Subject<CodexRateLimitsUpdate>(),
    };
    const runtime = compileCodexUsage(host);
    const beforeSubscription = reads;
    const subscription = runtime.roots["codex.usage"].subscribe();
    const whileSubscribed = reads;
    subscription.unsubscribe();

    expect({ beforeSubscription, whileSubscribed }).toMatchInlineSnapshot(`
      {
        "beforeSubscription": 0,
        "whileSubscribed": 1,
      }
    `);
  });

  it("normalizes the Codex rate-limits response and sparse update", () => {
    expect({
      snapshot: normalizeCodexRateLimits({
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 31, resetsAt: 1_784_580_000 },
            secondary: { used_percent: 64, resets_at: "2026-07-23T18:00:00.000Z" },
            creditBalance: 18.5,
            hasCredits: true,
            planType: "plus",
          },
        },
      }),
      update: normalizeCodexRateLimitsUpdate({ rateLimits: { primary: { usedPercent: 33 } } }),
    }).toMatchInlineSnapshot(`
      {
        "snapshot": {
          "credit_balance": 18.5,
          "has_credits": true,
          "plan_type": "plus",
          "primary_percent": 31,
          "primary_resets_at": "2026-07-20T20:40:00.000Z",
          "provider": "Codex",
          "secondary_percent": 64,
          "secondary_resets_at": "2026-07-23T18:00:00.000Z",
        },
        "update": {
          "primary_percent": 33,
        },
      }
    `);
  });

  it("emits a complete nullable record when an update precedes a snapshot", async () => {
    const snapshots$ = new Subject<CodexRateLimitsSnapshot>();
    const updates$ = new Subject<CodexRateLimitsUpdate>();
    const host: CodexHostAdapter = { rateLimitsRead: () => snapshots$, rateLimitsUpdated$: updates$ };
    const runtime = compileCodexUsage(host, () => 1_784_580_030_000);
    const emission = firstValueFrom(runtime.roots["codex.usage"].pipe(take(1)));
    updates$.next({ primary_percent: 33, primary_resets_at: "2026-07-20T23:00:00.000Z" });

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

  it("replaces a complete snapshot and patches later sparse updates", async () => {
    const snapshots$ = new Subject<CodexRateLimitsSnapshot>();
    const updates$ = new Subject<CodexRateLimitsUpdate>();
    const host: CodexHostAdapter = { rateLimitsRead: () => snapshots$, rateLimitsUpdated$: updates$ };
    const runtime = compileCodexUsage(host, () => 1_784_580_000_000);
    const emissions = firstValueFrom(runtime.roots["codex.usage"].pipe(take(2), toArray()));
    snapshots$.next(snapshot);
    updates$.next({ primary_percent: 33 });

    expect((await emissions).map((emission) => ({
      ts: emission.ts,
      url: emission.url,
      values: emission.matches[0],
    }))).toMatchInlineSnapshot(`
      [
        {
          "ts": 1784580000000,
          "url": "codex-app-server://account/rateLimits/read",
          "values": {
            "credit_balance": 18.5,
            "has_credits": true,
            "plan_type": "plus",
            "primary_percent": 31,
            "primary_resets_at": "2026-07-20T23:00:00.000Z",
            "provider": "Codex",
            "secondary_percent": 64,
            "secondary_resets_at": "2026-07-23T18:00:00.000Z",
          },
        },
        {
          "ts": 1784580000000,
          "url": "codex-app-server://account/rateLimits/updated",
          "values": {
            "credit_balance": 18.5,
            "has_credits": true,
            "plan_type": "plus",
            "primary_percent": 33,
            "primary_resets_at": "2026-07-20T23:00:00.000Z",
            "provider": "Codex",
            "secondary_percent": 64,
            "secondary_resets_at": "2026-07-23T18:00:00.000Z",
          },
        },
      ]
    `);
  });

  it("provides deterministic scripted fake-host updates", async () => {
    const host = createFakeCodexHostAdapter(snapshot, [{ primary_percent: 32 }]);
    const runtime = compileCodexUsage(host, () => 1_784_580_000_000);
    const emissions = await firstValueFrom(runtime.roots["codex.usage"].pipe(take(2), toArray()));

    expect(emissions.map((emission) => emission.matches[0].primary_percent)).toMatchInlineSnapshot(`
      [
        31,
        32,
      ]
    `);
  });
});
