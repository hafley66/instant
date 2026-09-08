// Turn attribution against the real backend. The corpora are the same
// sanitized Claude and Codex transcripts the fixture replayed, but the turns
// live in boop's own store and the pane is a real tmux session bound to that
// session, so the app's projection is the one under test. Receipts are the
// turn-debug rows the overlay paints over the terminal.
import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  realClaudeConversationReplay,
  renderConversationTurns,
  renderConversationWindow,
} from "../scripts/3_claudeConversationReplay";
import { realCodexConversationReplay } from "../scripts/4_codexConversationReplay";
import {
  appendTurnRow, bindPaneSession, boot, burnClaimedPaneIds, closeTabs, dropPaneSessions,
  dropSeededTurns, killAllSessions, paneScreen, screenRows, seedTurnRows, shot, silentSessionPane,
  turnDebugOn, typeLine, visibleTurnIds,
} from "./0_real";

const replay = realClaudeConversationReplay();
const codexReplay = realCodexConversationReplay();
const dirs: string[] = [];

// boop's ledger names its roles user, assistant, tool, system and developer.
// The fixture's own reader calls the caveat message "meta"; the store's name
// for that same record is "system".
const ledgerRole = (role: string) => role === "meta" ? "system" : role;

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "turn-attr-"));
  dirs.push(dir);
  return dir;
}

/// A pane bound to a boop session holding `turns`, painted with `body`. The
/// turns are seeded before the pane paints them, so the first scan after the
/// write locates them.
async function turnPane(
  page: Page,
  turns: readonly { turn: number; role: string; said: string }[],
  body: string,
  marker: string,
  harness = "claude",
): Promise<{ dir: string; session: string }> {
  const dir = scratch();
  await boot(page);
  burnClaimedPaneIds();
  const session = await silentSessionPane(page, dir, "attribution fixture ready\n", "attribution fixture ready");
  seedTurnRows(session, turns.map((turn) => ({ ...turn, role: ledgerRole(turn.role) })), harness);
  bindPaneSession(session, harness);
  await paint(page, dir, session, body, marker);
  return { dir, session };
}

/// Repaint the pane from a file, the way a harness redraws its screen.
async function paint(page: Page, dir: string, session: string, body: string, marker: string): Promise<void> {
  const file = join(dir, `screen-${Math.random().toString(36).slice(2, 8)}.txt`);
  writeFileSync(file, `${body.replace(/\r\n/g, "\n")}\n`);
  typeLine(session, `clear; cat ${file}`);
  await expect.poll(() => paneScreen(session).join("\n"), { timeout: 20_000, message: `pane never showed ${marker}` })
    .toContain(marker);
  await page.waitForTimeout(800);
}

/// One debug row per attributed screen row, so the ids are read as a set.
const uniqueTurnIds = async (page: Page) => [...new Set(await visibleTurnIds(page))];

test.afterEach(async ({ page }) => {
  await closeTabs(page);
  dropSeededTurns();
  dropPaneSessions();
  killAllSessions();
});

