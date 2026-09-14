// README capture: Chromium drives the built bundle served by instant-serve and
// writes the PNGs under docs/screenshots. Every session, lane, and mail row is
// a scratch fixture on a private tmux socket and a scratch boop sqlite store,
// so a capture never touches the owner's store, default tmux server, or
// desktop. Screens assert visible feature content; there are no timestamp
// assertions. No model is called and nothing is really sent.
//
// Run through playwright.readme.config.ts:
//   corepack pnpm@10.12.4 exec playwright test --config playwright.readme.config.ts
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const port = Number(process.env.INSTANT_README_PORT ?? 47813);
const root = path.resolve(process.cwd());
const scratchRoot = process.env.INSTANT_README_TMP ?? `/private/tmp/instant-readme-${port}`;
const boopDir = path.join(scratchRoot, "boop");
const tmuxDir = path.join(scratchRoot, "tmux");
const boopDb = path.join(boopDir, "boop.db");
const BOOP = process.env.BOOP_BIN ?? path.join(process.env.HOME ?? "", ".cargo/bin/boop");
const shots = path.join(root, "docs", "screenshots");
const fixtures = path.join(scratchRoot, "fixtures");

// ---- scratch tmux + boop store ----

const tmuxEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.TMUX;
  env.TMUX_TMPDIR = tmuxDir;
  return env;
};
const tmux = (args: string[]) => spawnSync("tmux", args, { encoding: "utf8", env: tmuxEnv() });

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

function resetStore(): void {
  sql(`delete from agent_mail;
       delete from agent_delivery_transition;
       delete from agent_live;
       delete from agent_lane;
       delete from agent_route_selection;
       delete from agent_route;
       delete from agent_session;
       delete from agent_edge;
       delete from agent_turn;`);
}

function seedSchema(): void {
  fs.mkdirSync(boopDir, { recursive: true });
  fs.mkdirSync(tmuxDir, { recursive: true });
  const r = spawnSync(BOOP, ["beep", "selection", "list"], { env: boopEnv(), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`boop schema init: ${r.stderr}`);
}

interface LaneSeed {
  lane: string;
  parent?: string;
  cwd?: string;
  state?: "live" | "dead";
  goal?: string;
  spawnedTs: number;
}
function seedLane(seed: LaneSeed): void {
  const parentLaneId = seed.parent ? `(select id from dict_session where value='${seed.parent}')` : "NULL";
  const cwdId = seed.cwd ? `(select id from dict_cwd where value='${seed.cwd}')` : "NULL";
  sql(`insert or ignore into dict_session(value) values ('${seed.lane}')`);
  if (seed.parent) sql(`insert or ignore into dict_session(value) values ('${seed.parent}')`);
  if (seed.cwd) sql(`insert or ignore into dict_cwd(value) values ('${seed.cwd}')`);
  if (seed.state) sql(`insert or ignore into dict_status(value) values ('${seed.state}')`);
  const goal = (seed.goal ?? "").replace(/'/g, "''");
  sql(`insert into agent_lane(lane_id, cwd_id, parent_lane_id, goal, spawned_ts)
       values ((select id from dict_session where value='${seed.lane}'),
               ${cwdId}, ${parentLaneId}, '${goal}', ${seed.spawnedTs})`);
  sql(`insert or replace into agent_live(session_id, pid, status_id)
       values ((select id from dict_session where value='${seed.lane}'),
               ${seed.state === "dead" ? "NULL" : "4242"},
               (select id from dict_status where value='${seed.state ?? "live"}'))`);
}

const NOW_SQL = `CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER)`;
function seedMail(seed: { id: string; from: string; to: string; kind?: string; body?: string; ageSec: number }): void {
  const body = (seed.body ?? "").replace(/'/g, "''");
  const stamp = `strftime('%Y-%m-%d %H:%M:%f','now','-${seed.ageSec} seconds')`;
  sql(`insert or replace into agent_delivery_transition(message_id, sequence, route, outcome, detail, at_ms)
       values ('${seed.id}', 1, '${seed.to}', 'delivered', '', ${NOW_SQL})`);
  sql(`insert or replace into agent_mail(message_id, mailbox, from_route, to_route, from_timestamp, kind, body)
       values ('${seed.id}', 'bus', '${seed.from}', '${seed.to}', ${stamp}, '${seed.kind ?? "note"}', '${body}')`);
}

// ---- scratch tmux sessions and panes ----

const SESSIONS = ["readme-build", "readme-docs", "readme-review", "readme-api", "readme-hub"];

function killSessions(): void {
  for (const session of SESSIONS) tmux(["kill-session", "-t", `=${session}`]);
}

/// A live pane on the private socket; the pane title carries the route so the
/// Boop selection dropdown's title column has real content.
function seedPane(session: string, route?: string): void {
  const created = tmux(["-f", "/dev/null", "new-session", "-d", "-s", session, "bash", "--norc", "--noprofile"]);
  expect(created.status, `tmux new-session ${session}: ${created.stderr}`).toBe(0);
  if (route) {
    const pane = tmux(["list-panes", "-t", session, "-F", "#{pane_id}"]).stdout.trim();
    tmux(["select-pane", "-t", pane, "-T", `${route} coordinator`]);
    sql(`insert or replace into agent_route(route, kind, harness, tmux, registered_at)
         values ('${route}', 'coordinator', 'claude', '${pane}', strftime('%Y-%m-%d %H:%M:%f000','now'))`);
  }
}

// ---- page helpers ----

interface BootOpts {
  dark?: boolean;
}

async function boot(page: Page, opts: BootOpts = {}): Promise<void> {
  await page.addInitScript(
    ({ dark }) => {
      localStorage.setItem("skin", JSON.stringify("xp"));
      localStorage.setItem("mode", JSON.stringify(dark === false ? "light" : "dark"));
      localStorage.setItem("panicButton", JSON.stringify(false));
    },
    { dark: opts.dark },
  );
  await page.goto(`/?ws=ws://127.0.0.1:${port}/ws`);
  await expect(page.locator("#sessions-toggle")).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => document.fonts.status === "loaded");
}

async function screenText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const host = [...document.querySelectorAll<HTMLElement>(".term-host")].find((h) => h.getBoundingClientRect().width > 0);
    return [...(host?.querySelectorAll(".xterm-rows > div") ?? [])].map((d) => d.textContent ?? "").join("\n");
  });
}

