import { expect, test, type Page } from "@playwright/test";
import { boot, cell, closeTabs, killAllSessions, MOUSE_PANE, silentSessionPane, paneCommand, mkRepo, dropTabComments } from "./0_real";

import { rmSync } from "node:fs";
const dirs: string[] = [];
const ownedSessions: string[] = [];

async function select(page: Page) {
  await boot(page);
  await closeTabs(page);
  const dir = mkRepo({});
  dirs.push(dir);
  const session = await silentSessionPane(page, dir, "alpha beta gamma\nsecond line", "alpha beta gamma", MOUSE_PANE);
  ownedSessions.push(session);
  const start = await cell(page, 0, 0);
  const end = await cell(page, 0, 9);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".term-pinned-selection")).toHaveCount(1);
  return { session, point: end };
}

test.afterEach(async ({ page }) => {
  await closeTabs(page);
  for (const session of ownedSessions.splice(0)) dropTabComments(session);
});
test.afterAll(() => {
  killAllSessions();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("first Ask preserves the quote across a TUI repaint and accepts annotation immediately", async ({ page }) => {
  const { session, point } = await select(page);
  await page.mouse.click(point.x, point.y, { button: "right" });
  const ask = page.getByRole("menuitem", { name: "Ask about this", exact: true });
  await expect(ask).toBeVisible();
  paneCommand(session, "printf '%b' '\\033[1;1H\\033[Kreplacement output'");
  await expect(page.locator(".term-pinned-selection")).toHaveCount(0);
  await ask.click();
  await expect(page.locator(".term-context-queue-quote")).toHaveText("alpha beta");
  const note = page.locator(".term-context-queue-note");
  await expect(note).toBeFocused();
  await page.keyboard.type("explain this selection");
  await expect(note).toHaveValue("explain this selection");
  await expect(page.locator(".term-context-queue-item")).toHaveCount(1);
});

test("double right click queues once and focuses the annotation", async ({ page }) => {
  const { point } = await select(page);
  await page.mouse.click(point.x, point.y, { button: "right" });
  await page.mouse.click(point.x, point.y, { button: "right" });
  await expect(page.locator(".term-context-queue-quote")).toHaveText("alpha beta");
  await expect(page.locator(".term-context-queue-note")).toBeFocused();
  await page.keyboard.type("explain");
  await expect(page.locator(".term-context-queue-note")).toHaveValue("explain");
  await expect(page.locator(".ctx-menu")).toHaveCount(0);
  await expect(page.locator(".term-context-queue-item")).toHaveCount(1);
});
