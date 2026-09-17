// README capture: Chromium drives the built bundle served by instant-serve and
// writes the PNGs under docs/screenshots. Every session, turn, lane, and mail
// row is a scratch fixture on a private tmux socket and a scratch boop sqlite
// store, so a capture never touches the owner's store, default tmux server, or
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
       delete from agent_turn;
       delete from agent_favorite;`);
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

/// One turn the way an ingested transcript leaves it in boop's store.
function seedTurn(session: string, turn: number, role: string, said: string, harness = "codex"): void {
  sql(`insert or ignore into dict_session(value) values ('${session}')`);
  sql(`insert or ignore into dict_harness(value) values ('${harness}')`);
  sql(`insert or ignore into dict_role(value) values ('${role}')`);
  sql(`insert or ignore into agent_session(session_id, harness_id, cwd_id, started_ts)
       values ((select id from dict_session where value='${session}'),
               (select id from dict_harness where value='${harness}'), null, ${Date.now()})`);
  sql(`insert into agent_turn(session_id, turn, ts, role_id, said, cwd_id)
       values ((select id from dict_session where value='${session}'), ${turn}, ${Date.now()},
               (select id from dict_role where value='${role}'), '${said.replace(/'/g, "''")}', null)`);
}

// ---- scratch tmux sessions and panes ----

const SESSIONS = ["turn", "docs", "review", "api", "hub", "strip"];

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

/// Bind the pane to the boop session whose turns it shows, the way a lane
/// registration binds one, so the app's own projection places the turn.
function bindPane(session: string, route: string, harness = "codex"): void {
  const pane = tmux(["display-message", "-p", "-t", `${session}:`, "#{pane_id}"]).stdout.trim();
  sql(`insert or replace into agent_route(route, kind, harness, tmux, session_id, registered_at)
       values ('${route}', 'lane', '${harness}', '${pane}', '${session}',
               strftime('%Y-%m-%d %H:%M:%f000','now'))`);
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

async function screenRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const host = [...document.querySelectorAll<HTMLElement>(".term-host")].find((h) => h.getBoundingClientRect().width > 0);
    return [...(host?.querySelectorAll(".xterm-rows > div") ?? [])].map((d) => d.textContent ?? "");
  });
}

async function screenText(page: Page): Promise<string> {
  return (await screenRows(page)).join("\n");
}

/// Viewport pixel at the centre of a terminal cell of the visible host, read
/// from the measure element xterm sizes its rows with.
async function cell(page: Page, row: number, col: number): Promise<{ x: number; y: number }> {
  return page.evaluate(([r, c]) => {
    const host = [...document.querySelectorAll<HTMLElement>(".term-host")].find((h) => h.getBoundingClientRect().width > 0)!;
    const box = host.querySelector(".xterm-screen")!.getBoundingClientRect();
    const measure = host.querySelector(".xterm-char-measure-element")!.getBoundingClientRect();
    const cellW = measure.width / 32;
    return { x: Math.round(box.left + (c + 0.5) * cellW), y: Math.round(box.top + (r + 0.5) * measure.height) };
  }, [row, col]);
}

function typeLine(session: string, line: string): void {
  tmux(["send-keys", "-t", `${session}:`, line, "Enter"]);
}

const tmuxTab = (page: Page) => page.locator(".dv-tab", { hasText: "tmux" }).first();

