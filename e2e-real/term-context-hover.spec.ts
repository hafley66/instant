// Any line under the pointer gets a checkbox in the left gutter, structured or
// not; ticking it queues that line for the next prompt. The pane is a real tmux
// shell painted by one `cat`, and the receipts are the gutter checkbox the app
// paints and the queue panel it opens.
import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, cell, closeTabs, dropTabComments, findRow, killAllSessions, shot, silentSessionPane } from "./0_real";

const LINE = "const shift = spans.map((s) => s.row);";
const dirs: string[] = [];
const tabs: string[] = [];

async function openPane(page: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "ctx-hover-"));
  dirs.push(dir);
  await boot(page);
  const session = await silentSessionPane(page, dir, `${LINE}\nsecond line here\n`, LINE);
  tabs.push(session);
  dropTabComments(session);
  return session;
}

test.afterEach(async ({ page }) => {
  await closeTabs(page);
  for (const tab of tabs.splice(0)) dropTabComments(tab);
  killAllSessions();
});

test.afterAll(() => {
  killAllSessions();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("hovering a plain line offers a gutter checkbox that queues the line", async ({ page }) => {
  const session = await openPane(page);
  const row = findRow(session, LINE);
  expect(row).toBeGreaterThanOrEqual(0);
  const at = await cell(page, row, 8);

  await page.mouse.move(at.x, at.y);
  const check = page.locator(".term-context-hover-check");
  await expect(check).toBeVisible();
  await check.click();
  await expect(page.locator(".term-context-queue header")).toContainText("NEXT MESSAGE · 1");
  await expect(page.locator(".term-context-queue-quote")).toHaveText(LINE);
  await shot(page, "ctx-hover-01-queued");

  // The same line again: the box reads checked and unticking drops the row.
  await page.mouse.move(at.x + 30, at.y);
  await expect(check).toBeChecked();
  await check.click();
  await expect(page.locator(".term-context-queue")).toBeHidden();
});

test("a blank row offers no checkbox", async ({ page }) => {
  const session = await openPane(page);
  const row = findRow(session, LINE);
  expect(row).toBeGreaterThanOrEqual(0);

  // Three rows under the last painted line the pane is empty, and an empty
  // line queues nothing, so the gutter offers no box for it.
  const at = await cell(page, row + 3, 2);
  await page.mouse.move(at.x, at.y);
  await expect(page.locator(".term-context-hover-check")).toBeHidden();
  await shot(page, "ctx-hover-02-blank");
});