test.afterAll(() => {
  killAllSessions();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("a sanitized real conversation shows every ledger message role and content type", async ({ page }) => {
  const turns = replay.gallery.map((turn) => ({ turn: turn.turn, role: turn.role, said: turn.said }));
  await turnPane(page, turns, renderConversationTurns(replay.gallery), "Request interrupted by user");
  await turnDebugOn(page);

  for (const role of ["assistant", "system", "tool", "user"]) {
    await expect.poll(() => page.locator(`.term-turn-debug-row[data-role="${role}"]`).count(), { timeout: 30_000 })
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
  await shot(page, "turn-attr-01-message-types");
});

test("a real message taller than the viewport retains attribution at its start and middle", async ({ page }) => {
  const long = replay.longTurn;
  const sourceLines = long.said.split("\n");
  expect(sourceLines.length).toBeGreaterThan(8);

  // The pane shows the first five lines of an eleven-line message: the message
  // starts on screen and runs past what the pane has printed.
  const { dir, session } = await turnPane(
    page,
    [{ turn: long.turn, role: long.role, said: long.said }],
    renderConversationWindow(long, 0, 5),
    "chat_log/20260723.0.v6-sprefa-extract-golden-plan-1.md",
  );
  await turnDebugOn(page);
  const startRows = page.locator(`.term-turn-debug-row[data-turn="${long.turn}"][data-role="assistant"]`);
  await expect(startRows.first()).toContainText(`┌ t${long.turn} assistant A`, { timeout: 30_000 });
  await expect(startRows.last()).toContainText(`↓ t${long.turn} assistant A`);
  await shot(page, "turn-attr-02-long-turn-start");

  // A window out of the middle of the same message: neither end is on screen,
  // and every printed row still carries the turn.
  await paint(page, dir, session, renderConversationWindow(long, 3, 10), "Let me check if there");
  await expect(page.locator(".xterm-rows"))
    .toContainText("chat_log/20260723.0.v6-sprefa-extract-golden-plan-1.md");
  // tmux paints its status line into the last xterm row; the pane owns the rest.
  const rows = (await screenRows(page)).slice(0, -1);
  const occupied = rows.flatMap((line, index) => line.trim() ? [index] : []);
  expect(occupied.length).toBeGreaterThan(1);
  const debugRows = page.locator(".term-turn-debug-row");
  const first = debugRows.nth(occupied[0]);
  const last = debugRows.nth(occupied.at(-1)!);
  await expect(first).toHaveAttribute("data-turn", String(long.turn), { timeout: 30_000 });
  await expect(last).toHaveAttribute("data-turn", String(long.turn));
  await expect(first).toHaveAttribute("data-role", "assistant");
  await expect(last).toHaveAttribute("data-role", "assistant");
  await expect(first).toContainText(`↑ t${long.turn} assistant A`);
  await expect(last).toContainText(`↓ t${long.turn} assistant A`);
  await shot(page, "turn-attr-03-long-turn-middle");
});

test("a Codex redraw clears stale attribution until the parent transcript projection advances", async ({ page }) => {
  const before = codexReplay.turns.filter((turn) => [4, 8, 9].includes(turn.sourceLine));
  const after = codexReplay.turns.filter((turn) => [14, 15, 16].includes(turn.sourceLine));
  expect(before.map((turn) => [turn.turn, turn.role, turn.subtype])).toEqual([
    [4, "user", null],
    [8, "assistant", null],
    [9, "assistant", "exec"],
  ]);
  expect(after.map((turn) => [turn.turn, turn.role, turn.subtype])).toEqual([
    [14, "assistant", null],
    [15, "assistant", "exec"],
    [16, "assistant", "exec result"],
  ]);

  const { dir, session } = await turnPane(
    page,
    before.map((turn) => ({ turn: turn.turn, role: turn.role, said: turn.said })),
    renderConversationTurns(before),
    "Reading the continuation plan first",
    "codex",
  );
  await turnDebugOn(page);
  await expect.poll(() => uniqueTurnIds(page), { timeout: 30_000 })
    .toEqual([`${session}:4`, `${session}:8`, `${session}:9`]);
  for (const turn of before) {
    await expect(page.locator(`.term-turn-debug-row[data-turn="${turn.turn}"]`).first())
      .toContainText(`t${turn.turn} ${turn.role} A`);
  }
  await shot(page, "turn-attr-04-before-projector");

  // The pane redraws with three turns boop has not ingested yet. Nothing on
  // screen belongs to the turns the store holds, so every label clears.
  await paint(page, dir, session, renderConversationTurns(after),
    "The plan requires one commit per implementation step");
  await expect.poll(() => uniqueTurnIds(page), { timeout: 8_000 }).toEqual([]);
  await shot(page, "turn-attr-05-stale-cleared");

  // The transcript reader catches up and the store gains the three turns. The
  // labels come back with no wheel, key or write from the user.
  for (const turn of after) appendTurnRow(session, turn.turn, turn.role, turn.said);
  await expect.poll(() => uniqueTurnIds(page), { timeout: 30_000 })
    .toEqual([`${session}:14`, `${session}:15`, `${session}:16`]);
  for (const turn of after) {
    await expect(page.locator(`.term-turn-debug-row[data-turn="${turn.turn}"]`).first())
      .toContainText(`t${turn.turn} ${turn.role} A`);
  }
  await shot(page, "turn-attr-06-after-projector");
});
