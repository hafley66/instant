// Real-browser regression for the Boop recipient dropdown (src/1_boopSelection.*).
// Chromium drives the built bundle served by instant-serve; boop's store and the
// tmux server are scratch (private BOOP_DB/BOOP_MAIL_DIR + TMUX_TMPDIR), so the
// spec never touches the owner's ~/.agent store or default tmux socket.
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

const routeA = "e2e-sel-alpha";
const routeB = "e2e-sel-beta";

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
const SESSIONS = ["boopsel-a", "boopsel-b"];
function killScratchSessions(): void {
  for (const session of SESSIONS) tmux(["kill-session", "-t", `=${session}`]);
}

/// One sleeping pane per route on the private socket, each title carrying the
/// route name so the dropdown's title column has real content.
function seedPanes(): { route: string; pane: string }[] {
  killScratchSessions();
  const out: { route: string; pane: string }[] = [];
  for (let i = 0; i < SESSIONS.length; i += 1) {
    const session = SESSIONS[i];
    const created = tmux(["-f", "/dev/null", "new-session", "-d", "-s", session, "sleep", "60000"]);
    expect(created.status, `tmux new-session ${session}: ${created.stderr}`).toBe(0);
    const pane = tmux(["list-panes", "-t", session, "-F", "#{pane_id}"]).stdout.trim();
    const route = i === 0 ? routeA : routeB;
    tmux(["select-pane", "-t", pane, "-T", `${route} scratch title`]);
    sql(
      `insert into agent_route(route, kind, harness, tmux, registered_at)
       values ('${route}', 'lane', 'claude', '${pane}', strftime('%Y-%m-%d %H:%M:%f000','now'))`,
    );
    out.push({ route, pane });
  }
  return out;
}

async function boot(page: Page): Promise<void> {
  await page.goto(`/?ws=ws://127.0.0.1:${port}/ws`);
  await expect(page.locator("#sessions-toggle")).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => document.fonts.status === "loaded");
}

/// Expand the tmux rail button's chevron so the dropdown's railContent mounts.
async function expand(page: Page): Promise<void> {
  const exp = page.locator("#sessions-toggle .actbar-exp");
  await expect(exp).toBeVisible({ timeout: 20_000 });
  if ((await exp.textContent()) === "▸") await exp.click();
  await expect(exp).toHaveText("▾");
  await expect(page.locator(".bs-panel")).toBeVisible({ timeout: 20_000 });
}

async function waitRows(page: Page): Promise<void> {
  await expect(page.locator(".bs-panel .dtable-row")).toHaveCount(2, { timeout: 25_000 });
}

test.beforeAll(() => {
  seedStore();
  seedPanes();
});

test.afterAll(() => {
  killScratchSessions();
});

test("checkbox is visible, checkable, and persists to the scratch store", async ({ page }) => {
  await boot(page);
  await expand(page);
  await waitRows(page);

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

  // Row height / type scale are readable, not the old 11px/22px.
  const rowBox = await page.locator(".bs-panel .dtable-row").first().boundingBox();
  expect(rowBox!.height).toBeGreaterThanOrEqual(32);
  const fontSize = await page.locator(".bs-panel .dtable").evaluate((el) => getComputedStyle(el).fontSize);
  expect(Number.parseFloat(fontSize)).toBeGreaterThanOrEqual(13);

  // First click checks it and writes the scratch store.
  await box.click();
  await expect(box).toBeChecked();
  await expect.poll(() => sql(`select selected from agent_route_selection where route='${routeA}'`)).toBe("1");

  // Second click unchecks it.
  await box.click();
  await expect(box).not.toBeChecked();
  await expect.poll(() => sql(`select selected from agent_route_selection where route='${routeA}'`)).toBe("0");

  // Keyboard focus shows a visible outline (Tab from the grid host).
  await page.locator(".bs-panel .tt-wrap").focus();
  await page.keyboard.press("Tab");
  const focusStyle = await box.evaluate((el) => {
    const c = getComputedStyle(el);
    return { outlineStyle: c.outlineStyle, outlineWidth: c.outlineWidth };
  });
  expect(focusStyle.outlineStyle).not.toBe("none");
  expect(Number.parseFloat(focusStyle.outlineWidth)).toBeGreaterThan(0);

  // Disabled is visibly dimmed, not an invisible control.
  const disabledOpacity = await box.evaluate((el) => {
    (el as HTMLInputElement).disabled = true;
    const o = getComputedStyle(el).opacity;
    (el as HTMLInputElement).disabled = false;
    return o;
  });
  expect(Number(disabledOpacity)).toBeLessThan(1);

  fs.mkdirSync(shots, { recursive: true });
  await page.locator(".bs-panel").screenshot({ path: path.join(shots, "boop-selection.png") });
});

test("drag resize changes the panel box and survives a reload", async ({ page }) => {
  await boot(page);
  await expand(page);
  await waitRows(page);

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
