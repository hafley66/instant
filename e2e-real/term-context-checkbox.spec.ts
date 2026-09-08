// The gutter checkboxes must sit on their buffer rows: one repaint per
// terminal signal, positioned from cell geometry, never blanked while the rows
// they belong to are on screen. The pane is a real tmux shell painted with one
// assistant turn that boop's store holds and whose pane is bound to it, so the
// app's own projection places the boxes.
import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderConversationTurns } from "../scripts/3_claudeConversationReplay";
import {
  bindPaneSession, boot, burnClaimedPaneIds, cell, closeTabs, dropPaneSessions, dropSeededTurns,
  dropTabComments, findRow, killAllSessions, screenRows, seedTurn, shot, silentSessionPane, typeLine,
} from "./0_real";

const TURN = 402;

/// One assistant turn holding a 3-row markdown table (a header and two body
/// rows), a 3-item list and one heading: seven selectable rows, each of which
/// earns a gutter checkbox.
const SAID = [
  "CHECKBOX GEOMETRY FIXTURE",
  "",
  "## Geometry heading",
  "",
  "| Item | Visibility |",
  "| --- | --- |",
  "| alpha | visible |",
  "| beta | hidden |",
  "",
  "- first list item",
  "- second list item",
  "- third list item",
  "",
  "CHECKBOX GEOMETRY FIXTURE END",
].join("\n");

/// The source lines a checkbox is owed. Matched against the screen, so the
/// expected rows are read off the terminal rather than assumed.
const SELECTABLE_MARKS = [
  "## Geometry heading",
  "| Item | Visibility |",
  "| alpha | visible |",
  "| beta | hidden |",
  "- first list item",
  "- second list item",
  "- third list item",
];
const SELECTABLE_COUNT = SELECTABLE_MARKS.length;
const PROSE_LINE = "CHECKBOX GEOMETRY FIXTURE END";

const filler = (count: number, tag: string) =>
  Array.from({ length: count }, (_, index) => `${tag} ${index}`).join("\n");

// Filler above and below parks the turn in the middle of the viewport, so a
// scroll or a write moves it without pushing it off either edge.
const BODY = `${filler(6, "top filler")}\n`
  + `${renderConversationTurns([{ role: "assistant", subtype: null, said: SAID }]).replace(/\r\n/g, "\n")}`
  + `${filler(4, "tail filler")}\n`;

const dirs: string[] = [];
const tabs: string[] = [];

/// Every checkbox's row, read from its own style rather than its rect: the row
/// a box claims is its top over the cell height, so a fractional answer means
/// the box is parked between two rows.
function readGutter(marks: string[]) {
  const host = [...document.querySelectorAll<HTMLElement>(".term-host")]
    .find((candidate) => candidate.getBoundingClientRect().width > 0);
  const root = host?.querySelector<HTMLElement>(".term-context-root");
  const gutter = host?.querySelector<HTMLElement>(".term-context-gutter");
  const screen = host?.querySelector<HTMLElement>(".xterm-screen");
  if (!host || !root || !gutter || !screen) return null;
  const rows = [...host.querySelectorAll<HTMLElement>(".xterm-rows > div")];
  if (!rows.length) return null;
  const rootRect = root.getBoundingClientRect();
  const screenRect = screen.getBoundingClientRect();
  const cellHeight = screenRect.height / rows.length;
  const lines = rows.map((row) => row.textContent ?? "");
  const boxes = [...host.querySelectorAll<HTMLInputElement>(".term-context-structured-check")]
    .map((node) => {
      const top = rootRect.top + Number.parseFloat(node.style.top || "0");
      return { hidden: node.hidden, top, row: (top - screenRect.top) / cellHeight };
    });
  return {
    cellHeight,
    gutterHidden: gutter.hidden,
    boxes,
    lines,
    expectedRows: lines.flatMap((text, index) => marks.some((mark) => text.includes(mark)) ? [index] : []),
  };
}

type GutterSample = NonNullable<ReturnType<typeof readGutter>>;

