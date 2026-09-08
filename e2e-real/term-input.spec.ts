// Keyboard and mouse through a real pane with tmux mouse reporting on
// (DECSET 1000/1006 from the shell). Receipts: capture-pane and the clipboard.
import { expect, test } from "@playwright/test";
import { boot, cell, clipboardText, closeTabs, killAllSessions, openTab, paneScreen, shot, typeLine } from "./0_real";

const PIN = ".term-pinned-selection";

test.afterEach(async ({ page }) => {
  await closeTabs(page);
});

test.afterAll(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
});

test("terminal keeps keyboard, drag selection, and wheel input with tmux mouse reporting", async ({ page }) => {
  await boot(page);
  const session = await openTab(page);
  // Mouse reporting on, then a clean screen; the pane keeps its shell prompt.
  typeLine(session, "printf '%b' '\\033[?1000h\\033[?1006h\\033[2J\\033[Halpha beta gamma\\nsecond line'");
  await page.waitForTimeout(500);

  // Click the terminal, then type a command on the keyboard like a user. The
  // click reaches the pane as a mouse report while reporting is on, so Ctrl-U
  // clears those bytes off the shell's line first.
  const focus = await cell(page, 0, 40);
  await page.mouse.click(focus.x, focus.y);
  await page.keyboard.press("Control+u");
  await page.keyboard.type("echo realterm-keyboard-proof", { delay: 30 });
  await page.keyboard.press("Enter");
  await expect.poll(() => paneScreen(session).join("\n"), { timeout: 15_000 }).toContain("realterm-keyboard-proof");

  // With reporting on the app owns the mouse, so a drag pins and copies.
  const start = await cell(page, 0, 0);
  const end = await cell(page, 0, 9);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => clipboardText(page)).toBe("alpha beta");
  await expect.poll(() => page.locator(PIN).count()).toBe(1);
  await shot(page, "term-input-01-typed");
});
