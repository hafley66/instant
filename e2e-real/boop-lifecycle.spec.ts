// Boop rail/dock panel lifecycle tier (src/boopPanel.tsx). Exercises the real
// built bundle through instant-serve against a scratch, real-schema Boop sqlite
// store seeded with synthetic lanes and mail. No mocks, no window hooks, no
// model calls: the panel reads boop_session_graph and boop_lane_events the same
// way it does in the product. Receipts are DOM rows, the empty state, console
// errors, and the sqlite fixture that produced them.
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { resetStore, seedLane, seedMail, seedStore } from "./0_boopLifecycleSeed";

const port = Number(process.env.INSTANT_BOOP_LIFE_PORT ?? 47807);
const shots = path.join(process.cwd(), "artifacts", "real");

const NOW = Date.now();
const ALPHA = "e2e-life-alpha";
const BETA = "e2e-life-beta";
const GAMMA = "e2e-life-gamma";

test.beforeAll(() => {
  seedStore();
});

test.afterAll(() => {
  resetStore();
});

interface Errors {
  page: string[];
  console: string[];
}

async function boot(page: Page): Promise<Errors> {
  const errors: Errors = { page: [], console: [] };
  page.on("pageerror", (e) => errors.page.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("ERR_CONNECTION_REFUSED")) errors.console.push(m.text());
  });
  await page.goto(`/?ws=ws://127.0.0.1:${port}/ws`);
  await expect(page.locator("#sessions-toggle")).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => document.fonts.status === "loaded");
  return errors;
}

async function openBoop(page: Page): Promise<void> {
  await page.locator("#boop-toggle").click();
  await expect(page.locator(".boop-panel")).toBeVisible({ timeout: 20_000 });
}

/// Switch the dock's active tab away from Boop and back, the refocus gesture.
/// The panel is keep-alive, so it stays in the DOM and only goes hidden.
async function refocus(page: Page): Promise<void> {
  await page.locator('.dv-tab:has(.dv-default-tab-content:text-is("tmux"))').click();
  await expect(page.locator(".boop-panel")).toBeHidden({ timeout: 10_000 });
  await page.locator('.dv-tab:has(.dv-default-tab-content:text-is("Boop"))').click();
  await expect(page.locator(".boop-panel")).toBeVisible({ timeout: 10_000 });
}

function row(page: Page, lane: string) {
  return page.locator(".boop-panel .dtable-row", { has: page.locator("td", { hasText: lane }) }).first();
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `boop-lifecycle-${name}.png`), fullPage: false });
}

test("first mount shows seeded live lanes and mail rows", async ({ page }) => {
  resetStore();
  seedLane({ lane: ALPHA, parent: BETA, cwd: "/tmp/e2e-life/alpha", state: "live", goal: "alpha goal", spawnedTs: NOW - 60_000 });
  seedLane({ lane: BETA, cwd: "/tmp/e2e-life/beta", state: "live", goal: "beta goal", spawnedTs: NOW - 120_000 });
  seedLane({ lane: GAMMA, cwd: "/tmp/e2e-life/gamma", state: "live", goal: "gamma goal", spawnedTs: NOW - 180_000 });
  seedMail({ id: "m-1", from: ALPHA, to: BETA, kind: "note", body: "alpha to beta", ageSec: 30 });
  seedMail({ id: "m-2", from: BETA, to: ALPHA, kind: "result", body: "beta result", ageSec: 10 });

  const errors = await boot(page);
  await openBoop(page);

  await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(3, { timeout: 30_000 });
  await expect(row(page, ALPHA)).toBeVisible();
  await expect(row(page, BETA)).toBeVisible();
  await expect(row(page, GAMMA)).toBeVisible();
  await expect(row(page, ALPHA)).toContainText("e2e-life/alpha");

  await expect(page.locator(".boop-panel .empty-help")).toHaveCount(0);
  await expect(page.locator(".boop-panel")).not.toContainText("store read failed");
  await shot(page, "01-first-mount");
  expect(errors.page, errors.page.join("\n")).toEqual([]);
});

test("empty store shows a meaningful empty state, not a silent blank", async ({ page }) => {
  resetStore();
  await boot(page);
  await openBoop(page);

  const empty = page.locator(".boop-panel .empty-help");
  await expect(empty).toBeVisible({ timeout: 30_000 });
  await expect(empty).toContainText("no agents in the window");
  await expect(page.locator(".boop-panel")).not.toContainText("store read failed");
  await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(0);
  await shot(page, "02-empty-store");
});