const paintedRows = (state: GutterSample) =>
  state.boxes.filter((box) => !box.hidden).map((box) => Math.round(box.row)).sort((a, b) => a - b);

const offRow = (state: GutterSample) =>
  state.boxes.filter((box) => !box.hidden && Math.abs(box.row - Math.round(box.row)) > 0.2);

const sortedTops = (state: GutterSample) =>
  state.boxes.filter((box) => !box.hidden).map((box) => box.top).sort((a, b) => a - b);

async function sample(page: Page): Promise<GutterSample> {
  const value = await page.evaluate(readGutter, SELECTABLE_MARKS);
  expect(value).not.toBeNull();
  return value!;
}

/// Waits until the boxes agree with the screen, so a test that measures a move
/// starts from a settled paint.
async function settle(page: Page) {
  await expect.poll(async () => {
    const state = await sample(page);
    return `${paintedRows(state)} | ${state.gutterHidden}`;
  }, { timeout: 30_000, intervals: [200] }).toBe(`${(await sample(page)).expectedRows} | false`);
}

async function openFixture(page: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ctx-check-"));
  dirs.push(dir);
  await boot(page);
  burnClaimedPaneIds();
  const session = await silentSessionPane(page, dir, "checkbox fixture ready\n", "checkbox fixture ready");
  tabs.push(session);
  dropTabComments(session);
  // The turn is in boop's store, and the pane is bound to it the way a lane
  // registration binds one, before the pane paints the turn's own text.
  seedTurn(session, TURN, SAID);
  bindPaneSession(session);
  const body = join(dir, "turn.txt");
  writeFileSync(body, BODY);
  typeLine(session, `clear; cat ${body}`);
  await expect.poll(() => (screenRows(page)).then((rows) => rows.join("\n")), { timeout: 20_000 })
    .toContain(PROSE_LINE);
  await expect(page.locator(".term-context-structured-check:not([hidden])"))
    .toHaveCount(SELECTABLE_COUNT, { timeout: 30_000 });
  return session;
}

test.afterEach(async ({ page }) => {
  await closeTabs(page);
  for (const tab of tabs.splice(0)) dropTabComments(tab);
  dropSeededTurns();
  dropPaneSessions();
  killAllSessions();
});