/// Bring the sessions panel forward, then open one durable session by its row.
/// `openTab` in the row handler is the product's own attach path. The row is
/// matched on the session-name cell, not the whole row, so a cwd that happens
/// to contain the word cannot select the wrong session.
async function openSession(page: Page, session: string): Promise<void> {
  await tmuxTab(page).click();
  const row = page.locator(".dtable-row", { has: page.locator(".s-name", { hasText: new RegExp(`^${session}$`) }) }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
}

async function turnDebugOn(page: Page): Promise<void> {
  const button = page.locator("#turn-debug-toggle");
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

async function turnDebugOff(page: Page): Promise<void> {
  const button = page.locator("#turn-debug-toggle");
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "false");
}

/// The strip's own switch. Turning it on gives every terminal whose pane has a
/// session its own watcher, and the first frame needs no write from the pane.
async function squaresOn(page: Page): Promise<void> {
  const button = page.locator("#squares-toggle");
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

/// Poll until the debug overlay attributes a visible row to one of the turn
/// ids, proving the store projection has settled before the pointer is used.
async function waitForTurn(page: Page, turnId: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const host = [...document.querySelectorAll<HTMLElement>(".term-host")].find((h) => h.getBoundingClientRect().width > 0);
          return [...(host?.querySelectorAll<HTMLElement>(".term-turn-debug-row[data-turn-id]") ?? [])]
            .map((el) => el.dataset.turnId ?? "");
        }),
      { timeout: 30_000, message: `no row attributed to ${turnId}` },
    )
    .toContain(turnId);
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

async function shotElement(page: Page, selector: string, name: string): Promise<void> {
  fs.mkdirSync(shots, { recursive: true });
  await page.locator(selector).screenshot({ path: path.join(shots, `${name}.png`) });
}

// ---- the turn that carries both diagrams ----

const TURN_SESSION = "turn";
const TURN_ID = 42;
const D2_MARKER = "prompt -> terminal: type";
const MERMAID_MARKER = "turn --> diagram";

// What the harness prints for the turn: no backticks, the code under a bullet.
const turnBody = [
  "• Rendered inline from this turn's source.",
  "",
  "  direction: right",
  `  ${D2_MARKER}`,
  "  terminal -> diagram: render",
  "",
  // Blank rows let the overlay size the wide D2 graph past its four source
  // rows; the allocator only borrows rows that are actually blank.
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "",
  "  flowchart LR",
  `    ${MERMAID_MARKER}`,
  "    diagram --> favorite",
  "",
].join("\n");

// The same turn as the store holds it: the fences the harness stripped.
const turnSaid = [
  "Rendered inline from this turn's source.",
  "",
  "```d2",
  "direction: right",
  D2_MARKER,
  "terminal -> diagram: render",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  `  ${MERMAID_MARKER}`,
  "  diagram --> favorite",
  "```",
].join("\n");

const docsBody = [
  "instant session · docs",
  "======================",
  "",
  "$ just check",
  "tsc --noEmit",
  "0 errors",
  "",
].join("\n");

const reviewBody = [
  "instant session · review",
  "========================",
  "",
  " src/1_boopSelection.tsx  | 18 +++++-----",
  " src/0_boopSelection.ts   |  6 ++--",
  "",
  "3 files changed, 22 insertions(+), 11 deletions(-)",
  "",
  "$ _",
  "",
].join("\n");

// ---- the strip's own scene ----

const STRIP_SESSION = "strip";
const STRIP_ROUTE = "lane-strip";

// What the pane prints for the four turns: the harness markers the matcher
// normalises away, and a tool turn's own header line, which is how its `said`
// starts.
const stripBody = [
  "❯ make the strip draw one square per turn",
  "⏺ Four readers, one frame: capture, locate, layout, push.",
  "",
  "⏺ bash",
  "  pnpm vitest run - 726 passed",
  "",
  "⏺ Reading the store",
  "",
].join("\n");

// The same four turns as the store holds them: a one-line prompt, a long
// answer, a tool result and a short answer, which is what makes the strip's
// scale flex.
const stripTurns: ReadonlyArray<{ turn: number; role: string; said: string }> = [
  { turn: 11, role: "user", said: "make the strip draw one square per turn" },
  { turn: 12, role: "assistant", said: "Four readers, one frame: capture, locate, layout, push." },
  { turn: 13, role: "tool", said: "bash\npnpm vitest run - 726 passed" },
  { turn: 14, role: "assistant", said: "Reading the store" },
];

/// The turns the strip draws: the conversation's own, not the tools. The
/// fixture keeps a tool turn on purpose — the layout drops it, and the test
/// says so rather than counting four squares.
const stripDrawn = stripTurns.filter((turn) => turn.role === "user" || turn.role === "assistant");

