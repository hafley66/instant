import { expect, test, type Page } from "@playwright/test";
import { renderConversationTurns } from "../scripts/3_claudeConversationReplay";

// The gutter checkboxes must sit on their buffer rows the way the turn-debug
// overlay's row tags do: one repaint per terminal signal, positioned from cell
// geometry, never blanked while the rows they belong to are on screen.

type TermHooks = {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  point: (row: number, col: number) => { x: number; y: number } | null;
  scroll: (lines: number) => void;
  scrollback: (lines: number) => void;
  position: () => { viewportY: number; baseY: number; length: number; rows: number } | null;
  screen: () => string[];
};

declare global {
  interface Window {
    __instantE2eNativeResults?: Record<string, unknown>;
    __term?: TermHooks;
    __visibleTurnEvents?: Array<{ visible: Array<{ id: string }> }>;
  }
}

const COLS = 120;
const ROWS = 30;

/// One assistant turn holding a 3-row markdown table (a header and two body
/// rows), a 3-item list and one heading: seven selectable rows, each of which
/// earns a gutter checkbox.
const FIXTURE_TURN = {
  session: "e2e-codex-1",
  harness: "codex",
  turn: 401,
  ts: Date.now(),
  role: "assistant",
  subtype: null,
  said: [
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
  ].join("\n"),
};

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
  Array.from({ length: count }, (_, index) => `${tag} ${index}\r\n`).join("");

// Filler above and below parks the turn in the middle of the viewport, so a
// scroll or a write moves it without pushing it off either edge.
const OUTPUT = `\u001b[2J\u001b[H${filler(20, "top filler")}`
  + `${renderConversationTurns([FIXTURE_TURN])}${filler(6, "tail filler")}`;

/// Every checkbox's row, read from its own style rather than its rect: the row
/// a box claims is its top over the cell height, so a fractional answer means
/// the box is parked between two rows.
function readGutter(marks: string[]) {
  const root = document.querySelector<HTMLElement>(".term-context-root");
  const gutter = document.querySelector<HTMLElement>(".term-context-gutter");
  const screen = document.querySelector<HTMLElement>(".xterm-screen");
  const position = window.__term!.position();
  if (!root || !gutter || !screen || !position) return null;
  const rootRect = root.getBoundingClientRect();
  const screenRect = screen.getBoundingClientRect();
  const cellHeight = screenRect.height / position.rows;
  const lines = window.__term!.screen();
  const boxes = [...document.querySelectorAll<HTMLInputElement>(".term-context-structured-check")]
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
  }, { timeout: 4000, intervals: [32] }).toBe(`${(await sample(page)).expectedRows} | false`);
}

async function openFixture(page: Page, scrollback = 0) {
  await page.goto("/e2e-term.html?e2e=1&noSidebar=1&harness=codex");
  await page.evaluate((turn) => {
    window.__instantE2eNativeResults!.boop_turns = [turn];
  }, FIXTURE_TURN);
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible();
  await page.waitForFunction(() => !!window.__term?.point(0, 0));
  await page.evaluate(({ output, lines, cols, rows }) => {
    if (lines) window.__term!.scrollback(lines);
    window.__term!.resize(cols, rows);
    window.__term!.write(output);
  }, { output: OUTPUT, lines: scrollback, cols: COLS, rows: ROWS });
  await expect(page.locator(".xterm-rows")).toContainText(PROSE_LINE);
  // The projection names the selectable rows, so the clock on "appears at
  // once" starts when its first scan lands.
  await page.waitForFunction(() => !!window.__visibleTurnEvents?.some((event) => event.visible.length > 0));
}

test("every structured row carries a checkbox as soon as the projection lands", async ({ page }) => {
  await openFixture(page);
  await expect.poll(
    () => page.locator(".term-context-structured-check:not([hidden])").count(),
    { timeout: 200, intervals: [16] },
  ).toBe(SELECTABLE_COUNT);
  const state = await sample(page);
  expect(state.gutterHidden).toBe(false);
  expect(state.boxes.filter((box) => box.hidden)).toEqual([]);
  expect(paintedRows(state)).toEqual(state.expectedRows);
  expect(offRow(state)).toEqual([]);
});

