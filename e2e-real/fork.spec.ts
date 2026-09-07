// The fork verb, end to end, in Chromium against instant-serve: a real tab on
// the app's own tmux socket, a word pinned by double-click, the right-click
// menu, Fork selection, a preset, the note prompt, Enter. Receipts come from
// outside the page: the comment row, the fork link row, the tmux session boop
// made, and a PNG at every step under artifacts/real/.
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { BOOP, boot, cell, killAllSessions, menuRow, openTab, root, settleCwd, shot, sql, tmuxHasDefault, toast, typeLine } from "./0_real";

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
  typeLine(session, `cd ${root}`);
  await page.waitForTimeout(800);
  await settleCwd(page, session, "condom");
  typeLine(session, `clear; echo ${word}`);
  await page.waitForTimeout(1_500);
  await shot(page, "fork-01-tab");

  await forkFlow(page, word, `proof note ${word}`, "fork");
  const text = await toast(page);
  await shot(page, "fork-05-toast");

  const commentId = sql(`select comment_id from agent_turn_comment where note='proof note ${word}' order by comment_id desc limit 1`);
  expect(commentId, `no comment row carried the note; toast: ${text}`).not.toBe("");
  const lane = sql(`select lane from agent_turn_comment_fork where comment_id=${commentId}`);
  const errorPanel = await page.evaluate(() => document.getElementById("boot-error")?.innerText ?? "");
  try {
    expect(lane, `no fork row; toast: ${text}; error panel: ${errorPanel}`).toBe(`fork-comment-${commentId}`);
    expect(text).toBe(`fork-comment-${commentId} spawned, flash4`);
    expect(tmuxHasDefault(`fork-comment-${commentId}`), "tmux session for the lane").toBe(true);
    expect(errorPanel).toBe("");
  } finally {
    spawnSync(BOOP, ["beep", "lane", "delete", `fork-comment-${commentId}`], { encoding: "utf8" });
  }
});

test("a word in a tab outside any repo fails in the open: toast and error panel carry boop's line", async ({ page }) => {
  const word = `forkfail${Date.now().toString(36)}`;
  await boot(page);
  const session = await openTab(page);
  typeLine(session, "cd /private/tmp");
  await page.waitForTimeout(800);
  await settleCwd(page, session, "/private/tmp");
  typeLine(session, `clear; echo ${word}`);
  await page.waitForTimeout(1_500);

  await forkFlow(page, word, `proof note ${word}`, "forkfail");
  const text = await toast(page);
  await page.waitForTimeout(200);
  await shot(page, "forkfail-06-failure");

  const commentId = sql(`select comment_id from agent_turn_comment where note='proof note ${word}' order by comment_id desc limit 1`);
  const lane = sql(`select lane from agent_turn_comment_fork where comment_id=${commentId || -1}`);
  const errorPanel = await page.evaluate(() => document.getElementById("boot-error")?.innerText ?? "");
  if (lane) spawnSync(BOOP, ["beep", "lane", "delete", lane], { encoding: "utf8" });
  expect(lane, `a fork spawned from a non-repo tab: ${lane}`).toBe("");
  expect(text).toMatch(/^fork failed: /);
  expect(errorPanel).toMatch(/no git repo at/);
});
