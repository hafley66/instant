// Word, bracket, and line picks by click count on a real pane in the codex
// state, then the Ask flow through the real context menu and queue panel.
// Receipts: clipboard, overlay rects, the queue DOM, and capture-pane.
import { expect, test, type Page } from "@playwright/test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { boot, cell, clipboardText, closeTabs, killAllSessions, menuRow, MOUSE_PANE, openSilentPane, paneCommand, paneScreen, shot, sql } from "./0_real";

const LINE = "const shift = spans.map((s) => s.row);";
const PIN = ".term-pinned-selection";

async function openPane(page: Page): Promise<string> {
  return openSilentPane(page, `${MOUSE_PANE}\\033[2J\\033[H${LINE}\\nsecond line here`, LINE);
}

async function clickCell(page: Page, row: number, col: number, count: number) {
  const at = await cell(page, row, col);
  await page.mouse.click(at.x, at.y, { clickCount: count, delay: 80 });
}

async function askAboutRow(page: Page, row: number, col: number) {
  const at = await cell(page, row, col);
  await page.mouse.click(at.x, at.y, { button: "right" });
  await (await menuRow(page, "Ask about this")).click();
}

/// The panel's rows live in boop's sqlite and outlive the page, so the rows
/// this spec quotes are dropped before and after every case; a count of one is
/// then a count of what this test queued.
const forgetQueued = (): void => { sql(`delete from agent_turn_comment where quote='${LINE}'`); };

test.beforeEach(() => {
  forgetQueued();
});

test.afterEach(async ({ page }) => {
  await closeTabs(page);
  forgetQueued();
});

test.afterAll(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
});

test("double-click takes the word under the pointer on a pane the app owns", async ({ page }) => {
  await boot(page);
  await openPane(page);
  await clickCell(page, 0, 8, 2); // inside "shift"
  await expect.poll(() => clipboardText(page)).toBe("shift");
  await expect.poll(() => page.locator(PIN).count()).toBe(1);
  await shot(page, "term-word-select-01-word");
});

test("double-click stops at a bracket, matching xterm's own separators", async ({ page }) => {
  await boot(page);
  await openPane(page);
  await clickCell(page, 0, 16, 2); // inside "spans.map", bounded by " " and "("
  await expect.poll(() => clipboardText(page)).toBe("spans.map");
  await shot(page, "term-word-select-02-bracket");
});

test("triple-click takes the row without its trailing blanks", async ({ page }) => {
  await boot(page);
  await openPane(page);
  await clickCell(page, 0, 8, 3);
  await expect.poll(() => clipboardText(page)).toBe(LINE);
  await expect.poll(() => page.locator(PIN).count()).toBe(1);
  await shot(page, "term-word-select-03-line");
});

// Ask queues for the NEXT MESSAGE panel now; the panel's own button does the
// send. Nothing reaches the pane at queue time.
test("Ask about this queues the selection instead of writing to the pty", async ({ page }) => {
  await boot(page);
  const session = await openPane(page);
  await clickCell(page, 0, 8, 3); // whole line
  await expect.poll(() => clipboardText(page)).toBe(LINE);

  await askAboutRow(page, 0, 8);
  const queue = page.locator(".term-context-queue");
  await expect(queue).toBeVisible();
  await expect(queue.locator("header")).toContainText("NEXT MESSAGE · 1");
  await expect(queue.locator(".term-context-queue-quote")).toHaveText(LINE);
  await expect(queue.locator("textarea")).toHaveValue("");
  // The chip says which turn the slice came out of, or that it came off the terminal.
  await expect(queue.locator(".term-context-queue-turn")).toHaveCount(1);

  // The pane still holds the line exactly once: nothing was pasted at queue time.
  expect(paneScreen(session).filter((r) => r.includes(LINE))).toHaveLength(1);
  await shot(page, "term-word-select-04-queue");
});

// The queue's send must bracket its body or a multi-line paste would submit
// per line. The pane runs `cat > file`, so every byte the app writes to the pty
// lands on disk and the framing is readable there.
test("the queue's own button sends one bracketed-paste body", async ({ page }) => {
  const sink = path.join(mkdtempSync(path.join(tmpdir(), "term-word-select-")), "pty.bin");
  await boot(page);
  const session = await openPane(page);
  await clickCell(page, 0, 8, 3);
  await askAboutRow(page, 0, 8);
  const queue = page.locator(".term-context-queue");
  await expect(queue).toBeVisible();

  // DECSET 2004 is how a pane asks for paste brackets; tmux drops them for a
  // pane that never asked. Raw mode hands `cat` every byte as it arrives, so
  // the closing marker reaches the file without waiting for a newline.
  paneCommand(session, `printf '%b' '\\033[?2004h'; stty raw -echo; cat > ${sink}`);
  await page.waitForTimeout(500);
  await queue.locator("header button").click();
  await expect.poll(() => (existsSync(sink) ? readFileSync(sink, "utf8") : "")).toContain(LINE);
  await expect(queue).toBeHidden();

  const written = readFileSync(sink, "utf8");
  const start = written.indexOf("\u001b[200~");
  const end = written.indexOf("\u001b[201~");
  expect(start, `pty bytes never opened bracketed paste: ${JSON.stringify(written)}`).toBeGreaterThanOrEqual(0);
  expect(end, "pty bytes never closed bracketed paste").toBeGreaterThan(start);
  const body = written.slice(start + "\u001b[200~".length, end);
  expect(body).toContain(LINE);
  // A bare CR inside the body would submit the prompt line by line.
  expect(body.includes("\r"), "a bare CR would submit the prompt").toBe(false);
  await shot(page, "term-word-select-05-sent");
});
