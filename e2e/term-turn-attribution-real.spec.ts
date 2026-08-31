import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  realClaudeConversationReplay,
  renderConversationTurns,
  renderConversationWindow,
  type ConversationReplayTurn,
} from "../scripts/3_claudeConversationReplay";
import {
  realCodexConversationReplay,
  type CodexConversationReplayTurn,
} from "../scripts/4_codexConversationReplay";

declare global {
  interface Window {
    __instantE2eNativeResults?: Record<string, unknown>;
    __instantE2eNativeCalls?: string[];
    __term?: {
      write: (data: string) => void;
      resize: (cols: number, rows: number) => void;
      point: (row: number, col: number) => { x: number; y: number } | null;
      scroll: (lines: number) => void;
      position: () => { viewportY: number; baseY: number; length: number; rows: number } | null;
      screen: () => string[];
      mouseMode: () => string;
    };
  }
}

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const receipts = join(repo, "artifacts", "morning-report");
const replay = realClaudeConversationReplay();
const codexReplay = realCodexConversationReplay();
type ReplayTurn = ConversationReplayTurn | CodexConversationReplayTurn;

async function openConversation(
  page: Page,
  turns: readonly ReplayTurn[],
  cols: number,
  rows: number,
  output = renderConversationTurns(turns),
) {
  const harness = turns[0]?.harness ?? "codex";
  await page.goto(`/e2e-term.html?e2e=1&noSidebar=1&harness=${harness}`);
  await page.evaluate((value) => {
    window.__instantE2eNativeResults!.boop_turns = value;
  }, turns);
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible();
  await page.waitForFunction(() => !!window.__term?.point(0, 0));
  await page.evaluate(({ output, cols: width, rows: height }) => {
    window.__term!.resize(width, height);
    window.__term!.write(output);
  }, { output, cols, rows });
  await page.locator("#turn-debug-toggle").click();
  await expect(page.locator("#turn-debug-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.locator('[data-testid="visible-turn-readout"], [data-testid="cmd-click-event-readout"]')
    .evaluateAll((elements) => elements.forEach((element) => element.remove()));
  await expect.poll(() => page.locator('.term-turn-debug-row[data-turn-id]:not([data-turn-id=""])').count())
    .toBeGreaterThan(0);
}

async function saveReceipt(page: Page, name: string) {
  await expect(page).toHaveScreenshot(`${name}.png`, { animations: "disabled" });
  const path = join(receipts, `${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  return path;
}

async function visibleTurnIds(page: Page) {
  return page.locator('.term-turn-debug-row[data-turn-id]:not([data-turn-id=""])')
    .evaluateAll((rows) => [...new Set(rows.map((row) => (row as HTMLElement).dataset.turnId!))].sort());
}

test.beforeAll(() => mkdirSync(receipts, { recursive: true }));

test("a sanitized real conversation shows every ledger message role and content type", async ({ page }, testInfo) => {
  await openConversation(page, replay.gallery, 120, 35);

  for (const role of ["assistant", "meta", "tool", "user"]) {
    await expect.poll(() => page.locator(`.term-turn-debug-row[data-role="${role}"]`).count())
      .toBeGreaterThan(0);
  }
  for (const text of [
    "Caveat: The messages below were generated",
    "20260724.0.v6-sprefa-extract-ts-parity-gold-const-port.md",
    "LATEST.md points to",
    "LATEST points to the TS-parity-const session",
    "TaskUpdate",
    "Request interrupted by user",
  ]) {
    await expect(page.locator(".xterm-rows")).toContainText(text);
  }

  const path = await saveReceipt(page, "real-claude-all-message-types");
  await testInfo.attach("real-claude-all-message-types", { path, contentType: "image/png" });
});

test("a real message taller than the viewport retains attribution at its start and middle", async ({ page }, testInfo) => {
  const sourceLines = replay.longTurn.said.split("\n");
  expect(sourceLines.length).toBeGreaterThan(8);
  await openConversation(page, [replay.longTurn], 120, 8, renderConversationWindow(replay.longTurn, 0, 5));
  const position = await page.evaluate(() => window.__term!.position());
  expect(position).toMatchObject({ rows: 8, baseY: 0, viewportY: 0 });
  const startRows = page.locator('.term-turn-debug-row[data-turn="16"][data-role="assistant"]');
  await expect(startRows.first()).toContainText("┌ t16 assistant A");
  await expect(startRows.last()).toContainText("↓ t16 assistant A");
  const startPath = await saveReceipt(page, "real-claude-long-turn-start");
  await testInfo.attach("real-claude-long-turn-start", { path: startPath, contentType: "image/png" });

  const middleOutput = renderConversationWindow(replay.longTurn, 3, 10);
  await page.evaluate((output) => window.__term!.write(`\u001b[2J\u001b[H${output}`), middleOutput);
  await expect(page.locator(".xterm-rows")).toContainText("chat_log/20260723.0.v6-sprefa-extract-golden-plan-1.md");
  const screen = await page.evaluate(() => window.__term!.screen());
  const occupied = screen.flatMap((line, index) => line.trim() ? [index] : []);
  expect(occupied.length).toBeGreaterThan(1);
  const rows = page.locator(".term-turn-debug-row");
  await expect(rows.nth(occupied[0])).toHaveAttribute("data-role", "assistant");
  await expect(rows.nth(occupied.at(-1)!)).toHaveAttribute("data-role", "assistant");
  await expect(rows.nth(occupied[0])).toHaveAttribute("data-turn", "16");
  await expect(rows.nth(occupied.at(-1)!)).toHaveAttribute("data-turn", "16");
  await expect(rows.nth(occupied[0])).toContainText("↑ t16 assistant A");
  await expect(rows.nth(occupied.at(-1)!)).toContainText("↓ t16 assistant A");
  const middlePath = await saveReceipt(page, "real-claude-long-turn-middle");
  await testInfo.attach("real-claude-long-turn-middle", { path: middlePath, contentType: "image/png" });
});

test("a real Codex turn rescans on wheel activity and repaints after the TUI redraw settles", async ({ page }, testInfo) => {
  const beforeTurns = codexReplay.turns.filter((turn) => [4, 8, 9].includes(turn.sourceLine));
  const afterTurns = codexReplay.turns.filter((turn) => [14, 15, 16].includes(turn.sourceLine));
  expect(beforeTurns.map((turn) => [turn.turn, turn.role, turn.subtype])).toEqual([
    [4, "user", null],
    [8, "assistant", null],
    [9, "assistant", "exec"],
  ]);
  expect(afterTurns.map((turn) => [turn.turn, turn.role, turn.subtype])).toEqual([
    [14, "assistant", null],
    [15, "assistant", "exec"],
    [16, "assistant", "exec result"],
  ]);
  const beforeOutput = `\u001b[?1003h\u001b[?1006h${renderConversationTurns(beforeTurns)}`;
  await openConversation(page, codexReplay.turns, 120, 18, beforeOutput);
  await expect.poll(() => page.evaluate(() => window.__term!.mouseMode())).toBe("any");

  await expect.poll(() => visibleTurnIds(page)).toEqual([
    "codex-real-session:4",
    "codex-real-session:8",
    "codex-real-session:9",
  ]);
  await expect(page.locator('.term-turn-debug-row[data-turn="4"]').first()).toContainText("t4 user A");
  await expect(page.locator('.term-turn-debug-row[data-turn="8"]').first()).toContainText("t8 assistant A");
  await expect(page.locator('.term-turn-debug-row[data-turn="9"]').first()).toContainText("t9 assistant A");
  const beforePath = await saveReceipt(page, "real-codex-scroll-before");
  await testInfo.attach("real-codex-scroll-before", { path: beforePath, contentType: "image/png" });

  const afterOutput = renderConversationTurns(afterTurns);
  await page.evaluate((output) => {
    window.__instantE2eNativeCalls = [];
    window.__instantE2eNativeResults!.write_pty = () => {
      window.setTimeout(() => window.__term!.write(`\u001b[2J\u001b[H${output}`), 250);
    };
  }, afterOutput);
  const screen = page.locator(".xterm-screen");
  const box = await screen.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 120);

  const locateCalls = () => page.evaluate(() =>
    window.__instantE2eNativeCalls?.filter((command) => command === "boop_locate_turns").length ?? 0);
  await expect.poll(locateCalls, { timeout: 200, intervals: [20] }).toBeGreaterThan(0);
  await expect(page.locator(".xterm-rows")).toContainText("The plan requires one commit per implementation step");
  await expect.poll(locateCalls).toBeGreaterThanOrEqual(2);

  await expect.poll(() => visibleTurnIds(page)).toEqual([
    "codex-real-session:14",
    "codex-real-session:15",
    "codex-real-session:16",
  ]);
  await expect(page.locator('.term-turn-debug-row[data-turn="14"]').first()).toContainText("t14 assistant A");
  await expect(page.locator('.term-turn-debug-row[data-turn="15"]').first()).toContainText("t15 assistant A");
  await expect(page.locator('.term-turn-debug-row[data-turn="16"]').first()).toContainText("t16 assistant A");
  const afterPath = await saveReceipt(page, "real-codex-scroll-after");
  await testInfo.attach("real-codex-scroll-after", { path: afterPath, contentType: "image/png" });
});
