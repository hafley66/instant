// Real-browser regression for the Boop recipient dropdown (src/1_boopSelection.*).
// Chromium drives the built bundle served by instant-serve; boop's store and the
// tmux server are scratch (private BOOP_DB/BOOP_MAIL_DIR + TMUX_TMPDIR), so the
// spec never touches the owner's ~/.agent store or default tmux socket.
//
// The dropdown lists only coordinator/native routes whose live pane is reached
// by an open Instant terminal tab. These cases seed a coordinator (tab open), a
// lane (pane live, excluded by kind), and a second coordinator with no tab
// (excluded by the open-tab intersection). Only the first tab is opened in the
// real UI: the persisted open-tab list is seeded before boot and the app opens
// (reattaches) it through the normal restore path.
//
// Receipts are DOM geometry + boop's own sqlite rows. No live send: the composer
// is exercised only through the checkbox/selection half of the feature.
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.INSTANT_BOOP_PORT ?? 47801);
const scratchRoot = process.env.INSTANT_BOOP_TMP ?? `/tmp/instant-boop-sel-${port}`;
const boopDir = path.join(scratchRoot, "boop");
const tmuxDir = path.join(scratchRoot, "tmux");
const boopDb = path.join(boopDir, "boop.db");
const BOOP = process.env.BOOP_BIN ?? path.join(process.env.HOME ?? "", ".cargo/bin/boop");
const shots = path.join(process.cwd(), "artifacts", "real");

const routeCoord = "e2e-sel-coord";
const routeLane = "e2e-sel-lane";
const routeClosed = "e2e-sel-closed";

const sessionCoord = "boopsel-coord";
const sessionLane = "boopsel-lane";
const sessionClosed = "boopsel-closed";

/// tmux with the runner's TMUX stripped, scoped to our private TMUX_TMPDIR.
const tmuxEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.TMUX;
  env.TMUX_TMPDIR = tmuxDir;
  return env;
};
const tmux = (args: string[]) => spawnSync("tmux", args, { encoding: "utf8", env: tmuxEnv() });

/// boop pointed at the scratch store and socket only.
const boopEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.TMUX;
  env.TMUX_TMPDIR = tmuxDir;
  env.BOOP_DB = boopDb;
  env.BOOP_MAIL_DIR = boopDir;
  env.BOOP_NO_SYNC = "1";
  return env;
};

const sql = (query: string): string => {
  const r = spawnSync("sqlite3", ["-cmd", ".timeout 5000", boopDb, query], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sqlite3: ${r.stderr}`);
  return r.stdout.trim();
};

function seedStore(): void {
  fs.mkdirSync(boopDir, { recursive: true });
  fs.mkdirSync(tmuxDir, { recursive: true });
  // Let boop create the schema, then wipe any rows a previous run left.
  spawnSync(BOOP, ["beep", "selection", "list"], { env: boopEnv(), encoding: "utf8" });
  sql("delete from agent_route_selection; delete from agent_route;");
}

/// Kill only this run's sessions. The tmux guard refuses `kill-server` on
/// anything but an explicit `-L` socket, and we deliberately run on the
/// private TMUX_TMPDIR's default socket so boop (which never passes -L) can
/// resolve the panes. Killing our own named sessions is the private teardown;
/// the empty server then exits on its own.
const SESSIONS = [sessionCoord, sessionLane, sessionClosed];
function killScratchSessions(): void {
  for (const session of SESSIONS) tmux(["kill-session", "-t", `=${session}`]);
}

/// One sleeping pane per route on the private socket, each title carrying the
/// route name so the dropdown's title column has real content. The coordinator
/// has a tab open; the lane is a recipient-excluded kind; the second
/// coordinator has a live pane but no tab.
function seedPanes(): void {
  killScratchSessions();
  const rows: { session: string; route: string; kind: string }[] = [
    { session: sessionCoord, route: routeCoord, kind: "coordinator" },
    { session: sessionLane, route: routeLane, kind: "lane" },
    { session: sessionClosed, route: routeClosed, kind: "coordinator" },
  ];
  for (const { session, route, kind } of rows) {
    const created = tmux(["-f", "/dev/null", "new-session", "-d", "-s", session, "sleep", "60000"]);
    expect(created.status, `tmux new-session ${session}: ${created.stderr}`).toBe(0);
    const pane = tmux(["list-panes", "-t", session, "-F", "#{pane_id}"]).stdout.trim();
    tmux(["select-pane", "-t", pane, "-T", `${route} scratch title`]);
    sql(
      `insert into agent_route(route, kind, harness, tmux, registered_at)
       values ('${route}', '${kind}', 'claude', '${pane}', strftime('%Y-%m-%d %H:%M:%f000','now'))`,
    );
  }
  // Retained DB selection on rows the dropdown will not show. A count or send
  // that reads retained state instead of the visible set would include these.
  sql(
    `insert into agent_route_selection(route, selected) values ('${routeLane}', 1), ('${routeClosed}', 1)`,
  );
}

async function boot(page: Page): Promise<void> {
  await page.goto(`/?ws=ws://127.0.0.1:${port}/ws`);
  await expect(page.locator("#sessions-toggle")).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => document.fonts.status === "loaded");
}

