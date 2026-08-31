import { unlinkSync } from "node:fs";
import { TuiTest } from "@microsoft/tui-test";
import { expect, test } from "@playwright/test";
import {
  asciinemaAvailability,
  parseTerminalCast,
  terminalCastReplay,
  terminalHarnesses,
  type TerminalCastEvent,
  type TerminalReplayTurn,
} from "../scripts/0_terminalCast";
import { clientCount, killSession, proofId, tmux, waitFor } from "./0_live";

declare global {
  interface Window {
    __instantE2eNativeResults?: Record<string, unknown>;
    __term?: {
      write: (data: string) => void;
      resize: (cols: number, rows: number) => void;
      point: (row: number, col: number) => { x: number; y: number } | null;
    };
    __visibleTurnEvents?: Array<{
      visible: Array<{ id: string; role: string }>;
    }>;
  }
}

const availability = asciinemaAvailability();
const processEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

async function writeCastEvents(events: readonly TerminalCastEvent[]) {
  for (const [, code, data] of events) {
    if (code === "o") window.__term!.write(data);
    if (code === "r") {
      const [cols, rows] = data.split("x").map(Number);
      window.__term!.resize(cols, rows);
    }
  }
}

for (const harness of terminalHarnesses) {
  test(`native-adjacent synchronized ${harness} cast and Boop turns reach Instant xterm`, async ({ page }) => {
    test.skip(!availability.available, availability.detail);

    const replay = terminalCastReplay(harness);
    const tmuxSession = proofId(`terminal-cast-${harness}`);
    const terminal = TuiTest.ephemeral(`instant-${harness}-`, {
      profile: { scrollback: 2_000 },
      timeouts: { text: 10_000, idle: 10_000, exit: 10_000 },
    });
    const capturedCast = `/private/tmp/${tmuxSession}.cast`;

    try {
      expect(tmux(["new-session", "-d", "-s", tmuxSession, "-x", "100", "-y", "30", "sleep", "300"]))
        .toMatchObject({ status: 0, stderr: "" });
      expect(tmux(["set-window-option", "-t", `${tmuxSession}:0`, "remain-on-exit", "on"]))
        .toMatchObject({ status: 0, stderr: "" });

      await terminal.run("tmux", ["attach-session", "-t", `=${tmuxSession}`], {
        cols: 100,
        rows: 30,
        cwd: process.cwd(),
        env: { ...processEnv, TERM: "xterm-256color" },
      });
      await waitFor(() => clientCount(tmuxSession) === 1, 5_000, "tui-test tmux client attachment");
      await terminal.startRecording(capturedCast);

      expect(tmux([
        "respawn-pane",
        "-k",
        "-t",
        `${tmuxSession}:0.0`,
        replay.executable,
        ...replay.args,
      ])).toMatchObject({ status: 0, stderr: "" });

      await terminal.waitText(replay.readiness, { timeout: 10_000 });
      await terminal.waitText("Markdown", { timeout: 10_000 });
      await terminal.waitIdle({ timeout: 10_000 });
      await terminal.stopRecording();
      const captured = parseTerminalCast(capturedCast);

      await page.goto(`/e2e-term.html?e2e=1&noSidebar=1&harness=${harness}`);
      await page.evaluate((turns: readonly TerminalReplayTurn[]) => {
        window.__instantE2eNativeResults!.boop_turns = turns;
      }, replay.turns);
      await page.getByTestId("open-term").click();
      await expect(page.locator(".term-host")).toBeVisible({ timeout: 10_000 });
      await page.waitForFunction(() => !!window.__term?.point(0, 0));
      await page.evaluate(writeCastEvents, captured.events);

      await expect.poll(() => page.evaluate(() =>
        window.__visibleTurnEvents?.at(-1)?.visible.map(({ id, role }) => ({ id, role })),
      )).toEqual([
        { id: `${replay.session}:1`, role: "user" },
        { id: `${replay.session}:2`, role: "assistant" },
      ]);

      if (harness === "claude") {
        const diagram = page.locator('.term-diagram[data-language="mermaid"]');
        await expect(diagram.locator("svg")).toBeVisible({ timeout: 10_000 });
        await expect(diagram).toContainText("PTY");
        await expect(diagram).toContainText("Markdown");
      }
      expect(parseTerminalCast(replay.artifact).inputEvents).toEqual([
        [0.1, "i", `${replay.input}\r`],
      ]);
    } finally {
      killSession(tmuxSession);
      await terminal.closeQuiet();
      try { unlinkSync(capturedCast); } catch {}
    }
  });
}
