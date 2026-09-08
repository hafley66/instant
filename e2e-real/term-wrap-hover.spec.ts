// ⌘-hover / ⌘-click over a real pane holding a path that hard-wraps across
// xterm rows. The viewport is narrowed so the app refits tmux and the path
// splits across rows; the fix must join them so the hover card and the
// dispatched token cover the WHOLE path.
import { expect, test, type Page } from "@playwright/test";
import { boot, cell, closeTabs, killAllSessions, openSilentPane, paneCommand, root, screenRows, shot, tmux } from "./0_real";

const PATH = `${root}/src/plugins/files/1_FileTree.tsx`;
const LINE_WRAPPED = `Update(${PATH})`;
const card = (page: Page) => page.locator(".term-inspector");

async function openNarrowTerm(page: Page): Promise<string> {
  const session = await openSilentPane(page, "\\033[2J\\033[Hready", "ready");
  await page.setViewportSize({ width: 480, height: 900 });
  // The app refits xterm and resizes the tmux pane; pane_width is tmux's cols.
  await expect.poll(() => Number(tmux(["display-message", "-p", "-t", `${session}:`, "#{pane_width}"]).trim()), {
    timeout: 15_000,
    message: `pane never narrowed under ${LINE_WRAPPED.length} cols`,
  }).toBeLessThan(LINE_WRAPPED.length);
  return session;
}

async function writeWrapped(session: string) {
  paneCommand(session, `printf '%b' '\\033[2J\\033[H${LINE_WRAPPED}'`);
}

async function cmdHover(page: Page, row: number, col: number) {
  const at = await cell(page, row, col);
  await page.keyboard.down("Meta");
  await page.mouse.move(at.x, at.y);
  await page.mouse.move(at.x + 1, at.y);
}

test.afterEach(async ({ page }) => {
  await page.keyboard.up("Meta").catch(() => {});
  await closeTabs(page);
});

test.afterAll(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
});

test("⌘-hover on either wrapped row names the whole path", async ({ page }) => {
  await boot(page);
  const session = await openNarrowTerm(page);
  await writeWrapped(session);
  await expect.poll(async () => (await screenRows(page))[0] ?? "").toMatch(/^Update\(/);

  // Row 0 sits inside the first fragment: the card must name the full path.
  await cmdHover(page, 0, 10);
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator("strong")).toHaveText(PATH);

  // Row 1 is the wrap continuation; hovering it must name the SAME full path.
  await cmdHover(page, 1, 0);
  await expect(card(page).locator("strong")).toHaveText(PATH);
  await cmdHover(page, 1, 3);
  await expect(card(page).locator("strong")).toHaveText(PATH);
  await shot(page, "term-wrap-hover-01-hover");
});

test("⌘-hover on the wrapped path resolves to the real file", async ({ page }) => {
  await boot(page);
  const session = await openNarrowTerm(page);
  await writeWrapped(session);
  await expect.poll(async () => (await screenRows(page))[0] ?? "").toMatch(/^Update\(/);

  await cmdHover(page, 1, 0);
  await expect(card(page)).toBeVisible();
  await expect(card(page).locator("strong")).toHaveText(PATH);
  // The card names the token, then the file it resolved to; the preview under
  // it carries a second <small> for the snippet tail.
  await expect(card(page).locator("small").first()).toHaveText(PATH);
  await shot(page, "term-wrap-hover-02-resolve");
});

test("⌘-click on the wrapped continuation dispatches the whole path", async ({ page }) => {
  await boot(page);
  const session = await openNarrowTerm(page);
  await writeWrapped(session);
  await expect.poll(async () => (await screenRows(page))[0] ?? "").toMatch(/^Update\(/);

  // Click a cell on the continuation row, inside the wrapped fragment.
  const at = await cell(page, 1, 2);
  await page.keyboard.down("Meta");
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);

  await expect(page.locator(".dv-default-tab", { hasText: "1_FileTree.tsx" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".fs-preview .fs-preview-meta")).toContainText(PATH);
  await shot(page, "term-wrap-hover-03-click");
});

test("wrapped hover card snapshot", async ({ page }) => {
  await boot(page);
  const session = await openNarrowTerm(page);
  await writeWrapped(session);
  await expect.poll(async () => (await screenRows(page))[0] ?? "").toMatch(/^Update\(/);

  await cmdHover(page, 1, 0);
  await expect(card(page)).toBeVisible();
  // The card names the token, then the file it resolved to; the preview under
  // it carries a second <small> for the snippet tail.
  await expect(card(page).locator("small").first()).toHaveText(PATH);
  await shot(page, "term-wrap-hover-04-card");
});