async function showTurn(page: Page): Promise<void> {
  await openSession(page, TURN_SESSION);
  await expect(page.locator(".term-host .xterm-screen:visible")).toBeVisible({ timeout: 20_000 });
  const file = path.join(fixtures, "turn.txt");
  fs.writeFileSync(file, turnBody);
  typeLine(TURN_SESSION, "PS1=; stty -echo; clear; cat " + file);
  await expect.poll(() => screenText(page), { timeout: 30_000 }).toContain(D2_MARKER);
  await expect(page.locator('.term-diagram[data-language="d2"] > svg')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.term-diagram[data-language="mermaid"] svg')).toBeVisible({ timeout: 30_000 });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fs.mkdirSync(fixtures, { recursive: true });
  fs.mkdirSync(shots, { recursive: true });
  seedSchema();
  resetStore();
  killSessions();

  seedPane("turn");
  seedPane("docs");
  seedPane("review");
  seedPane("api", "lane-api");
  seedPane("hub", "lane-hub");

  // The turn both diagram and favorite scenes read, bound the way a lane is.
  seedTurn(TURN_SESSION, TURN_ID, "assistant", turnSaid);
  bindPane(TURN_SESSION, "turn-route");

  // The strip scene: its own pane and turns, bound so the app's own probe
  // resolves the session the feed watches. Seeded here with the rest so the
  // session row is on screen the moment the app boots.
  seedPane(STRIP_SESSION);
  bindPane(STRIP_SESSION, STRIP_ROUTE);
  for (const turn of stripTurns) seedTurn(STRIP_SESSION, turn.turn, turn.role, turn.said);

  // The selector reads routes whose live panes boop resolves through the
  // private tmux server; wait for both scratch coordinators before the tests
  // so a cold tmux boot cannot race the first assertion.
  await expect
    .poll(() => spawnSync(BOOP, ["beep", "selection", "list"], { env: boopEnv(), encoding: "utf8" }).stdout, {
      timeout: 20_000,
      message: "scratch coordinator routes never resolved through boop",
    })
    .toContain("lane-hub");

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

test("1. workspace: inline D2 and Mermaid from a terminal turn", async ({ page }) => {
  await boot(page);
  await openSession(page, "docs");
  fs.writeFileSync(path.join(fixtures, "docs.txt"), docsBody);
  typeLine("docs", "PS1=; clear; cat " + path.join(fixtures, "docs.txt"));
  await openSession(page, "review");
  fs.writeFileSync(path.join(fixtures, "review.txt"), reviewBody);
  typeLine("review", "PS1=; clear; cat " + path.join(fixtures, "review.txt"));

  await showTurn(page);
  await expect(page.locator('.term-diagram[data-language="d2"]')).toContainText("terminal");
  await expect(page.locator('.term-diagram[data-language="mermaid"]')).toContainText("favorite");
  await expect(page.locator('.term-diagram[data-language="d2"]')).toHaveAttribute("data-diagram-locator", `boop:${TURN_SESSION}:${TURN_ID}`);
  await page.waitForTimeout(700);
  await shot(page, "01-turn-diagrams");
});

test("2. favorite: right-click a turn into boop's favorites", async ({ page }) => {
  await boot(page);
  await showTurn(page);
  await turnDebugOn(page);
  await waitForTurn(page, `${TURN_SESSION}:${TURN_ID}`);
  await turnDebugOff(page);

  const rows = await screenRows(page);
  const row = rows.findIndex((line) => line.includes(D2_MARKER));
  expect(row, "the D2 source row is not on screen").toBeGreaterThan(-1);

  // The context menu identifies the turn and offers the favorite action.
  const at = await cell(page, row, 8);
  await page.mouse.click(at.x, at.y, { button: "right" });
  const menu = page.locator(".ctx-menu");
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu).toContainText(`Boop ${TURN_SESSION}:${TURN_ID} · assistant`);
  await expect(menu).toContainText("Tag this turn");
  const favRow = menu.locator("[data-nav-id]", { has: page.locator(".ctx-label", { hasText: "★" }) }).first();
  await expect(favRow).toBeVisible();
  await shot(page, "02-turn-favorite");

  // Favorite it. The note prompt carries an empty answer, which is the plain
  // star; the write goes through boop_favorite_toggle into the scratch store.
  await favRow.click();
  const prompt = page.locator(".cmdp-input");
  await expect(prompt).toBeVisible({ timeout: 10_000 });
  await prompt.press("Escape");

  await expect
    .poll(() => sql(`select count(*) from agent_favorite where source='turn:${TURN_SESSION}:${TURN_ID}'`), {
      timeout: 15_000,
      message: "the favorite never reached boop's scratch store",
    })
    .toBe("1");

  // The Favorites panel reads boop_favorites, so the row must survive a reload
  // and come back from the store rather than from page state.
  await page.reload();
  await expect(page.locator("#favorites-toggle")).toBeVisible({ timeout: 30_000 });
  await page.locator("#favorites-toggle").click();
  const favPanel = page.locator(".v2-panel", { has: page.locator(".spy-title", { hasText: "favorites" }) });
  await expect(favPanel).toBeVisible({ timeout: 20_000 });
  await expect(favPanel).toContainText(TURN_SESSION, { timeout: 20_000 });
  // Fold the session group open so the stored turn preview is on screen.
  const favGroup = favPanel.locator(".dtable-row", { hasText: TURN_SESSION }).first();
  await favGroup.dblclick();
  await expect(favPanel).toContainText("Rendered inline from this turn's source", { timeout: 10_000 });
  await page.waitForTimeout(500);
  await shotElement(page, ".v2-panel", "03-favorites-panel");
});

test("3. selector: check two open coordinator TUIs and send to the set", async ({ page }) => {
  await boot(page);
  await openSession(page, "api");
  await openSession(page, "hub");
  await expect(page.locator(".term-host .xterm-screen:visible")).toBeVisible({ timeout: 20_000 });

  const exp = page.locator("#sessions-toggle .actbar-exp");
  await expect(exp).toBeVisible({ timeout: 20_000 });
  if ((await exp.textContent()) === "▸") await exp.click();
  await expect(page.locator(".bs-panel")).toBeVisible({ timeout: 20_000 });

  await expect(page.locator(".bs-panel .dtable-row")).toHaveCount(2, { timeout: 25_000 });
  await expect(page.locator(".bs-panel")).toContainText("lane-api");
  await expect(page.locator(".bs-panel")).toContainText("lane-hub");

  const boxes = page.locator(".bs-panel input.bs-check");
  await expect(boxes).toHaveCount(2);
  await boxes.nth(0).click();
  await boxes.nth(1).click();
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).toBeChecked();
  await page.locator(".bs-panel .bs-body").fill("capture the selector frame");
  await expect(page.locator(".bs-panel .bs-send")).toHaveText(/\(2\)/);
  await page.waitForTimeout(300);
  await shotElement(page, ".bs-panel", "04-boop-recipient-selector");
});

