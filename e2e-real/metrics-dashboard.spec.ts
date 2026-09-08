// The Metrics dashboard against the real backend. The rule hits the browser
// extension normally posts are written straight into instant-serve's activity
// store, so `activity_rule_matches` serves them over the WebSocket the way it
// serves a real capture. Every reading is taken from the panel a user opens
// through the Rules rail button.
import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { boot, closeTabs, DATA_DIR, errors, killAllSessions, shot } from "./0_real";

const ACTIVITY_DB = path.join(DATA_DIR, "activity.db");

function activitySql(query: string): string {
  const run = spawnSync("sqlite3", [ACTIVITY_DB, query], { encoding: "utf8" });
  if (run.status !== 0) throw new Error(`sqlite3 ${ACTIVITY_DB}: ${run.stderr}`);
  return run.stdout.trim();
}

const PERCENT_SCHEMA = {
  type: "object",
  properties: {
    percent: { type: "number", title: "Usage percent", minimum: 0, maximum: 100 },
    resets_at: { type: "string", title: "Reset time", format: "date-time" },
  },
};

const CODEX_SCHEMA = {
  type: "object",
  properties: {
    primary_percent: { type: ["number", "null"], title: "Primary usage", minimum: 0, maximum: 100 },
    secondary_percent: { type: ["number", "null"], title: "Secondary usage", minimum: 0, maximum: 100 },
  },
};

/// One rule hit as the extension reports it: the row's title is the rule id and
/// its text is the whole match record the panel reads back.
function insertMatch(row: {
  ruleId: string;
  url: string;
  ts: number;
  matches: Record<string, unknown>[];
  stream: string;
  schema: unknown;
}): void {
  const text = JSON.stringify(row).replace(/'/g, "''");
  const url = row.url.replace(/'/g, "''");
  activitySql(
    `insert into events(ts, source, kind, app, url, title, text, shot)
     values (${row.ts}, 'browser', 'rulematch', '', '${url}', '${row.ruleId}', '${text}', '')`,
  );
}

/// Two readings of a percent stream plus one codex rate-limit reading. The
/// newest row decides which stream the panel opens on.
function seedMatches(): void {
  const now = Date.now();
  insertMatch({
    ruleId: "fixture-usage", url: "http://127.0.0.1:4173/fixture.html", ts: now - 120_000,
    matches: [{ percent: 37, resets_at: "2030-01-02T03:04:05Z" }], stream: "fixture.usage", schema: PERCENT_SCHEMA,
  });
  insertMatch({
    ruleId: "codex-rate-limits", url: "codex-app-server://account/rateLimits/read", ts: now - 60_000,
    matches: [{ primary_percent: 64, secondary_percent: 23 }], stream: "codex.usage", schema: CODEX_SCHEMA,
  });
  insertMatch({
    ruleId: "fixture-usage", url: "http://127.0.0.1:4173/fixture.html", ts: now,
    matches: [{ percent: 42, resets_at: "2030-01-02T03:04:05Z" }], stream: "fixture.usage", schema: PERCENT_SCHEMA,
  });
}

const clearMatches = () => activitySql("delete from events where kind='rulematch'");

test.beforeEach(() => clearMatches());

test.afterEach(async ({ page }) => {
  clearMatches();
  await closeTabs(page);
});

test.afterAll(killAllSessions);

test("JSON-Rx dashboard renders captured metric data", async ({ page }) => {
  seedMatches();
  await boot(page);

  // Metrics sits under the Rules rail button; its chevron lists the child rows.
  await page.locator("#rules-toggle .actbar-exp").click();
  await page.locator("#rules-metrics-child").click();

  const dashboard = page.getByTestId("metrics-dashboard");
  await expect(dashboard).toHaveAttribute("data-state", "ready", { timeout: 20_000 });
  await expect(dashboard).toContainText("Usage percent");
  await expect(dashboard).toContainText("42%");
  await expect(dashboard).toContainText("fixture-usage");

  await page.getByTestId("metrics-comparison-stream").selectOption("codex.usage");
  const codexPanel = page.getByTestId("metrics-stream-codex.usage");
  await expect(codexPanel).toContainText("Primary usage");
  await expect(codexPanel).toContainText("64%");
  await expect(codexPanel.getByTestId("metrics-chart")).toHaveAttribute("data-render-state", "ready", { timeout: 20_000 });

  const chart = page.getByTestId("metrics-stream-fixture.usage").getByTestId("metrics-chart");
  await expect(chart).toHaveAttribute("data-render-state", "ready", { timeout: 20_000 });
  const renderedChart = await chart.evaluate((host) => {
    const view = host.querySelector("canvas, svg");
    return {
      host: host.getBoundingClientRect().toJSON(),
      view: view?.getBoundingClientRect().toJSON(),
    };
  });
  expect(renderedChart.host.width).toBeGreaterThan(500);
  expect(renderedChart.view?.width).toBeGreaterThan(400);
  expect(renderedChart.view?.height).toBeGreaterThan(200);
  await shot(page, "metrics-dashboard-01-two-streams");

  // The sash between the chart and its history table is dragged upward: the
  // chart loses the height the table gains.
  const fixturePanel = page.getByTestId("metrics-stream-fixture.usage");
  const handle = fixturePanel.locator(".meme-sash-horizontal");
  const chartPanel = fixturePanel.locator('[data-panel-id="metrics-chart-panel"]');
  const historyPanel = fixturePanel.locator('[data-panel-id="metrics-history-panel"]');
  const chartBefore = await chartPanel.boundingBox();
  const historyBefore = await historyPanel.boundingBox();
  const handleBox = await handle.boundingBox();
  expect(chartBefore).not.toBeNull();
  expect(historyBefore).not.toBeNull();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y - 80);
  await page.mouse.up();
  const chartAfter = await chartPanel.boundingBox();
  const historyAfter = await historyPanel.boundingBox();
  expect(chartAfter!.height).toBeLessThan(chartBefore!.height - 40);
  expect(historyAfter!.height).toBeGreaterThan(historyBefore!.height + 40);

  // A press on the sash while the rail's context menu stands closes the menu.
  await page.locator("#rules-toggle").click({ button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  const currentHandle = await handle.boundingBox();
  expect(currentHandle).not.toBeNull();
  await page.mouse.move(currentHandle!.x + currentHandle!.width / 2, currentHandle!.y + currentHandle!.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.locator(".ctx-menu")).toHaveCount(0);
  await shot(page, "metrics-dashboard-02-resized");
  expect(errors).toEqual([]);
});