test.afterAll(() => {
  killAllSessions();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("every structured row carries a checkbox as soon as the projection lands", async ({ page }) => {
  await openFixture(page);
  // The fixture tier timed this from its own projection log; the real receipt
  // is the settled paint: one box per selectable row, none hidden, none off row.
  const state = await sample(page);
  expect(state.gutterHidden).toBe(false);
  expect(state.boxes.filter((box) => box.hidden)).toEqual([]);
  expect(paintedRows(state)).toEqual(state.expectedRows);
  expect(offRow(state)).toEqual([]);
  await shot(page, "ctx-check-01-painted");
});

test("a scroll moves every checkbox by exactly the rows scrolled, hiding none", async ({ page }) => {
  const session = await openFixture(page);
  await settle(page);
  const before = await sample(page);

  // A wheel over the pane routes to tmux, which scrolls the pane two lines
  // into its history. Every 100 ms through the gesture the gutter is read.
  const at = await cell(page, findRow(session, "alpha"), 4);
  await page.mouse.move(at.x, at.y);
  const trace = page.evaluate(() => new Promise<Array<{ hidden: boolean }>>((resolve) => {
    const samples: Array<{ hidden: boolean }> = [];
    const tick = setInterval(() => {
      const gutter = document.querySelector<HTMLElement>(".term-context-gutter");
      const nodes = [...document.querySelectorAll<HTMLInputElement>(".term-context-structured-check")];
      samples.push({ hidden: !!gutter?.hidden || (nodes.length > 0 && nodes.every((node) => node.hidden)) });
    }, 100);
    setTimeout(() => { clearInterval(tick); resolve(samples); }, 3_000);
  }));
  await page.mouse.wheel(0, -2 * before.cellHeight);
  const samples = await trace;

  // The gutter never blanks, at any sample across the whole scroll.
  expect(samples.filter((entry) => entry.hidden)).toEqual([]);

  await settle(page);
  const after = await sample(page);
  expect(paintedRows(after)).toEqual(after.expectedRows);
  // Two rows of history above pushes every row two rows down the screen.
  const shift = 2 * before.cellHeight;
  const wanted = sortedTops(before);
  const landed = sortedTops(after);
  expect(landed).toHaveLength(wanted.length);
  for (let index = 0; index < wanted.length; index += 1) {
    expect(landed[index]).toBeCloseTo(wanted[index] + shift, 0);
  }
  await shot(page, "ctx-check-02-scrolled");
});

test("a write that scrolls the viewport leaves every checkbox on its row", async ({ page }) => {
  const session = await openFixture(page);
  for (let round = 0; round < 3; round += 1) {
    typeLine(session, `printf 'appended line ${round}a\\nappended line ${round}b\\n`
      + `appended line ${round}c\\nappended line ${round}d\\n'`);
    await expect.poll(() => screenRows(page).then((rows) => rows.join("\n")), { timeout: 20_000 })
      .toContain(`appended line ${round}d`);
    await settle(page);
    const state = await sample(page);
    expect(paintedRows(state)).toEqual(state.expectedRows);
    expect(offRow(state)).toEqual([]);
  }
  await shot(page, "ctx-check-03-written");
});

test("checkboxes stay on their rows while scrollback trims under the projection", async ({ page }) => {
  const session = await openFixture(page);
  await settle(page);
  // The app keeps no xterm scrollback (tmux owns history), so every written
  // line trims one off the top and each absolute row the last projection
  // recorded slides by one. Two frames after the parse is well inside the
  // projection's own rescan debounce: only a shift applied at paint time keeps
  // the boxes on their rows this soon.
  typeLine(session, "printf 'trimming line 1\\ntrimming line 2\\ntrimming line 3\\n'");
  await expect.poll(() => screenRows(page).then((rows) => rows.join("\n")), { timeout: 20_000 })
    .toContain("trimming line 3");
  await page.evaluate(() =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const state = await sample(page);
  expect(state.gutterHidden).toBe(false);
  expect(paintedRows(state)).toEqual(state.expectedRows);
  expect(offRow(state)).toEqual([]);
  await shot(page, "ctx-check-04-trimmed");
});

test("clicking a table row's checkbox queues that row", async ({ page }) => {
  await openFixture(page);
  await settle(page);
  const state = await sample(page);
  const alphaRow = state.lines.findIndex((text) => text.includes("| alpha | visible |"));
  expect(alphaRow).toBeGreaterThan(-1);
  const index = state.boxes.findIndex((box) => !box.hidden && Math.round(box.row) === alphaRow);
  expect(index).toBeGreaterThan(-1);
  await page.locator(".term-context-structured-check").nth(index).check();
  await expect(page.locator(".term-context-queue-quote")).toHaveText("| alpha | visible |");
  await shot(page, "ctx-check-05-queued");
});

test("the hover checkbox rides the same row geometry", async ({ page }) => {
  await openFixture(page);
  await settle(page);
  const state = await sample(page);
  const proseRow = state.lines.findIndex((text) => text.includes(PROSE_LINE));
  expect(proseRow).toBeGreaterThan(-1);
  const point = await cell(page, proseRow, 8);
  await page.mouse.move(point.x, point.y);
  const hover = page.locator(".term-context-hover-check");
  await expect(hover).toBeVisible();
  const top = await page.evaluate(() => {
    const host = [...document.querySelectorAll<HTMLElement>(".term-host")]
      .find((candidate) => candidate.getBoundingClientRect().width > 0)!;
    const root = host.querySelector<HTMLElement>(".term-context-root")!;
    const node = host.querySelector<HTMLElement>(".term-context-hover-check")!;
    return root.getBoundingClientRect().top + Number.parseFloat(node.style.top || "0");
  });
  expect(top + state.cellHeight / 2).toBeCloseTo(point.y, 0);
  await shot(page, "ctx-check-06-hover");
});