test("4. roster: Boop lane graph and mail stream over scratch lanes", async ({ page }) => {
  await boot(page);
  await page.locator("#boop-toggle").click();
  await expect(page.locator(".boop-panel")).toBeVisible({ timeout: 20_000 });

  await expect.poll(() => page.locator(".boop-panel .dtable-row").count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  await expect(page.locator(".boop-panel")).toContainText("docs-hub");
  await expect(page.locator(".boop-panel")).toContainText("render-lane");
  await expect(page.locator(".boop-panel")).toContainText("docs-lane");
  await expect(page.locator(".boop-panel")).not.toContainText("store read failed");
  await page.waitForTimeout(1_500);
  await shotElement(page, ".boop-panel .boop-master", "05-boop-roster-mail");
});

test("5. squares: one square per turn in the terminal's right margin", async ({ page }) => {
  // What the server pushes for this page, which is also how the scene learns
  // which session the app bound the pane to.
  await page.addInitScript(() => {
    window.__squaresFrames = [];
    // The transport assigns `socket.onmessage`, so the hook belongs on the
    // property, not on addEventListener.
    const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
    Object.defineProperty(WebSocket.prototype, "onmessage", {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get: descriptor?.get,
      set(listener) {
        const wrapped = function (event) {
          try {
            const frame = JSON.parse(String(event.data));
            if (frame?.params?.event === "squares-update") window.__squaresFrames.push(frame.params.payload);
          } catch {}
          return listener.call(this, event);
        };
        descriptor?.set?.call(this, wrapped);
      },
    });
  });
  await boot(page);
  await openSession(page, STRIP_SESSION);
  await expect(page.locator(".term-host .xterm-screen:visible")).toBeVisible({ timeout: 20_000 });
  const file = path.join(fixtures, "strip.txt");
  fs.writeFileSync(file, stripBody);
  typeLine(STRIP_SESSION, "PS1=; stty -echo; clear; cat " + file);
  await expect.poll(() => screenText(page), { timeout: 30_000 }).toContain("one square per turn");

  // The strip places what the server measured: one square per attributed turn,
  // the reader's window as a block, and the terminal's right margin given up.
  await squaresOn(page);
  await expect
    .poll(() => page.evaluate(() => window.__squaresFrames.length), { timeout: 30_000, message: "no frame reached the page" })
    .toBeGreaterThan(0);

  // A live agent on the host can have this pane id in its own registry, and the
  // app's probe reads that registry before the seeded route: the session it
  // watches is then that agent's, not `strip`. Seed whichever session it bound,
  // so the scene proves the strip rather than the probe, then poke the pane so
  // the feed re-projects with the turns now in the store.
  const watched = await page.evaluate(() => window.__squaresFrames.at(-1).session);
  if (watched !== STRIP_SESSION) {
    for (const turn of stripTurns) seedTurn(watched, turn.turn, turn.role, turn.said);
    typeLine(STRIP_SESSION, "true");
  }

  await expect
    .poll(() => page.locator(".asq").count(), { timeout: 30_000, message: "the strip drew no squares" })
    .toBe(stripDrawn.length);
  // The tool turn is in the store and on the pane, and it draws nothing: the
  // strip is the conversation.
  await expect(page.locator('.asq[data-turn$=":13"]'), "a tool turn took a square").toHaveCount(0);
  await expect(page.locator(`.asq[data-turn='${watched}:12']`)).toHaveCount(1);
  await expect(page.locator(".asq[data-active='true']")).toHaveCount(1);
  await expect(page.locator(".term-host.asq-open")).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const host = [...document.querySelectorAll<HTMLElement>(".term-host")].find((h) => h.getBoundingClientRect().width > 0);
        const xterm = host?.querySelector<HTMLElement>(".xterm");
        // The measured element gives the margin up, not the host: FitAddon
        // subtracts the terminal element's padding and reads the host's border
        // box, so padding on the host is invisible to the fit.
        return xterm ? getComputedStyle(xterm).paddingRight : "";
      }),
    )
    .toBe("32px");
  // The squares are placed along the strip's track, not stacked at its origin.
  // The band lane is not the track, and the nodes are kept across frames, so
  // their DOM order is the order they first appeared rather than the order they
  // sit in: what the picture has to show is a spread.
  const spread = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".asq:not([data-band='true'])")].map((square) =>
      Number.parseFloat(square.style.getPropertyValue("--asq-y")),
    ),
  );
  expect(Math.max(...spread)).toBeGreaterThan(0);
  expect(new Set(spread).size).toBeGreaterThan(1);
  await page.waitForTimeout(700);
  await shot(page, "07-turn-strip");

  // The popover is CSS on a child rendered with the square, so the pointer
  // shows the turn's own words without a read.
  await page.locator(`.asq[data-turn='${watched}:12']`).hover();
  const pop = page.locator(".asq:hover .asq-pop");
  await expect(pop).toBeVisible({ timeout: 10_000 });
  await expect(pop).toContainText("assistant · turn 12");
  await expect(pop).toContainText("Four readers, one frame");
  // The reveal is a 110ms transition; shoot it settled, not mid-fade.
  await page.waitForTimeout(400);
  await shot(page, "08-turn-strip-popover");
});
