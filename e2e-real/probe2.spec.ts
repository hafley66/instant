import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  boot, installClaudeSession, killAllSessions, openTab, paneScreen, recwd, runStubHarness, settleCwd, shot,
  tmux, turnDebugOn, typeLine, visibleTurnIds,
} from "./0_real";
import { realClaudeConversationReplay, renderConversationTurns } from "../scripts/3_claudeConversationReplay";

test.afterAll(() => {
  if (process.env.INSTANT_E2E_KEEP) return;
  killAllSessions();
});

test("probe stub harness attribution", async ({ page }) => {
  const replay = realClaudeConversationReplay();
  const workdir = mkdtempSync(path.join(tmpdir(), "instant-work-"));

  await boot(page);
  const session = await openTab(page);
  installClaudeSession(session, workdir, recwd(readFileSync(replay.source, "utf8"), workdir).trim().split("\n"));
  typeLine(session, `cd ${workdir}`);
  await page.waitForTimeout(800);
  await settleCwd(page, session, path.basename(workdir));

  const bytes = path.join(workdir, "screen.txt");
  writeFileSync(bytes, `╭─ Claude Code\r\n\r\n${renderConversationTurns(replay.gallery)}`);
  await runStubHarness(session, "claude", bytes);
  await page.waitForTimeout(1_500);
  await settleCwd(page, session, path.basename(workdir));
  await page.waitForTimeout(3_000);
  console.log("pane cmd:", tmux(["list-panes", "-a", "-F", "#{session_name} #{pane_current_command}"]));
  console.log("screen head:", JSON.stringify(paneScreen(session).slice(0, 4)));
  await turnDebugOn(page);
  await page.waitForTimeout(2_000);
  await shot(page, "probe2-01-rows");
  console.log("harness:", await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".term-host")].map((h) => `${h.dataset.harness}/${h.dataset.harnessConfidence} title=${h.title} rows=${h.querySelector(".xterm-rows")?.textContent?.slice(0, 60)}`)));
  console.log("turn ids:", JSON.stringify(await visibleTurnIds(page)));
  const rows = await page.evaluate(() => {
    const host = [...document.querySelectorAll<HTMLElement>(".term-host")].find((h) => h.getBoundingClientRect().width > 0);
    return [...(host?.querySelectorAll(".term-turn-debug-row") ?? [])].slice(0, 8).map((r) => r.textContent);
  });
  console.log("debug rows:", rows.length, JSON.stringify(rows));
  expect(await visibleTurnIds(page)).not.toEqual([]);
});