function typeLine(session: string, line: string): void {
  tmux(["send-keys", "-t", `${session}:`, line, "Enter"]);
}

const tmuxTab = (page: Page) => page.locator(".dv-tab", { hasText: "tmux" }).first();

/// Bring the sessions panel forward, then open one durable session by its row.
/// `openTab` in the row handler is the product's own attach path.
async function openSession(page: Page, session: string): Promise<void> {
  await tmuxTab(page).click();
  const row = page.locator(".dtable-row", { hasText: session }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

async function shotElement(page: Page, selector: string, name: string): Promise<void> {
  fs.mkdirSync(shots, { recursive: true });
  await page.locator(selector).screenshot({ path: path.join(shots, `${name}.png`) });
}

// ---- fixtures ----

const diagramDoc = [
  "instant session · build",
  "=========================",
  "",
  "Agent output renders diagrams inline, in the terminal it was printed to.",
  "",
  "```d2",
  "coordinator -> lane_a: spawn",
  "coordinator -> lane_b: spawn",
  "lane_a -> result: finish",
  "lane_b -> result: finish",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "  prompt --> terminal",
  "  terminal --> diagram",
  "```",
  "",
  "Diagrams are drawn over the exact rows the fence occupied, so scrollback",
  "and turn attribution stay aligned with the terminal buffer.",
  "",
  "  session     agent       state",
  "  ----------  ----------  -------",
  "  build       claude      running",
  "  docs        opencode    running",
  "  review      shell       idle",
  "",
  "Next: open the Boop rail to choose which running TUIs receive a message.",
  "",
].join("\n");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fs.mkdirSync(fixtures, { recursive: true });
  fs.mkdirSync(shots, { recursive: true });
  seedSchema();
  resetStore();
  killSessions();

  // Scene 1 (workspace) and scene 2 (selector) sessions.
  seedPane("readme-build");
  seedPane("readme-docs");
  seedPane("readme-review");
  seedPane("readme-api", "readme-lane-api");
  seedPane("readme-hub", "readme-lane-hub");

  // The selector reads routes whose live panes boop resolves through the
  // private tmux server; wait for both scratch coordinators before the tests
  // so a cold tmux boot cannot race the first assertion.
  await expect
    .poll(() => spawnSync(BOOP, ["beep", "selection", "list"], { env: boopEnv(), encoding: "utf8" }).stdout, {
      timeout: 20_000,
      message: "scratch coordinator routes never resolved through boop",
    })
    .toContain("readme-lane-hub");

  // Scene 3 (roster/mail) synthetic lanes.
  const now = Date.now();
  seedLane({ lane: "docs-hub", cwd: "/Users/dev/instant", state: "live", goal: "README rewrite", spawnedTs: now - 90_000 });
  seedLane({ lane: "render-lane", parent: "docs-hub", cwd: "/Users/dev/instant", state: "live", goal: "capture screenshots", spawnedTs: now - 70_000 });
  seedLane({ lane: "docs-lane", parent: "docs-hub", cwd: "/Users/dev/instant/docs", state: "live", goal: "verify feature claims", spawnedTs: now - 50_000 });
  seedLane({ lane: "test-lane", parent: "render-lane", cwd: "/Users/dev/instant/e2e-real", state: "dead", goal: "playwright capture passed", spawnedTs: now - 130_000 });
  seedMail({ id: "r-1", from: "docs-hub", to: "render-lane", kind: "request", body: "capture the selector", ageSec: 60 });
  seedMail({ id: "r-2", from: "render-lane", to: "docs-hub", kind: "result", body: "3 frames written", ageSec: 30 });
  seedMail({ id: "r-3", from: "docs-hub", to: "docs-lane", kind: "note", body: "check FEATURES list", ageSec: 20 });
  seedMail({ id: "r-4", from: "test-lane", to: "render-lane", kind: "note", body: "capture green", ageSec: 12 });
});

