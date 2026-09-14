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
  sql,
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

/// Count pixels of an element screenshot that differ from the modal (background)
/// color. Element screenshots composite the Pixi WebGL canvas, whereas reading
/// the canvas buffer back returns an empty drawing buffer. Used to prove the
/// waterfall actually drew marks, not just that a canvas element exists.
async function screenshotInk(page: Page, selector: string): Promise<number> {
  const png = (await page.locator(selector).screenshot()).toString("base64");
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const copy = document.createElement("canvas");
    copy.width = img.width;
    copy.height = img.height;
    const ctx = copy.getContext("2d");
    if (!ctx) return -1;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, copy.width, copy.height).data;
    const counts = new Map<number, number>();
    for (let i = 0; i < d.length; i += 4) {
      const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let modal = 0;
    let modalCount = 0;
    for (const [key, count] of counts) if (count > modalCount) { modal = key; modalCount = count; }
    const mr = (modal >> 16) & 255, mg = (modal >> 8) & 255, mb = modal & 255;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - mr) + Math.abs(d[i + 1] - mg) + Math.abs(d[i + 2] - mb) > 30) ink += 1;
    }
    return ink;
  }, png);
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
  // Only a handful of the 1200 lanes stay live. The graph read still returns
  // all 1200 shells/sessions (the bounding claim under test), but the panel's
  // timeline is not asked to render an artificial 1200-row navigator: the
  // installed marbler sizes that navigator by lane count and offers no compact
  // height, a gap reported with the review.
  sql(`delete from agent_live
        where session_id in (
          select s.id from dict_session s
           where s.value like 'bulk-lane-%'
             and cast(substr(s.value, 11) as integer) > 6)`);
  seedMail({ id: "net-m1", from: "bulk-lane-1", to: "bulk-lane-2", kind: "note", body: "bulk mail", ageSec: 30 });

  const frames = watchGraph(page);
  const errors = await boot(page);
  const opened = Date.now();
  await openBoop(page);

  // The Boop network view is the embedded marbler (`[data-testid=marbler]` /
  // `section.network-panel`) under the roster. It is a table view; there is no
  // separate network-mode control in current main (the marbler's `all/request/`
  // filter toolbar is hidden in embedded mode), so this is the whole surface.
  await expect(page.locator('[data-testid="marbler"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".boop-marbler section.network-panel")).toHaveCount(1);
  // Mail frames render as waterfall dots on the roster lanes (the marbler's own
  // link marks are drawn on the Pixi timeline canvas, covered by the screenshot).
  await expect(page.locator(".boop-master .boop-spark i").first()).toBeVisible({ timeout: 30_000 });
  const firstRow = marblerRows(page).first();
  await expect(firstRow).toBeVisible({ timeout: READ_BUDGET_MS + 30_000 });
  await expect(firstRow).toContainText("bulk-");
  const tableRowCount = await marblerRows(page).count();
  expect(tableRowCount).toBeGreaterThan(0);
  await expect(page.locator(".boop-marbler .subtoolbar .summary")).toHaveText(/[1-9]\d* events/);
  await expect(page.locator('[data-testid="waterfall-pixi"]')).toHaveCount(1);
  await expect(page.locator(".boop-marbler .time-navigator canvas")).toHaveCount(1);
  // Six live lanes at lanes*14 + chrome; the navigator is not clipped, so its
  // height scales with the live lane count it is actually given.
  const navBox = await page.locator(".boop-marbler .time-navigator").boundingBox();
  expect(navBox?.height ?? 0).toBeLessThanOrEqual(120);
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
  console.log(JSON.stringify({ visibleMs, worstReadMs: worst, frames: frames.slice(0, 3), tableRowCount }));
  expect(errors.page, errors.page.join("\n")).toEqual([]);
});