test("refocus after another tab keeps the rows and raises no error", async ({ page }) => {
  resetStore();
  seedLane({ lane: ALPHA, cwd: "/tmp/e2e-life/alpha", state: "live", goal: "alpha goal", spawnedTs: NOW - 60_000 });
  seedLane({ lane: BETA, cwd: "/tmp/e2e-life/beta", state: "live", goal: "beta goal", spawnedTs: NOW - 120_000 });
  seedMail({ id: "m-refocus", from: ALPHA, to: BETA, kind: "note", body: "refocus mail", ageSec: 20 });

  const errors = await boot(page);
  await openBoop(page);
  await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(2, { timeout: 30_000 });

  await refocus(page);

  await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(2, { timeout: 30_000 });
  await expect(row(page, ALPHA)).toBeVisible();
  await expect(row(page, BETA)).toBeVisible();
  await expect(page.locator(".boop-panel")).toHaveCount(1);
  await shot(page, "03-refocus");
  expect([...errors.page, ...errors.console], [...errors.page, ...errors.console].join("\n")).toEqual([]);
});

test("close and reopen the panel reloads the same rows", async ({ page }) => {
  resetStore();
  seedLane({ lane: ALPHA, cwd: "/tmp/e2e-life/alpha", state: "live", goal: "alpha goal", spawnedTs: NOW - 60_000 });
  const errors = await boot(page);
  await openBoop(page);
  await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(1, { timeout: 30_000 });

  await page.locator("#boop-toggle").click();
  await expect(page.locator(".boop-panel")).toHaveCount(0);
  await openBoop(page);

  await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(1, { timeout: 30_000 });
  await expect(row(page, ALPHA)).toBeVisible();
  expect([...errors.page, ...errors.console], [...errors.page, ...errors.console].join("\n")).toEqual([]);
});

test("a lane and mail added while hidden appear on refocus", async ({ page }) => {
  resetStore();
  seedLane({ lane: ALPHA, cwd: "/tmp/e2e-life/alpha", state: "live", goal: "alpha goal", spawnedTs: NOW - 60_000 });
  const errors = await boot(page);
  await openBoop(page);
  await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(1, { timeout: 30_000 });

  // Hide Boop behind the tmux tab, then write to the scratch store.
  await page.locator('.dv-tab:has(.dv-default-tab-content:text-is("tmux"))').click();
  await expect(page.locator(".boop-panel")).toBeHidden();
  seedLane({ lane: BETA, cwd: "/tmp/e2e-life/beta", state: "live", goal: "beta goal", spawnedTs: NOW - 5_000 });
  seedMail({ id: "m-hidden", from: ALPHA, to: BETA, kind: "note", body: "while hidden", ageSec: 2 });

  await page.locator('.dv-tab:has(.dv-default-tab-content:text-is("Boop"))').click();
  await expect(page.locator(".boop-panel")).toBeVisible();
  await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(2, { timeout: 30_000 });
  await expect(row(page, BETA)).toBeVisible();
  await shot(page, "05-updated-while-hidden");
  expect([...errors.page, ...errors.console], [...errors.page, ...errors.console].join("\n")).toEqual([]);
});

test("repeated refocus raises no errors and duplicates no rows", async ({ page }) => {
  resetStore();
  seedLane({ lane: ALPHA, cwd: "/tmp/e2e-life/alpha", state: "live", goal: "alpha goal", spawnedTs: NOW - 60_000 });
  const errors = await boot(page);
  await openBoop(page);
  await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(1, { timeout: 30_000 });

  for (let i = 0; i < 5; i += 1) {
    await refocus(page);
    await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(1, { timeout: 15_000 });
  }
  await expect(page.locator(".boop-panel")).toHaveCount(1);
  expect([...errors.page, ...errors.console], [...errors.page, ...errors.console].join("\n")).toEqual([]);
});

test("active-only default hides idle lanes; unfiltering shows them", async ({ page }) => {
  resetStore();
  seedLane({ lane: ALPHA, cwd: "/tmp/e2e-life/alpha", state: "live", goal: "live lane", spawnedTs: NOW - 60_000 });
  seedLane({ lane: GAMMA, cwd: "/tmp/e2e-life/gamma", state: "dead", goal: "done lane", spawnedTs: NOW - 300_000 });
  seedMail({ id: "m-dead", from: GAMMA, to: GAMMA, kind: "result", body: "done", ageSec: 240 });

  const errors = await boot(page);
  await openBoop(page);

  // Default: only the live root shows; the finished lane is counted as hidden.
  await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(1, { timeout: 30_000 });
  await expect(row(page, ALPHA)).toBeVisible();
  await expect(row(page, GAMMA)).toHaveCount(0);
  await expect(page.locator(".boop-panel")).toContainText("1 hidden by active-only");

  // Unfiltered: the finished lane is present in the data, distinguishing a
  // lifecycle mount bug from the expected filter.
  await page.locator(".boop-panel input[type=checkbox]").click();
  await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(2, { timeout: 15_000 });
  await expect(row(page, GAMMA)).toBeVisible();
  await shot(page, "07-active-only");
  expect([...errors.page, ...errors.console], [...errors.page, ...errors.console].join("\n")).toEqual([]);
});