test.afterAll(() => {
  killSessions();
});

test("1. workspace: durable tmux sessions render Mermaid and D2 inline", async ({ page }) => {
  await boot(page);
  await openSession(page, "readme-docs");
  await openSession(page, "readme-review");
  await openSession(page, "readme-build");
  await expect(page.locator(".term-host .xterm-screen:visible")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1_000);

  const doc = path.join(fixtures, "build.md");
  fs.writeFileSync(doc, diagramDoc);
  typeLine("readme-build", "PS1=; clear; cat " + doc);
  await expect.poll(() => screenText(page), { timeout: 30_000 }).toContain("Agent output renders diagrams inline");

  const diagrams = page.locator(".term-diagram");
  await expect(diagrams).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator('.term-diagram[data-language="d2"] > svg')).toBeVisible();
  await expect(page.locator('.term-diagram[data-language="mermaid"] svg')).toBeVisible();
  await expect(page.locator('.term-diagram[data-language="d2"]')).toContainText("coordinator");
  await expect(page.locator('.term-diagram[data-language="mermaid"]')).toContainText("prompt");
  await page.waitForTimeout(500);
  await shot(page, "01-workspace-diagrams");
});

test("2. selector: check two open coordinator TUIs and send to the set", async ({ page }) => {
  await boot(page);
  await openSession(page, "readme-api");
  await openSession(page, "readme-hub");
  await expect(page.locator(".term-host .xterm-screen:visible")).toBeVisible({ timeout: 20_000 });

  const exp = page.locator("#sessions-toggle .actbar-exp");
  await expect(exp).toBeVisible({ timeout: 20_000 });
  if ((await exp.textContent()) === "▸") await exp.click();
  await expect(page.locator(".bs-panel")).toBeVisible({ timeout: 20_000 });

  await expect(page.locator(".bs-panel .dtable-row")).toHaveCount(2, { timeout: 25_000 });
  await expect(page.locator(".bs-panel")).toContainText("readme-lane-api");
  await expect(page.locator(".bs-panel")).toContainText("readme-lane-hub");

  const boxes = page.locator(".bs-panel input.bs-check");
  await expect(boxes).toHaveCount(2);
  await boxes.nth(0).click();
  await boxes.nth(1).click();
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();
  await page.locator(".bs-panel .bs-body").fill("capture the selector frame");
  await expect(page.locator(".bs-panel .bs-send")).toHaveText(/\(2\)/);
  await page.waitForTimeout(300);
  await shotElement(page, ".bs-panel", "02-boop-recipient-selector");
});

test("3. roster: Boop lane graph and mail stream over scratch lanes", async ({ page }) => {
  await boot(page);
  await page.locator("#boop-toggle").click();
  await expect(page.locator(".boop-panel")).toBeVisible({ timeout: 20_000 });

  await expect.poll(() => page.locator(".boop-panel .dtable-row").count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  await expect(page.locator(".boop-panel")).toContainText("docs-hub");
  await expect(page.locator(".boop-panel")).toContainText("render-lane");
  await expect(page.locator(".boop-panel")).toContainText("docs-lane");
  await expect(page.locator(".boop-panel")).not.toContainText("store read failed");
  await page.waitForTimeout(1_500);
  await shotElement(page, ".boop-panel .boop-master", "03-boop-roster-mail");
});