test("a scroll moves every checkbox by exactly the rows scrolled, hiding none", async ({ page }) => {
  await openFixture(page, 400);
  await page.evaluate(() => window.__term!.scroll(-6));
  await settle(page);
  const before = await sample(page);

  const trace = await page.evaluate(async () => {
    const gutter = document.querySelector<HTMLElement>(".term-context-gutter")!;
    const read = () => {
      const nodes = [...document.querySelectorAll<HTMLInputElement>(".term-context-structured-check")];
      return {
        hidden: gutter.hidden || nodes.some((node) => node.hidden),
        tops: nodes.map((node) => Math.round(Number.parseFloat(node.style.top || "0"))).sort((a, b) => a - b),
      };
    };
    const samples: Array<ReturnType<typeof read>> = [];
    window.__term!.scroll(2);
    for (let tick = 0; tick < 30; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 16));
      samples.push(read());
    }
    return samples;
  });

  // The gutter never blanks, at any 16 ms sample across the whole scroll.
  expect(trace.filter((entry) => entry.hidden)).toEqual([]);
  // No debounce: the move is done a couple of frames in and stays put.
  expect(trace[2].tops).toEqual(trace.at(-1)!.tops);

  const after = await sample(page);
  expect(paintedRows(after)).toEqual(after.expectedRows);
  const shift = 2 * before.cellHeight;
  const wanted = sortedTops(before);
  const landed = sortedTops(after);
  expect(landed).toHaveLength(wanted.length);
  for (let index = 0; index < wanted.length; index++) {
    expect(landed[index]).toBeCloseTo(wanted[index] - shift, 0);
  }
});

test("a write that scrolls the viewport leaves every checkbox on its row", async ({ page }) => {
  await openFixture(page);
  for (let round = 0; round < 3; round++) {
    await page.evaluate((round) => {
      window.__term!.write(`appended line ${round}a\r\nappended line ${round}b\r\n`
        + `appended line ${round}c\r\nappended line ${round}d\r\n`);
    }, round);
    await expect(page.locator(".xterm-rows")).toContainText(`appended line ${round}d`);
    await settle(page);
    const state = await sample(page);
    expect(paintedRows(state)).toEqual(state.expectedRows);
    expect(offRow(state)).toEqual([]);
  }
});

test("checkboxes stay on their rows while scrollback trims under the projection", async ({ page }) => {
  await openFixture(page);
  // Scrollback is zero, so every written line trims one off the top and each
  // absolute row the last projection recorded slides by one. Two frames after
  // the parse is well inside the projection's own rescan debounce: only a
  // shift applied at paint time keeps the boxes on their rows this soon.
  await page.evaluate(() =>
    window.__term!.write("trimming line 1\r\ntrimming line 2\r\ntrimming line 3\r\n"));
  await page.waitForFunction(() => window.__term!.screen().some((line) => line.includes("trimming line 3")));
  await page.evaluate(() =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const state = await sample(page);
  expect(state.gutterHidden).toBe(false);
  expect(paintedRows(state)).toEqual(state.expectedRows);
  expect(offRow(state)).toEqual([]);
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
});

test("the hover checkbox rides the same row geometry", async ({ page }) => {
  await openFixture(page);
  await settle(page);
  const state = await sample(page);
  const proseRow = state.lines.findIndex((text) => text.includes(PROSE_LINE));
  expect(proseRow).toBeGreaterThan(-1);
  const point = (await page.evaluate((row) => window.__term!.point(row, 8), proseRow))!;
  await page.mouse.move(point.x, point.y);
  const hover = page.locator(".term-context-hover-check");
  await expect(hover).toBeVisible();
  const top = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".term-context-root")!;
    const node = document.querySelector<HTMLElement>(".term-context-hover-check")!;
    return root.getBoundingClientRect().top + Number.parseFloat(node.style.top || "0");
  });
  expect(top + state.cellHeight / 2).toBeCloseTo(point.y, 0);
});