test("clicking a network table row opens its detail drawer", async ({ page }) => {
  resetStore();
  seedLane({ lane: "net-lane-a", cwd: "/tmp/e2e-net/a", state: "live", goal: "network a", spawnedTs: Date.now() - 60_000 });
  seedLane({ lane: "net-lane-b", parent: "net-lane-a", cwd: "/tmp/e2e-net/b", state: "live", goal: "network b", spawnedTs: Date.now() - 30_000 });
  seedMail({ id: "net-m2", from: "net-lane-a", to: "net-lane-b", kind: "note", body: "drawer mail", ageSec: 10 });

  const errors = await boot(page);
  await openBoop(page);
  // The child is collapsed in both panels; expanding the roster row adds it to
  // the timeline, which is where the drawer click happens.
  await expect(marblerRows(page)).toHaveCount(1, { timeout: 30_000 });
  await page.locator(".boop-panel .dtable-row", { hasText: "net-lane-a" }).first().locator(".tt-twisty").click();
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

test("the waterfall canvas draws the mail frames", async ({ page }) => {
  resetStore();
  seedLane({ lane: "wf-lane-a", cwd: "/tmp/e2e-net/a", state: "live", goal: "waterfall a", spawnedTs: Date.now() - 60_000 });
  seedLane({ lane: "wf-lane-b", parent: "wf-lane-a", cwd: "/tmp/e2e-net/b", state: "live", goal: "waterfall b", spawnedTs: Date.now() - 30_000 });
  seedMail({ id: "wf-m1", from: "wf-lane-a", to: "wf-lane-b", kind: "note", body: "waterfall mail", ageSec: 10 });

  const errors = await boot(page);
  await openBoop(page);
  await expect(page.locator('[data-testid="waterfall-pixi"]')).toBeVisible({ timeout: 30_000 });
  // Poll the composited pixels: a blank waterfall fails, a drawn frame passes.
  await expect
    .poll(() => screenshotInk(page, '[data-testid="waterfall-pixi"]'), { timeout: 15_000 })
    .toBeGreaterThan(0);
  await shot(page, "05-waterfall");
  expect([...errors.page, ...errors.console], [...errors.page, ...errors.console].join("\n")).toEqual([]);
});

test("roster selection narrows the network to the subtree", async ({ page }) => {
  resetStore();
  seedLane({ lane: "narrow-root", cwd: "/tmp/e2e-net/root", state: "live", goal: "root", spawnedTs: Date.now() - 90_000 });
  seedLane({ lane: "narrow-child", parent: "narrow-root", cwd: "/tmp/e2e-net/child", state: "live", goal: "child", spawnedTs: Date.now() - 40_000 });
  seedLane({ lane: "narrow-other", cwd: "/tmp/e2e-net/other", state: "live", goal: "other", spawnedTs: Date.now() - 20_000 });

  const errors = await boot(page);
  await openBoop(page);
  // Collapsed: the child is hidden from the timeline, so two roots show.
  await expect(marblerRows(page)).toHaveCount(2, { timeout: 30_000 });
  await expect(marblerRows(page).filter({ hasText: "narrow-child" })).toHaveCount(0);
  // Selecting the root drills into its full active subtree, including the
  // collapsed child, and drops the sibling subtree.
  const rootRow = page.locator(".boop-panel .dtable-row", { has: page.locator("td", { hasText: "narrow-root" }) }).first();
  await rootRow.click();
  await expect(page.locator(".boop-narrow")).toBeVisible({ timeout: 10_000 });
  await expect(marblerRows(page)).toHaveCount(2, { timeout: 10_000 });
  await expect(marblerRows(page).filter({ hasText: "narrow-child" })).toHaveCount(1);
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

test("active-only shows live agents collapsed and hoists a live grandchild through an idle parent", async ({ page }) => {
  resetStore();
  seedLane({ lane: "act-root", cwd: "/tmp/e2e-net/act-root", state: "live", goal: "act root", spawnedTs: Date.now() - 90_000 });
  seedLane({ lane: "act-mid", parent: "act-root", cwd: "/tmp/e2e-net/act-mid", state: "dead", goal: "act mid", spawnedTs: Date.now() - 80_000 });
  seedLane({ lane: "act-leaf", parent: "act-mid", cwd: "/tmp/e2e-net/act-leaf", state: "live", goal: "act leaf", spawnedTs: Date.now() - 40_000 });
  seedLane({ lane: "act-dead", cwd: "/tmp/e2e-net/act-dead", state: "dead", goal: "act dead", spawnedTs: Date.now() - 300_000 });
  seedMail({ id: "act-m1", from: "act-root", to: "act-leaf", kind: "note", body: "hoist mail", ageSec: 20 });

  const errors = await boot(page);
  await openBoop(page);

  // Roster: only the live root paints; the idle middle and dead sibling are gone.
  await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator(".boop-panel")).toContainText("2 hidden by active-only");
  await expect(page.locator(".boop-panel .dtable-row", { hasText: "act-mid" })).toHaveCount(0);
  await expect(page.locator(".boop-panel .dtable-row", { hasText: "act-dead" })).toHaveCount(0);

  // The lower marbler shares the roster's collapsed membership: one visible row.
  await expect(marblerRows(page)).toHaveCount(1, { timeout: 30_000 });
  await expect(marblerRows(page).filter({ hasText: "act-root" })).toHaveCount(1);

  // Expanding the live root reveals the hoisted live grandchild in BOTH panels,
  // and never the idle middle.
  const rootRow = page.locator(".boop-panel .dtable-row", { hasText: "act-root" }).first();
  await rootRow.locator(".tt-twisty").click();
  await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator(".boop-panel .dtable-row", { hasText: "act-leaf" })).toHaveCount(1);
  await expect(page.locator(".boop-panel .dtable-row", { hasText: "act-mid" })).toHaveCount(0);
  await expect(marblerRows(page)).toHaveCount(2, { timeout: 15_000 });
  await expect(marblerRows(page).filter({ hasText: "act-leaf" })).toHaveCount(1);
  await expect(marblerRows(page).filter({ hasText: "act-mid" })).toHaveCount(0);

  // Unchecking active-only exposes the full stored history; the middle row is
  // painted again but its child stays collapsed until expanded, in both panels.
  await page.locator(".boop-panel input[type=checkbox]").click();
  await expect(page.locator(".boop-panel .dtable-row")).toHaveCount(3, { timeout: 15_000 });
  await expect(page.locator(".boop-panel .dtable-row", { hasText: "act-mid" })).toHaveCount(1);
  await expect(page.locator(".boop-panel .dtable-row", { hasText: "act-dead" })).toHaveCount(1);
  await expect(marblerRows(page)).toHaveCount(3, { timeout: 15_000 });
  await expect(marblerRows(page).filter({ hasText: "act-leaf" })).toHaveCount(0);

  await shot(page, "06-active-only-hoist");
  expect([...errors.page, ...errors.console], [...errors.page, ...errors.console].join("\n")).toEqual([]);
});

test("timeline domain tracks mail activity and survives pan, refresh, and refocus", async ({ page }) => {
  resetStore();
  const startedAgo = Date.now() - 3_600_000;
  seedLane({ lane: "tl-root", cwd: "/tmp/e2e-net/tl-root", state: "live", goal: "tl root", spawnedTs: startedAgo });
  seedLane({ lane: "tl-peer", cwd: "/tmp/e2e-net/tl-peer", state: "live", goal: "tl peer", spawnedTs: startedAgo });
  seedMail({ id: "tl-m1", from: "tl-root", to: "tl-peer", kind: "note", body: "first", ageSec: 40 });
  seedMail({ id: "tl-m2", from: "tl-peer", to: "tl-root", kind: "result", body: "last", ageSec: 5 });

  const errors = await boot(page);
  await openBoop(page);
  await expect(page.locator(".boop-marbler .time-navigator canvas")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator(".boop-marbler .time-navigator")).toBeVisible();

  // Domain is mail-only. An hour-old lane start must not crush the two recent
  // frames: the earliest frame sits near the left edge, not pinned at the right.
  await expect(page.locator(".boop-master .boop-spark i").first()).toBeVisible({ timeout: 30_000 });
  const firstLeft = await page.locator(".boop-master .boop-spark i").first().evaluate((el) => parseFloat((el as HTMLElement).style.left));
  expect(firstLeft).toBeLessThan(50);

  const marbler = page.locator(".boop-marbler");
  const range = async () => {
    const raw = await marbler.getAttribute("data-visible");
    const [start, end] = (raw ?? "0:0").split(":").map(Number);
    return { start, end, span: end - start };
  };

  // Live-follow armed on first paint.
  await expect(marbler).toHaveAttribute("data-follow", "1");
  const before = await range();

  const nav = await page.locator(".boop-marbler .time-navigator").boundingBox();
  const cx = nav!.x + nav!.width / 2;
  const cy = nav!.y + nav!.height / 2;

  // Ctrl+wheel zoom shrinks the visible interval and turns follow off. Await the
  // span change rather than racing the React commit.
  await page.keyboard.down("Control");
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -120);
  await page.keyboard.up("Control");
  await expect(marbler).toHaveAttribute("data-follow", "0");
  await expect.poll(async () => (await range()).span, { timeout: 10_000 }).toBeLessThan(before.span);
  const zoomed = await range();

  // Scrub (drag) the zoomed navigator: the visible window moves within the
  // domain. A full-domain window cannot pan (clamped), so zoom runs first.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 60, cy, { steps: 5 });
  await page.mouse.up();
  await expect(marbler).toHaveAttribute("data-follow", "0");
  await expect.poll(async () => (await range()).start, { timeout: 10_000 }).not.toBe(zoomed.start);
  const panned = await range();

  // Refocus once to settle any layout work, then take the baseline the paused
  // viewport must hold.
  await page.locator('.dv-tab:has(.dv-default-tab-content:text-is("tmux"))').click();
  await expect(page.locator(".boop-panel")).toBeHidden();
  await page.locator('.dv-tab:has(.dv-default-tab-content:text-is("Boop"))').click();
  await expect(page.locator(".boop-panel")).toBeVisible();
  await expect(marbler).toHaveAttribute("data-follow", "0", { timeout: 15_000 });
  const baseline = await range();
  // The scrub moved and held through the refocus.
  expect(baseline).toEqual(panned);

  // A confirmed fresh mail (exactly two new frame dots: out on tl-root, in on
  // tl-peer) must not snap the paused interval back to the live tail.
  const dotsBefore = await page.locator(".boop-master .boop-spark i").count();
  seedMail({ id: "tl-m3", from: "tl-root", to: "tl-peer", kind: "note", body: "after pan", ageSec: 1 });
  await expect
    .poll(async () => page.locator(".boop-master .boop-spark i").count(), { timeout: 15_000 })
    .toBe(dotsBefore + 2);
  const after = await range();
  expect(after).toEqual(baseline);

  await shot(page, "07-timeline-viewport");
  expect([...errors.page, ...errors.console], [...errors.page, ...errors.console].join("\n")).toEqual([]);
});

test("a dense navigator scrolls to its last lane and stays hit-testable", async ({ page }) => {
  resetStore();
  const base = Date.now();
  for (let i = 1; i <= 40; i += 1) {
    seedLane({
      lane: `dense-${String(i).padStart(2, "0")}`,
      cwd: `/tmp/e2e-net/dense-${i}`,
      state: "live",
      goal: `dense ${i}`,
      // dense-40 is newest, so dense-01 sorts to the LAST navigator row.
      spawnedTs: base - (40 - i) * 1000,
    });
  }
  seedMail({ id: "dense-m1", from: "dense-01", to: "dense-40", kind: "note", body: "dense mail", ageSec: 30 });

  const errors = await boot(page);
  await openBoop(page);
  const scroll = page.locator('[data-testid="navigator-scroll"]');
  await expect(scroll).toBeVisible({ timeout: 30_000 });
  await expect(marblerRows(page).first()).toBeVisible({ timeout: 30_000 });

  // Bounded scroll container: natural canvas is taller than the viewport.
  const metrics = await scroll.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }));
  expect(metrics.sh).toBeGreaterThan(metrics.ch);
  const canvas = page.locator(".boop-marbler .time-navigator");
  expect((await canvas.boundingBox())!.height).toBeGreaterThan(metrics.ch);

  await scroll.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(async () => scroll.evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBeGreaterThan(0);

  // Last lane (dense-01, index 39) y = LANE_TOP + 39*14. laneLabels put the
  // plot left edge at 190; the sole mail's dot sits at the domain start there.
  const box = await canvas.boundingBox();
  const wrap = await scroll.boundingBox();
  const lastY = 10 + 39 * 14;
  const x = box!.x + 190;
  const y = box!.y + lastY;
  expect(y).toBeGreaterThanOrEqual(wrap!.y);
  expect(y).toBeLessThanOrEqual(wrap!.y + wrap!.height + 1);

  // Hit testing follows the compressed/scroll coordinates: hovering the last
  // lane's mark reports a hovered id.
  await page.mouse.move(x, y);
  await expect
    .poll(async () => page.locator(".boop-marbler").getAttribute("data-hovered"), { timeout: 10_000 })
    .toBeTruthy();

  await shot(page, "08-dense-navigator");
  expect([...errors.page, ...errors.console], [...errors.page, ...errors.console].join("\n")).toEqual([]);
});