/// Open the coordinator's terminal by clicking its row in the tmux panel: the
/// product's own openTab path, after the dock is ready. This is what makes the
/// coordinator "open in the real UI"; the lane and closed coordinator stay shut.
async function openCoordTab(page: Page): Promise<void> {
  const row = page.locator(".dtable-row", { hasText: sessionCoord }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
}

/// Expand the tmux rail button's chevron so the dropdown's railContent mounts.
async function expand(page: Page): Promise<void> {
  const exp = page.locator("#sessions-toggle .actbar-exp");
  await expect(exp).toBeVisible({ timeout: 20_000 });
  if ((await exp.textContent()) === "▸") await exp.click();
  await expect(exp).toHaveText("▾");
  await expect(page.locator(".bs-panel")).toBeVisible({ timeout: 20_000 });
}

/// Only the coordinator with an open tab is listed.
async function waitVisibleRow(page: Page): Promise<void> {
  await expect(page.locator(".bs-panel .dtable-row")).toHaveCount(1, { timeout: 25_000 });
  await expect(page.locator(".bs-panel .dtable-row")).toContainText(routeCoord);
  await expect(page.locator(".bs-panel .dtable-row")).not.toContainText(routeLane);
  await expect(page.locator(".bs-panel .dtable-row")).not.toContainText(routeClosed);
}

test.beforeAll(() => {
  seedStore();
  seedPanes();
});

test.afterAll(() => {
  killScratchSessions();
});

test("only the open coordinator is listed; closed and lane rows stay hidden", async ({ page }) => {
  await boot(page);
  await expand(page);
  await openCoordTab(page);
  await waitVisibleRow(page);

  // The lane is a recipient-excluded kind and the closed coordinator has no
  // tab: neither row may appear even though both panes are live.
  await expect(page.locator(".bs-panel .dtable-row")).toHaveCount(1);
});

test("checkbox is visible, checkable, and count reads only the visible set", async ({ page }) => {
  await boot(page);
  await expand(page);
  await openCoordTab(page);
  await waitVisibleRow(page);

  const box = page.locator(".bs-panel input.bs-check").first();
  await expect(box).toBeVisible();

  const rect = await box.boundingBox();
  expect(rect, "checkbox has no box").not.toBeNull();
  expect(rect!.width).toBeGreaterThanOrEqual(20);
  expect(rect!.height).toBeGreaterThanOrEqual(20);

  const style = await box.evaluate((el) => {
    const c = getComputedStyle(el);
    return { appearance: c.appearance, position: c.position, opacity: c.opacity, cursor: c.cursor };
  });
  // The regression was xp.css making the standalone input invisible.
  expect(style.position).not.toBe("fixed");
  expect(Number(style.opacity)).toBe(1);
  expect(style.appearance).not.toBe("none");

  // The lane and closed coordinator are selected in the scratch store, but the
  // visible set has none checked: the count must be 0, not 2.
  const send = page.locator(".bs-panel .bs-send");
  await page.locator(".bs-panel .bs-body").fill("hello");
  await expect(send).toHaveText(/\(0\)/);
  await expect(send).toBeDisabled();

  // First click checks it and writes the scratch store.
  await box.click();
  await expect(box).toBeChecked();
  await expect.poll(() => sql(`select selected from agent_route_selection where route='${routeCoord}'`)).toBe("1");
  await expect(send).toHaveText(/\(1\)/);
  await expect(send).toBeEnabled();

  // Hidden retained selection is not erased by showing a filtered list.
  await expect.poll(() => sql(`select selected from agent_route_selection where route='${routeLane}'`)).toBe("1");
  await expect.poll(() => sql(`select selected from agent_route_selection where route='${routeClosed}'`)).toBe("1");

  // Second click unchecks it.
  await box.click();
  await expect(box).not.toBeChecked();
  await expect.poll(() => sql(`select selected from agent_route_selection where route='${routeCoord}'`)).toBe("0");
  await expect(send).toHaveText(/\(0\)/);

  fs.mkdirSync(shots, { recursive: true });
  await page.locator(".bs-panel").screenshot({ path: path.join(shots, "boop-selection.png") });
});

test("closing the tab drops the checked recipient from the count without a reload", async ({ page }) => {
  await boot(page);
  await expand(page);

  // Nothing is open yet: the coordinator row is not eligible, and neither
  // hidden row (lane, closed coordinator) counts toward the selection.
  await expect(page.locator(".bs-panel .bs-status")).toHaveText(/no open coordinator sessions/, { timeout: 25_000 });
  await expect(page.locator(".bs-panel .dtable-row")).toHaveCount(0);
  await page.locator(".bs-panel .bs-body").fill("hello");
  await expect(page.locator(".bs-panel .bs-send")).toHaveText(/\(0\)/);
  await expect(page.locator(".bs-panel .bs-send")).toBeDisabled();

  // Opening the coordinator in the real UI makes its row appear without a reload.
  await openCoordTab(page);
  await waitVisibleRow(page);

  const box = page.locator(".bs-panel input.bs-check").first();
  await box.click();
  await expect(box).toBeChecked();
  await expect(page.locator(".bs-panel .bs-send")).toHaveText(/\(1\)/);

  // A real UI close (the dockview tab's close action) must reactively remove the
  // row: the panel subscribes to the open-tab signal, so no reload is needed.
  // The tab title follows the tmux pane title, which carries the route name.
  const closeAction = page
    .locator(".dv-tab", { hasText: new RegExp(`${sessionCoord}|${routeCoord}`) })
    .locator(".dv-default-tab-action")
    .first();
  await expect(closeAction).toBeVisible({ timeout: 10_000 });
  await closeAction.click();

  await expect(page.locator(".bs-panel .dtable-row")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator(".bs-panel .bs-send")).toHaveText(/\(0\)/);
  await expect(page.locator(".bs-panel .bs-send")).toBeDisabled();
  // The retained checkbox survives for when the tab reopens.
  await expect.poll(() => sql(`select selected from agent_route_selection where route='${routeCoord}'`)).toBe("1");
});

test("drag resize changes the panel box and survives a reload", async ({ page }) => {
  await boot(page);
  await expand(page);
  await openCoordTab(page);
  await waitVisibleRow(page);

  const panel = page.locator(".bs-panel");
  const before = (await panel.boundingBox())!;
  expect(before.width).toBeGreaterThanOrEqual(600);

  // Native `resize: both` grip lives in the bottom-right corner.
  const cornerX = before.x + before.width - 3;
  const cornerY = before.y + before.height - 3;
  await page.mouse.move(cornerX, cornerY);
  await page.mouse.down();
  await page.mouse.move(cornerX + 140, cornerY + 90, { steps: 14 });
  await page.mouse.up();

  await expect
    .poll(async () => (await panel.boundingBox())!.width, { timeout: 10_000 })
    .toBeGreaterThan(before.width + 60);
  const after = (await panel.boundingBox())!;
  expect(after.height).toBeGreaterThan(before.height + 30);

  // The ResizeObserver persisted it into this plugin's own slice.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = JSON.parse(localStorage.getItem("pluginState") ?? "{}") as Record<string, { width?: number; height?: number }>;
        return raw.boopSelectionPanel?.width ?? 0;
      }),
    )
    .toBeGreaterThan(before.width + 60);

  // A reload remounts the rail; the chosen size must come back.
  await page.reload();
  await expect(page.locator("#sessions-toggle")).toBeVisible({ timeout: 30_000 });
  await expand(page);
  await expect
    .poll(async () => (await panel.boundingBox())!.width, { timeout: 10_000 })
    .toBeGreaterThan(before.width + 60);
});

test("Alt+Arrow is the keyboard resize alternative", async ({ page }) => {
  await boot(page);
  await expand(page);
  await openCoordTab(page);
  await waitVisibleRow(page);
  const panel = page.locator(".bs-panel");
  const before = (await panel.boundingBox())!;
  await page.locator(".bs-panel .tt-wrap").focus();
  await page.keyboard.down("Alt");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.up("Alt");
  await expect
    .poll(async () => (await panel.boundingBox())!.width, { timeout: 5_000 })
    .toBeGreaterThan(before.width);
});
