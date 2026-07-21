import { execFileSync } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { chromium, expect, test } from "@playwright/test";

const repo = resolve(import.meta.dirname, "..");
const extensionDir = resolve(repo, "extension");
const ingestPort = 8788;
const fixturePort = 4174;

const rule = {
  id: "claude-usage",
  host: "^127\\.0\\.0\\.1(?::\\d+)?$",
  mode: "netcapture",
  request: { methods: ["GET"], url: "/api/organizations/[^/]+/usage" },
  response: {
    extract: {
      five_hour_percent: "five_hour.utilization",
      five_hour_resets_at: "five_hour.resets_at",
      seven_day_percent: "seven_day.utilization",
      seven_day_resets_at: "seven_day.resets_at",
      extra_used_credits: "extra_usage.used_credits",
      extra_monthly_limit: "extra_usage.monthly_limit",
      extra_percent: "extra_usage.utilization",
      extra_enabled: "extra_usage.is_enabled",
    },
  },
  emit: {
    stream: "claude.usage",
    schema: {
      type: "object",
      properties: {
        five_hour_percent: { type: "number", title: "5-hour usage" },
        five_hour_resets_at: { type: "string", title: "5-hour reset" },
        seven_day_percent: { type: "number", title: "7-day usage" },
        seven_day_resets_at: { type: "string", title: "7-day reset" },
        extra_used_credits: { type: "number", title: "Extra credits used" },
        extra_monthly_limit: { type: "number", title: "Extra credit limit" },
        extra_percent: { type: "number", title: "Extra usage" },
        extra_enabled: { type: "boolean", title: "Extra usage enabled" },
      },
    },
  },
  enabled: true,
  diagnostics: "all",
  schedule: {
    source: { interval: { periodMs: 60 * 60 * 1000 } },
    pipe: [{
      exhaustMap: {
        effect: {
          id: "reload-fixture",
          op: "browsingContext.reload",
          input: {
            target: { url: `^http://127\\.0\\.0\\.1:${fixturePort}/fixture\\.html$` },
          },
        },
      },
    }],
  },
};

const claudeUsageResponse = {
  five_hour: {
    utilization: 4,
    resets_at: "2026-07-20T23:29:59.650480+00:00",
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day: {
    utilization: 82,
    resets_at: "2026-07-23T17:59:59.650507+00:00",
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day_oauth_apps: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
  seven_day_cowork: null,
  seven_day_omelette: null,
  tangelo: null,
  iguana_necktie: null,
  omelette_promotional: null,
  nimbus_quill: null,
  cinder_cove: null,
  amber_ladder: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: 10000,
    used_credits: 0,
    utilization: 0,
    currency: "USD",
    decimal_places: 2,
    disabled_reason: "out_of_credits",
    daily: null,
    weekly: null,
  },
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 4,
      severity: "normal",
      resets_at: "2026-07-20T23:29:59.650480+00:00",
      scope: null,
      is_active: false,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 82,
      severity: "warning",
      resets_at: "2026-07-23T17:59:59.650507+00:00",
      scope: null,
      is_active: false,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 100,
      severity: "critical",
      resets_at: "2026-07-23T17:59:59.650917+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: true,
    },
  ],
  spend: {
    used: { amount_minor: 0, currency: "USD", exponent: 2 },
    limit: { amount_minor: 10000, currency: "USD", exponent: 2 },
    percent: 0,
    severity: "normal",
    enabled: false,
    disabled_reason: "out_of_credits",
    cap: { money: null, credits: { amount_minor: 10000, exponent: 2 } },
    balance: null,
    auto_reload: null,
    disclaimer: "Usage credits cover you when you hit your plan limits.",
    can_purchase_credits: true,
    can_toggle: true,
  },
  member_dashboard_available: false,
};

function json(res: ServerResponse, body: unknown, status = 200) {
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(encoded),
  });
  res.end(encoded);
}

