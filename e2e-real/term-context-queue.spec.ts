// The terminal context queue against the real backend: a tmux pane painted
// with one assistant turn that boop's store also holds, so the app's own turn
// projection finds it and hangs a checkbox on every structured row. Receipts
// are the gutter the app paints, the queue panel, and the bytes the pty took.
import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderConversationTurns } from "../scripts/3_claudeConversationReplay";
import {
  bindPaneSession, boot, burnClaimedPaneIds, cell, closeTabs, dropPaneSessions, dropSeededTurns, dropTabComments,
  findRow, killAllSessions, openSessionTab, paneScreen, seedTurn, shot, silentSessionPane, typeLine,
} from "./0_real";

const TURN = 401;
const SAID = [
  "STRUCTURED TURN START",
  "| Item | Visibility |",
  "| --- | --- |",
  "| alpha | visible |",
  "| beta | hidden |",
  "- first visible item",
  "- second visible item",
  "STRUCTURED TURN END",
].join("\n");

// Filler above the fence keeps the opener off row 0: tmux paints its copy-mode
// position indicator there, and a fence opener sharing that row stops reading
// as one.
const MERMAID = [
  "top filler 1", "top filler 2", "top filler 3",
  "```mermaid", "flowchart LR", "PTY --> tmux", "tmux --> xterm", "```", "",
].join("\n");

const dirs: string[] = [];
const tabs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctx-queue-"));
  dirs.push(dir);
  return dir;
}

/// A pane holding one assistant turn, rendered the way a harness prints it,
/// with the same turn in boop's store under the pane's session name. The turn
/// is seeded before the pane paints it, so the first scan after the write
/// locates it.
async function openTurnPane(page: Page): Promise<{ dir: string; session: string }> {
  const dir = scratch();
  await boot(page);
  burnClaimedPaneIds();
  const session = await silentSessionPane(page, dir, "queue fixture ready\n", "queue fixture ready");
  tabs.push(session);
  dropTabComments(session);
  seedTurn(session, TURN, SAID);
  bindPaneSession(session);
  const body = join(dir, "turn.txt");
  writeFileSync(body, renderConversationTurns([{ role: "assistant", subtype: null, said: SAID }]).replace(/\r\n/g, "\n"));
  typeLine(session, `clear; cat ${body}`);
  await expect.poll(() => paneScreen(session).join("\n"), { timeout: 20_000 })
    .toContain("STRUCTURED TURN END");
  return { dir, session };
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

test("an empty terminal context queue has no visible shell", async ({ page }) => {
  const dir = scratch();
  await boot(page);
  const session = await openSessionTab(page, dir);
  tabs.push(session);

  // The queue mounts with every terminal; a pane nobody has queued anything
  // from shows the root and no panel.
  await expect(page.locator(".term-context-root")).toBeAttached();
  await expect(page.locator(".term-context-queue")).toBeHidden();
  await shot(page, "ctx-queue-01-empty");
});

test("queues individual Boop table rows and list items for the next prompt", async ({ page }) => {
  const { dir, session } = await openTurnPane(page);
  const check = page.locator(".term-context-structured-check:not([hidden])");
  await expect(check).toHaveCount(5, { timeout: 30_000 });

  // Output written under the rows repaints the gutter in place: the checkbox
  // nodes are moved, never torn down and rebuilt, and the gutter never blanks.
  const watch = page.evaluate(() => new Promise<{ children: number; blanked: boolean }>((resolve) => {
    const gutter = document.querySelector<HTMLElement>(".term-context-gutter")!;
    let children = 0;
    let blanked = false;
    const observer = new MutationObserver((records) => {
      children += records.filter((record) => record.type === "childList").length;
      blanked ||= gutter.hidden;
    });
    observer.observe(gutter, { childList: true, attributes: true, attributeFilter: ["hidden"] });
    const tick = setInterval(() => { blanked ||= gutter.hidden; }, 16);
    setTimeout(() => { observer.disconnect(); clearInterval(tick); resolve({ children, blanked }); }, 3_000);
  }));
  typeLine(session, "printf 'typing in the prompt'");
  await page.waitForTimeout(600);
  typeLine(session, "printf '\\nterminal output appended\\n'");
  expect(await watch).toEqual({ children: 0, blanked: false });

  await expect(page.locator(".term-context-gutter")).toBeVisible();
  await expect(check).toHaveCount(5);

  // Every box sits in the gutter, left of the first cell column.
  const wall = await cell(page, 0, 0);
  const box = await check.first().boundingBox();
  expect(box!.x).toBeLessThan(wall.x);

  await check.nth(1).check();
  await check.nth(3).check();
  // The slice is held as read in its own quote; the textarea beside it is the
  // note the reader annotates it with.
  const quote = page.locator(".term-context-queue-quote");
  await expect(quote).toHaveCount(2);
  await expect(quote.nth(0)).toHaveText("| alpha | visible |");
  await expect(quote.nth(1)).toHaveText("- first visible item");
  await expect(page.locator(".term-context-queue textarea")).toHaveCount(2);
  await expect(page.locator(".term-context-queue textarea").nth(0)).toHaveValue("");
  await shot(page, "ctx-queue-02-checked");

  // The pane runs with tty echo off, so the prompt body is read by a `cat`
  // that parks it in a file: the file is what the pty was handed.
  const sink = join(dir, "sent.txt");
  typeLine(session, `cat > ${sink}`);
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => {
    try { return readFileSync(sink, "utf8"); } catch { return ""; }
  }, { timeout: 20_000 }).toContain(`[turn ${session}:${TURN}]`);
  await expect(page.locator(".term-context-queue")).toBeHidden();
});

test("keeps the existing diagram mounted while scroll repaint is debounced", async ({ page }) => {
  const dir = scratch();
  await boot(page);
  const session = await silentSessionPane(page, dir, MERMAID, "flowchart LR");
  tabs.push(session);

  const diagram = page.locator(".term-diagram");
  await expect(diagram).toHaveCount(1, { timeout: 30_000 });

  // A wheel over the pane scrolls tmux by two lines and repaints the grid; the
  // diagram already mounted stays mounted through it.
  const at = await cell(page, findRow(session, "flowchart LR"), 4);
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(2_000);
  await expect(page.locator(".term-diagrams")).toBeVisible();
  await expect(diagram).toHaveCount(1);
  await shot(page, "ctx-queue-03-diagram");
});
