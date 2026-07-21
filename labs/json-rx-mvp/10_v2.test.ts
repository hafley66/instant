import { Observable, Subject, firstValueFrom, take } from "rxjs";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { AutomationV2JsonSchema, AutomationV2Schema } from "./7_v2-schema";
import { compileAutomationV2, type NetworkResponse } from "./8_v2-runtime";
import { claudeUsageV1, claudeUsageV2 } from "./9_claude-v2.fixture";

const response: NetworkResponse = {
  method: "GET",
  pageUrl: "https://claude.ai/new#settings/usage",
  requestUrl: "https://claude.ai/api/organizations/test/usage",
  status: 200,
  ts: 1_784_579_986_984,
  body: {
    five_hour: { utilization: 9, resets_at: "2026-07-20T23:29:59.963706+00:00" },
    seven_day: { utilization: 83, resets_at: "2026-07-23T17:59:59.963733+00:00" },
    extra_usage: {
      used_credits: 0,
      monthly_limit: 10_000,
      utilization: 0,
      is_enabled: false,
    },
  },
};

describe("automation.v2 side-by-side lab", () => {
  it("keeps v1 and v2 as independently versioned documents", () => {
    expect({
      v1: {
        id: claudeUsageV1.id,
        mode: claudeUsageV1.mode,
        stream: claudeUsageV1.emit.stream,
      },
      v2: {
        id: claudeUsageV2.id,
        version: claudeUsageV2.version,
        stream: claudeUsageV2.outputs[0].stream,
      },
    }).toMatchInlineSnapshot(`
      {
        "v1": {
          "id": "claude-usage",
          "mode": "netcapture",
          "stream": "claude.usage",
        },
        "v2": {
          "id": "jsonrx://instant/automations/claude-usage",
          "stream": "claude.usage",
          "version": "automation.v2",
        },
      }
    `);
  });

  it("parses v2 and exports a Draft 2020-12 JSON Schema", () => {
    const parsed = AutomationV2Schema.parse(JSON.parse(JSON.stringify(claudeUsageV2)));
    expect({
      id: parsed.id,
      schema: AutomationV2JsonSchema.$schema,
      rootProperties: Object.keys(AutomationV2JsonSchema.properties ?? {}).sort(),
    }).toMatchInlineSnapshot(`
      {
        "id": "jsonrx://instant/automations/claude-usage",
        "rootProperties": [
          "bindings",
          "circuit",
          "enabled",
          "id",
          "outputs",
          "profile",
          "version",
        ],
        "schema": "https://json-schema.org/draft/2020-12/schema",
      }
    `);
  });

  it("rejects unresolved references and duplicate node identities", () => {
    const invalid = structuredClone(claudeUsageV2) as Record<string, unknown>;
    const circuit = invalid.circuit as typeof claudeUsageV2.circuit;
    circuit.flows["jsonrx://instant/flows/claude-usage"].expression.shareReplay.input.node = "claude-usage.share";
    (invalid.outputs as typeof claudeUsageV2.outputs)[0].flow = "jsonrx://instant/flows/missing";

    let issues: ZodError["issues"] = [];
    try {
      AutomationV2Schema.parse(invalid);
    } catch (error) {
      if (error instanceof ZodError) issues = error.issues;
    }
    expect(issues.map(({ message, path }) => ({ message, path }))).toMatchInlineSnapshot(`
      [
        {
          "message": "duplicate node id: claude-usage.share",
          "path": [
            "circuit",
            "flows",
            "jsonrx://instant/flows/claude-usage",
            "expression",
          ],
        },
        {
          "message": "output references unknown flow: jsonrx://instant/flows/missing",
          "path": [
            "outputs",
            0,
            "flow",
          ],
        },
      ]
    `);
  });

  it("projects the same Claude fields into the existing dashboard stream", async () => {
    const network$ = new Subject<NetworkResponse>();
    const runtime = compileAutomationV2(claudeUsageV2, {
      "jsonrx://instant/sources/browser/network-response/claude-usage": network$,
    });
    const emissionPromise = firstValueFrom(runtime.roots["claude.usage"].pipe(take(1)));
    network$.next(response);

    expect(await emissionPromise).toMatchInlineSnapshot(`
      {
        "matches": [
          {
            "extra_enabled": false,
            "extra_monthly_limit": 10000,
            "extra_percent": 0,
            "extra_used_credits": 0,
            "five_hour_percent": 9,
            "five_hour_resets_at": "2026-07-20T23:29:59.963706+00:00",
            "seven_day_percent": 83,
            "seven_day_resets_at": "2026-07-23T17:59:59.963733+00:00",
          },
        ],
        "ruleId": "jsonrx://instant/automations/claude-usage",
        "schema": {
          "properties": {
            "extra_enabled": {
              "title": "Extra usage enabled",
              "type": "boolean",
            },
            "extra_monthly_limit": {
              "title": "Extra credit limit",
              "type": "number",
            },
            "extra_percent": {
              "maximum": 100,
              "minimum": 0,
              "title": "Extra usage",
              "type": "number",
            },
            "extra_used_credits": {
              "title": "Extra credits used",
              "type": "number",
            },
            "five_hour_percent": {
              "maximum": 100,
              "minimum": 0,
              "title": "5-hour usage",
              "type": "number",
            },
            "five_hour_resets_at": {
              "format": "date-time",
              "title": "5-hour reset",
              "type": "string",
            },
            "seven_day_percent": {
              "maximum": 100,
              "minimum": 0,
              "title": "7-day usage",
              "type": "number",
            },
            "seven_day_resets_at": {
              "format": "date-time",
              "title": "7-day reset",
              "type": "string",
            },
          },
          "type": "object",
        },
        "stream": "claude.usage",
        "ts": 1784579986984,
        "url": "https://claude.ai/new#settings/usage",
      }
    `);
  });

  it("shares one network source while v2 root subscribers overlap", () => {
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
    const runtime = compileAutomationV2(claudeUsageV2, {
      "jsonrx://instant/sources/browser/network-response/claude-usage": counted$,
    });

    const left = runtime.roots["claude.usage"].subscribe();
    const right = runtime.roots["claude.usage"].subscribe();
    const whileOverlapping = { acquisitions, releases };
    left.unsubscribe();
    const afterLeft = { acquisitions, releases };
    right.unsubscribe();

    expect({ whileOverlapping, afterLeft, afterRight: { acquisitions, releases } }).toMatchInlineSnapshot(`
      {
        "afterLeft": {
          "acquisitions": 1,
          "releases": 0,
        },
        "afterRight": {
          "acquisitions": 1,
          "releases": 1,
        },
        "whileOverlapping": {
          "acquisitions": 1,
          "releases": 0,
        },
      }
    `);
  });

  it("produces byte-identical canonical IR after object key reordering", () => {
    const first = compileAutomationV2(claudeUsageV2, {});
    const reordered = {
      outputs: claudeUsageV2.outputs,
      circuit: claudeUsageV2.circuit,
      bindings: claudeUsageV2.bindings,
      enabled: claudeUsageV2.enabled,
      id: claudeUsageV2.id,
      profile: claudeUsageV2.profile,
      version: claudeUsageV2.version,
    };
    const second = compileAutomationV2(reordered, {});

    expect({
      equal: first.canonicalIr === second.canonicalIr,
      prefix: first.canonicalIr.slice(0, 90),
    }).toMatchInlineSnapshot(`
      {
        "equal": true,
        "prefix": "{"bindings":{"sources":{"jsonrx://instant/sources/browser/network-response/claude-usage":{",
      }
    `);
  });
});
