import { test, expect, type Page } from "@playwright/test";

// ⌘-hover / ⌘-click over a terminal token whose path hard-wraps across xterm
// rows. The terminal is resized narrow so a long path splits across two rows;
// the fix must join them so the hover underline and the dispatched token cover
// the WHOLE path, not just the fragment on the clicked row. Same mechanics as
// term-cmd-hover.spec.ts (see e2e/term.tsx for the write/point/resize hooks).

type TermHooks = {
  write: (data: string) => void;
  point: (row: number, col: number) => { x: number; y: number } | null;
  resize: (cols: number, rows: number) => void;
  dims: () => { cols: number; rows: number } | null;
};
declare global {
  interface Window {
    __term?: TermHooks;
  }
}

const PATH = "/tmp/term-e2e/src/mdview/MdPanel.tsx";
// 44 chars total; the path starts at joined offset 7 (after "Update(").
const LINE_WRAPPED = `Update(${PATH})`;
const NARROW_COLS = 30;

async function openNarrowTerm(page: Page) {
  await page.goto("/e2e-term.html?e2e=1");
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => !!window.__term?.point(0, 0));
  await page.evaluate((cols) => window.__term!.resize(cols, 24), NARROW_COLS);
  const dims = await page.evaluate(() => window.__term!.dims());
  // The fixture must actually wrap: the line has to be longer than the terminal.
  expect(dims?.cols).toBeLessThan(LINE_WRAPPED.length);
}

async function writeWrapped(page: Page) {
  await page.evaluate((line) => {
    window.__term!.write(`\x1b[2J\x1b[H${line}`);
  }, LINE_WRAPPED);
}

async function cmdHover(page: Page, row: number, col: number) {
  const point = await page.evaluate(
    ([r, c]) => window.__term!.point(r, c),
    [row, col] as const,
  );
  await page.keyboard.down("Meta");
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.move(point!.x + 1, point!.y);
}

const card = (page: Page) => page.locator(".term-inspector");

test.afterEach(async ({ page }) => {
  await page.keyboard.up("Meta").catch(() => {});
});

test("⌘-hover on either wrapped row names the whole path", async ({ page }) => {
  await openNarrowTerm(page);
  await writeWrapped(page);

  // Row 0 sits inside the first fragment: the card must name the full path.
  await cmdHover(page, 0, 10);
  await expect(card(page).locator("strong")).toHaveText(PATH);

  // Row 1 is the wrap continuation; hovering it must name the SAME full path.
  await cmdHover(page, 1, 0);
  await expect(card(page).locator("strong")).toHaveText(PATH);
  await cmdHover(page, 1, 3);
  await expect(card(page).locator("strong")).toHaveText(PATH);
});

test("⌘-hover on the wrapped path resolves to the real file", async ({ page }) => {
  await openNarrowTerm(page);
  await writeWrapped(page);

  await cmdHover(page, 1, 0);
  await expect(card(page).locator("strong")).toHaveText(PATH);
  await expect(card(page).locator("small")).toHaveText(PATH);
});

test("⌘-click on the wrapped continuation dispatches the whole path", async ({ page }) => {
  await openNarrowTerm(page);
  await writeWrapped(page);

  // Click a cell on the continuation row, inside the wrapped fragment.
  const point = await page.evaluate(() => window.__term!.point(1, 2));
  await page.keyboard.down("Meta");
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.click(point!.x, point!.y);

  await expect(page.locator(".dv-default-tab", { hasText: "MdPanel.tsx" })).toBeVisible();
  await expect(page.locator(".fs-preview .fs-preview-meta")).toContainText(PATH);
});

test("wrapped hover card snapshot", async ({ page }) => {
  await openNarrowTerm(page);
  await writeWrapped(page);

  await cmdHover(page, 1, 0);
  await expect(card(page).locator("small")).toHaveText(PATH);
  await expect(card(page)).toHaveScreenshot("cmd-hover-wrapped-card.png", { maxDiffPixelRatio: 0.02 });
});
