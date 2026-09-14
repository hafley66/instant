// Boop network tier: the marbler panel (the "network") is rendered through the
// real built bundle and instant-serve against a scratch, real-schema Boop
// sqlite store. The graph is seeded large enough that the pre-fix per-lane
// trace-event read would stall the first paint, so this tier asserts both that
// network nodes/edges actually render and that every boop_session_graph
// response is bounded and carries no trace events. No mocks, no window hooks,
// no model calls.
import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import {
  resetStore,
  seedBulkEvents,
  seedBulkLanes,
  seedBulkSessions,
  seedBulkTurns,
  seedLane,
  seedMail,
  seedStore,
} from "./0_boopLifecycleSeed";

const port = Number(process.env.INSTANT_BOOP_LIFE_PORT ?? 47815);
const shots = path.join(process.cwd(), "artifacts", "real");

const BIG_LANES = 1200;
const BIG_SESSIONS = 1200;
const BIG_TURNS_PER_SESSION = 100;
const BIG_EVENTS = 12_000;
// Bound: with trace events dropped, the read is one runtime observation plus
// set-wise store queries. The same store on the pre-fix binary measured
// thousands of per-lane trace queries and a first graph response well over this
// budget.
const READ_BUDGET_MS = 2_000;

test.beforeAll(() => {
  seedStore();
});

test.afterAll(() => {
  resetStore();
});

async function boot(page: Page): Promise<{ page: string[]; console: string[] }> {
  const errors = { page: [] as string[], console: [] as string[] };
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

function marblerRows(page: Page) {
  return page.locator(".boop-marbler .grid-body > .grid-row");
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `boop-network-${name}.png`), fullPage: false });
}

interface GraphFrame {
  ms: number;
  sessions: number;
  edges: number;
  shells: number;
  traceEvents: number;
}

/// Every JSON-RPC `boop_session_graph` pair this page makes, with round-trip
/// duration and response cardinality, read off the real WebSocket.
function watchGraph(page: Page): GraphFrame[] {
  const frames: GraphFrame[] = [];
  const sent = new Map<number, number>();
  page.on("websocket", (ws) => {
    ws.on("framesent", (e) => {
      try {
        const frame = JSON.parse(typeof e.payload === "string" ? e.payload : e.payload.toString());
        if (frame?.method === "boop_session_graph") sent.set(frame.id, Date.now());
      } catch { /* non-JSON frames */ }
    });
    ws.on("framereceived", (e) => {
      try {
        const frame = JSON.parse(typeof e.payload === "string" ? e.payload : e.payload.toString());
        if (typeof frame?.id !== "number" || !sent.has(frame.id)) return;
        const started = sent.get(frame.id)!;
        sent.delete(frame.id);
        const result = frame.result ?? {};
        frames.push({
          ms: Date.now() - started,
          sessions: (result.sessions ?? []).length,
          edges: (result.edges ?? []).length,
          shells: (result.shells ?? []).length,
          traceEvents: (result.trace_events ?? []).length,
        });
      } catch { /* non-JSON frames */ }
    });
  });
  return frames;
}