test("MV3 Claude rule replays a usage response captured before config arrives", async () => {
  execFileSync("corepack", ["pnpm@10.12.4", "run", "ext:build"], {
    cwd: repo,
    stdio: "inherit",
    env: { ...process.env, INSTANT_ACTIVITY_ORIGIN: `http://127.0.0.1:${ingestPort}` },
  });

  const events: Record<string, unknown>[] = [];
  let configRequests = 0;
  let usageRequested = false;
  let fixtureLoads = 0;
  const pendingConfigResponses: ServerResponse[] = [];
  let fixtureServer: ReturnType<typeof createServer> | undefined;
  const server = createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      });
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/config") {
      configRequests++;
      if (usageRequested) json(res, { revision: 1, rules: [rule] });
      else pendingConfigResponses.push(res);
      return;
    }
    if (req.method === "POST" && (req.url === "/heartbeat" || req.url === "/ingest")) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (req.url === "/ingest") events.push(JSON.parse(body) as Record<string, unknown>);
        json(res, { ok: true });
      });
      return;
    }
    json(res, { error: "missing fixture route" }, 404);
  });
  await new Promise<void>((resolveServer) => {
    server.listen(ingestPort, "127.0.0.1", () => {
      fixtureServer = createServer((req, res) => {
        if (req.method === "GET" && req.url === "/fixture.html") {
          fixtureLoads++;
          const body = `<!doctype html><body><main id="fixture">loading</main><script>
            fetch('/api/organizations/test-org/usage').then((response) => response.json()).then((data) => {
              document.querySelector('#fixture').textContent = String(data.five_hour.utilization);
            });
          </script></body>`;
          res.writeHead(200, { "Content-Type": "text/html", "Content-Length": Buffer.byteLength(body) });
          res.end(body);
          return;
        }
        if (req.method === "GET" && req.url === "/api/organizations/test-org/usage") {
          usageRequested = true;
          json(res, claudeUsageResponse);
          setTimeout(() => {
            for (const configResponse of pendingConfigResponses.splice(0)) {
              json(configResponse, { revision: 1, rules: [rule] });
            }
          }, 250);
          return;
        }
        json(res, { error: "missing fixture route" }, 404);
      });
      fixtureServer.listen(fixturePort, "127.0.0.1", () => resolveServer());
    });
  });

  const context = await chromium.launchPersistentContext("", {
    headless: true,
    channel: "chromium",
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  });
  const page = await context.newPage();
  let serviceWorker = context.serviceWorkers()[0];
  if (!serviceWorker) serviceWorker = await context.waitForEvent("serviceworker");
  expect(serviceWorker.url()).toMatch(/^chrome-extension:\/\//);
  try {
    await page.goto(`http://127.0.0.1:${fixturePort}/fixture.html`);
    await expect(page.locator("#fixture")).toHaveText("4");
    await expect.poll(() => configRequests).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => document.documentElement.getAttribute("data-ext-netcapture"))).not.toBeNull();
    await expect.poll(() => events.filter((event) => event.kind === "netcapture.seen")).toHaveLength(1);
    await expect.poll(() => events.filter((event) => event.type === "rulematch")).toHaveLength(1);
    await expect.poll(() => events.filter((event) => event.kind === "rule.trace")).toHaveLength(1);
    const seen = events.find((event) => event.kind === "netcapture.seen");
    expect(seen).toMatchObject({ url: `http://127.0.0.1:${fixturePort}/api/organizations/test-org/usage` });
    const trace = JSON.parse(String(events.find((event) => event.kind === "rule.trace")?.text));
    expect(trace.traces).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "five_hour_percent", outcome: "passed", result: 4 }),
      expect.objectContaining({ path: "seven_day_percent", outcome: "passed", result: 82 }),
      expect.objectContaining({ path: "extra_enabled", outcome: "passed", result: false }),
    ]));
    const emitted = events
      .filter((event) => event.type === "rulematch")
      .map((event) => ({ ...event, ts: "<timestamp>" }));
    expect(emitted).toEqual([
      {
        automationVersion: "automation.v2",
        matches: [{
          five_hour_percent: 4,
          five_hour_resets_at: "2026-07-20T23:29:59.650480+00:00",
          seven_day_percent: 82,
          seven_day_resets_at: "2026-07-23T17:59:59.650507+00:00",
          extra_used_credits: 0,
          extra_monthly_limit: 10000,
          extra_percent: 0,
          extra_enabled: false,
        }],
        ruleId: "claude-usage",
        schema: rule.emit.schema,
        stream: "claude.usage",
        ts: "<timestamp>",
        type: "rulematch",
        url: `http://127.0.0.1:${fixturePort}/fixture.html`,
      },
    ]);
    await serviceWorker.evaluate(() => {
      chrome.alarms.create("driven:claude-usage", { when: Date.now() + 100 });
    });
    await expect.poll(() => fixtureLoads).toBe(2);
    await expect.poll(() => events.filter((event) => event.kind === "browser.effect.next")).toHaveLength(1);
    const effect = JSON.parse(String(events.find((event) => event.kind === "browser.effect.next")?.text));
    expect(effect).toMatchObject({
      type: "browser.effect.next",
      effectId: "reload-fixture",
      op: "browsingContext.reload",
    });
    expect(effect.contexts).toHaveLength(1);
  } finally {
    await context.close();
    await new Promise<void>((resolveServer, reject) => {
      fixtureServer?.close((error) => error ? reject(error) : resolveServer());
      if (!fixtureServer) resolveServer();
    });
    await new Promise<void>((resolveServer, reject) => server.close((error) => error ? reject(error) : resolveServer()));
    execFileSync("corepack", ["pnpm@10.12.4", "run", "ext:build"], {
      cwd: repo,
      stdio: "inherit",
      env: { ...process.env, INSTANT_ACTIVITY_ORIGIN: "http://127.0.0.1:8787" },
    });
  }
});
