// The pinned selection overlay on a real pane: the shell is put into the
// codex state (alternate screen, DECSET 1000/1002/1006) with printf, the way
// tmux forwards it. Receipts are the overlay's DOM rects, the clipboard, and
// capture-pane.
import { expect, test, type Page } from "@playwright/test";
import { boot, cell, clipboardText, closeTabs, killAllSessions, MOUSE_PANE, openSilentPane, paneCommand, paneScreen, shot, tmux } from "./0_real";

const PIN = ".term-pinned-selection";

async function dragCells(page: Page, row: number, from: number, to: number) {
  const start = await cell(page, row, from);
  const end = await cell(page, row, to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
}

async function openPane(page: Page): Promise<string> {
  return openSilentPane(page, `${MOUSE_PANE}\\033[2J\\033[Halpha beta gamma\\nsecond line\\nthird line`, "alpha beta gamma");
}

test.afterEach(async ({ page }) => {
  await closeTabs(page);
});

test.afterAll(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
});

test("a drag on a pane whose app owns the mouse selects, copies, and stays lit", async ({ page }) => {
  await boot(page);
  const session = await openPane(page);
  expect(paneScreen(session).join("\n")).toContain("alpha beta gamma");

  await dragCells(page, 0, 0, 9);
  await expect.poll(() => clipboardText(page)).toBe("alpha beta");
  await expect.poll(() => page.locator(PIN).count()).toBe(1);
  await page.waitForTimeout(600);
  await expect(page.locator(PIN)).toHaveCount(1); // the highlight stays lit
  await shot(page, "term-selection-pin-01-drag");
});

test("a pinned selection survives a terminal write that leaves its cells alone", async ({ page }) => {
  await boot(page);
  const session = await openPane(page);
  await dragCells(page, 0, 0, 9);
  await expect.poll(() => clipboardText(page)).toBe("alpha beta");

  // Rewrite rows below the pin; the pane's own process repaints around it.
  paneCommand(session, "printf '%b' '\\033[3;1H\\033[Kthird line rewritten by the agent'");
  paneCommand(session, "printf '%b' '\\033[2;1H\\033[Ksecond line rewritten too'");
  await expect.poll(() => paneScreen(session).join("\n")).toContain("third line rewritten by the agent");
  await expect(page.locator(PIN)).toHaveCount(1);
  expect(paneScreen(session)[0]).toContain("alpha beta gamma");
  await shot(page, "term-selection-pin-02-survive");
});

test("a pinned selection drops when the next click lands or its own cells change", async ({ page }) => {
  await boot(page);
  const session = await openPane(page);
  await dragCells(page, 0, 0, 9);
  await expect.poll(() => clipboardText(page)).toBe("alpha beta");

  const click = await cell(page, 2, 2);
  await page.mouse.click(click.x, click.y);
  await expect.poll(() => page.locator(PIN).count()).toBe(0);

  await dragCells(page, 0, 0, 9);
  await expect.poll(() => clipboardText(page)).toBe("alpha beta");
  // The pane rewrites the pinned row itself; the highlight must not lie.
  paneCommand(session, "printf '%b' '\\033[1;1H\\033[Kdelta epsilon zeta'");
  await expect.poll(() => page.locator(PIN).count()).toBe(0);
  await shot(page, "term-selection-pin-03-drop");
});

test("a pane with no mouse tracking keeps xterm's own selection and paints no pin", async ({ page }) => {
  await boot(page);
  const session = await openSilentPane(page, "\\033[2J\\033[Halpha beta gamma\\nsecond line", "alpha beta gamma");
  // Every tab the app opens gets `mouse on` from the backend, so the reader
  // turns it off in the pane to get a terminal that reports no mouse at all.
  paneCommand(session, "tmux set mouse off");
  await expect.poll(() => tmux(["show-options", "-t", `${session}:`, "mouse"]).trim()).toBe("mouse off");
  await page.waitForTimeout(500);
  await dragCells(page, 0, 0, 9);

  // xterm's own selection layer paints the drag; no overlay rect appears.
  await expect.poll(async () => page.evaluate(() => {
    const layer = document.querySelector(".term-host .xterm-selection");
    return layer ? [...layer.children].reduce((w, c) => w + (c as HTMLElement).getBoundingClientRect().width, 0) : 0;
  })).toBeGreaterThan(0);
  await expect(page.locator(PIN)).toHaveCount(0);
  await shot(page, "term-selection-pin-04-xterm-selection");
});
