// The fork verb, end to end, in Chromium against instant-serve: a real tab on
// the app's own tmux socket, a word pinned by double-click, the right-click
// menu, Fork selection, a preset, the note prompt, Enter. Receipts come from
// outside the page: the comment row in boop's store, the call boop received
// (the stub in e2e-real/stub-bin logs it; no lane, no worktree, no model
// process is ever started), and a PNG at every step under artifacts/real/.
import { expect, test, type Page } from "@playwright/test";
import { realpathSync } from "node:fs";
import { boot, cell, forkCalls, killAllSessions, menuRow, openTab, root, shot, sql, toast, typeLine } from "./0_real";

async function forkFlow(page: Page, word: string, note: string, tag: string): Promise<void> {
  const at = await cell(page, 0, 3);
  await page.mouse.dblclick(at.x, at.y);
  await page.waitForTimeout(300);
  await page.mouse.click(at.x, at.y, { button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await shot(page, `${tag}-02-menu`);
  // The Fork row runs its main preset on click; the preset submenu opens on hover.
  await (await menuRow(page, "Fork selection")).hover();
  const preset = await menuRow(page, "flash4");
  await shot(page, `${tag}-03-presets`);
  await preset.click();
  const input = page.locator(".cmdp-input");
  await expect(input).toBeVisible();
  await shot(page, `${tag}-04-prompt-empty`);
  await input.fill(note);
  await shot(page, `${tag}-04-prompt`);
  await input.press("Enter");
}

test.afterAll(() => {
  if (process.env.INSTANT_E2E_KEEP) return;
  killAllSessions();
});

test("a word in a repo tab forks on flash4 with a note, and the app names the lane boop made", async ({ page }) => {
  const word = `forkproof${Date.now().toString(36)}`;
  await boot(page);
  const session = await openTab(page);
  // No panel refresh between the cd and the fork: the fork reads the live pane cwd.
  typeLine(session, `cd ${root}`);
  await page.waitForTimeout(800);
  typeLine(session, `clear; echo ${word}`);
  await page.waitForTimeout(1_500);
  await shot(page, "fork-01-tab");

  await forkFlow(page, word, `proof note ${word}`, "fork");
  const text = await toast(page);
  await shot(page, "fork-05-toast");

  const commentId = sql(`select comment_id from agent_turn_comment where note='proof note ${word}' order by comment_id desc limit 1`);
  expect(commentId, `no comment row carried the note; toast: ${text}`).not.toBe("");
  const errorPanel = await page.evaluate(() => document.getElementById("boot-error")?.innerText ?? "");
  const calls = forkCalls();
  const call = calls.find((c) => c.args === `beep fork ${commentId} --preset flash4`);
  expect(call, `boop never got the fork; calls: ${JSON.stringify(calls)}; toast: ${text}; error panel: ${errorPanel}`).toBeDefined();
  // The cwd boop ran in is the pane's live cwd after the cd, read from tmux at
  // spawn time, so a tab that changed directory forks where it stands.
  expect(realpathSync(call!.cwd)).toBe(realpathSync(root));
  expect(text).toBe(`fork-comment-${commentId} spawned, flash4`);
  expect(errorPanel).toBe("");
});

test("a word in a tab outside any repo fails in the open: toast and error panel carry boop's line", async ({ page }) => {
  const word = `forkfail${Date.now().toString(36)}`;
  await boot(page);
  const session = await openTab(page);
  typeLine(session, "cd /private/tmp");
  await page.waitForTimeout(800);
  typeLine(session, `clear; echo ${word}`);
  await page.waitForTimeout(1_500);

  await forkFlow(page, word, `proof note ${word}`, "forkfail");
  const text = await toast(page);
  await page.waitForTimeout(200);
  await shot(page, "forkfail-06-failure");

  const commentId = sql(`select comment_id from agent_turn_comment where note='proof note ${word}' order by comment_id desc limit 1`);
  const errorPanel = await page.evaluate(() => document.getElementById("boot-error")?.innerText ?? "");
  const calls = forkCalls().filter((c) => c.args === `beep fork ${commentId || -1} --preset flash4`);
  expect(calls.length, `boop saw the fork call from a non-repo tab: ${JSON.stringify(calls)}`).toBe(1);
  expect(realpathSync(calls[0].cwd)).toBe("/private/tmp");
  expect(text).toMatch(/^fork failed: /);
  expect(errorPanel).toMatch(/no git repo at/);
});