test("a large history renders the network and keeps the graph read bounded", async ({ page }) => {
  resetStore();
  seedBulkLanes(BIG_LANES);
  seedBulkSessions(BIG_SESSIONS);
  seedBulkTurns(BIG_TURNS_PER_SESSION);
  seedBulkEvents(BIG_EVENTS, BIG_LANES);
  seedMail({ id: "net-m1", from: "bulk-lane-1", to: "bulk-lane-2", kind: "note", body: "bulk mail", ageSec: 30 });

  const frames = watchGraph(page);
  const errors = await boot(page);
  const opened = Date.now();
  await openBoop(page);

  // The Boop network view is the embedded marbler (`[data-testid=marbler]` /
  // `section.network-panel`) under the roster. There is no separate network-mode
  // control in current main: the marbler's `all/request/...` filter toolbar is
  // hidden in embedded mode, so this is the whole network surface.
  await expect(page.locator('[data-testid="marbler"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".boop-marbler section.network-panel")).toHaveCount(1);
  // Mail frames render as waterfall dots on the roster lanes (the marbler's own
  // link marks are drawn on the Pixi timeline canvas, covered by the screenshot).
  await expect(page.locator(".boop-master .boop-spark i").first()).toBeVisible({ timeout: 30_000 });
  const firstRow = marblerRows(page).first();
  await expect(firstRow).toBeVisible({ timeout: READ_BUDGET_MS + 30_000 });
  await expect(firstRow).toContainText("bulk-");
  const nodeCount = await marblerRows(page).count();
  expect(nodeCount).toBeGreaterThan(0);
  await expect(page.locator(".boop-marbler .subtoolbar .summary")).toHaveText(/[1-9]\d* events/);
  await expect(page.locator(".boop-marbler .time-navigator canvas")).toHaveCount(1);
  const visibleMs = Date.now() - opened;

  // Every graph read completed inside the bound and asked for no trace events.
  expect(frames.length, "at least one boop_session_graph response").toBeGreaterThan(0);
  const worst = Math.max(...frames.map((f) => f.ms));
  expect(worst, JSON.stringify(frames.slice(0, 3))).toBeLessThan(READ_BUDGET_MS);
  expect(frames.every((f) => f.traceEvents === 0), JSON.stringify(frames.slice(0, 3))).toBe(true);
  // Cardinality sanity: the whole synthetic store is visible, nothing silently dropped.
  expect(frames[frames.length - 1].shells).toBe(BIG_LANES);
  expect(frames[frames.length - 1].sessions).toBe(BIG_SESSIONS);

  await shot(page, "01-large-render");
  console.log(JSON.stringify({ visibleMs, worstReadMs: worst, frames: frames.slice(0, 3), nodeCount }));
  expect(errors.page, errors.page.join("\n")).toEqual([]);
});

test("clicking a network node opens its detail drawer", async ({ page }) => {
  resetStore();
  seedLane({ lane: "net-lane-a", cwd: "/tmp/e2e-net/a", state: "live", goal: "network a", spawnedTs: Date.now() - 60_000 });
  seedLane({ lane: "net-lane-b", parent: "net-lane-a", cwd: "/tmp/e2e-net/b", state: "live", goal: "network b", spawnedTs: Date.now() - 30_000 });
  seedMail({ id: "net-m2", from: "net-lane-a", to: "net-lane-b", kind: "note", body: "drawer mail", ageSec: 10 });

  const errors = await boot(page);
  await openBoop(page);
  const row = marblerRows(page).filter({ hasText: "net-lane-b" }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  const drawer = page.locator('[data-testid="event-details"]');
  await expect(drawer).toBeVisible({ timeout: 15_000 });
  // The drawer names the graph edge (parent lane -> this lane) and its target.
  await expect(drawer).toContainText("boop://net-lane-a/net-lane-b");
  await expect(drawer).toContainText("net-lane-b");
  await shot(page, "02-selection");
  expect([...errors.page, ...errors.console], [...errors.page, ...errors.console].join("\n")).toEqual([]);
});

test("roster selection narrows the network to the subtree", async ({ page }) => {
  resetStore();
  seedLane({ lane: "narrow-root", cwd: "/tmp/e2e-net/root", state: "live", goal: "root", spawnedTs: Date.now() - 90_000 });
  seedLane({ lane: "narrow-child", parent: "narrow-root", cwd: "/tmp/e2e-net/child", state: "live", goal: "child", spawnedTs: Date.now() - 40_000 });
  seedLane({ lane: "narrow-other", cwd: "/tmp/e2e-net/other", state: "live", goal: "other", spawnedTs: Date.now() - 20_000 });

  const errors = await boot(page);
  await openBoop(page);
  await expect(marblerRows(page)).toHaveCount(3, { timeout: 30_000 });
  const rootRow = page.locator(".boop-panel .dtable-row", { has: page.locator("td", { hasText: "narrow-root" }) }).first();
  await rootRow.click();
  await expect(page.locator(".boop-narrow")).toBeVisible({ timeout: 10_000 });
  await expect(marblerRows(page)).toHaveCount(2, { timeout: 10_000 });
  await expect(marblerRows(page).filter({ hasText: "narrow-other" })).toHaveCount(0);
  await shot(page, "03-subtree");
  expect([...errors.page, ...errors.console], [...errors.page, ...errors.console].join("\n")).toEqual([]);
});

test("repeated refocus keeps the network rendered and a hidden write appears", async ({ page }) => {
  resetStore();
  seedLane({ lane: "focus-alpha", cwd: "/tmp/e2e-net/alpha", state: "live", goal: "alpha", spawnedTs: Date.now() - 60_000 });
  const errors = await boot(page);
  await openBoop(page);
  await expect(marblerRows(page)).toHaveCount(1, { timeout: 30_000 });

  for (let i = 0; i < 3; i += 1) {
    await page.locator('.dv-tab:has(.dv-default-tab-content:text-is("tmux"))').click();
    await expect(page.locator(".boop-panel")).toBeHidden({ timeout: 10_000 });
    await page.locator('.dv-tab:has(.dv-default-tab-content:text-is("Boop"))').click();
    await expect(page.locator(".boop-panel")).toBeVisible({ timeout: 10_000 });
    await expect(marblerRows(page)).toHaveCount(1, { timeout: 15_000 });
  }

  await page.locator('.dv-tab:has(.dv-default-tab-content:text-is("tmux"))').click();
  await expect(page.locator(".boop-panel")).toBeHidden({ timeout: 10_000 });
  seedLane({ lane: "focus-beta", cwd: "/tmp/e2e-net/beta", state: "live", goal: "beta", spawnedTs: Date.now() - 3_000 });
  await page.locator('.dv-tab:has(.dv-default-tab-content:text-is("Boop"))').click();
  await expect(page.locator(".boop-panel")).toBeVisible({ timeout: 10_000 });
  await expect(marblerRows(page)).toHaveCount(2, { timeout: 30_000 });
  await expect(marblerRows(page).filter({ hasText: "focus-beta" })).toHaveCount(1);
  await shot(page, "04-refocus-hidden-write");
  expect([...errors.page, ...errors.console], [...errors.page, ...errors.console].join("\n")).toEqual([]);
});
