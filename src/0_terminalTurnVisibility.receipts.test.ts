import { describe, expect, it } from "vitest";
import { locateVisibleTurns, normalizeTurnLine, type BoopTurn } from "./0_terminalTurnVisibility";
import type { LogicalLine } from "./00a_terminalIntersection";
import claudeCapture from "../labs/turn-identity/fixtures/claude.json";
import claudeWideCapture from "../labs/turn-identity/fixtures/claude-wide.json";
import claudeNarrowCapture from "../labs/turn-identity/fixtures/claude-narrow.json";
import claudeTurns from "../labs/turn-identity/fixtures/claude.turns.json";
import codexCapture from "../labs/turn-identity/fixtures/codex.json";
import codexTurns from "../labs/turn-identity/fixtures/codex.turns.json";
import cczCapture from "../labs/turn-identity/fixtures/ccz.json";
import cczTurns from "../labs/turn-identity/fixtures/ccz.turns.json";
import opencodeCapture from "../labs/turn-identity/fixtures/opencode.json";
import opencodeTurns from "../labs/turn-identity/fixtures/opencode.turns.json";
import kimiCapture from "../labs/turn-identity/fixtures/kimi.json";
import kimiTurns from "../labs/turn-identity/fixtures/kimi.turns.json";

type Capture = { session: string; cols: number; rows: number; bytes: number; lines: LogicalLine[] };
type Verdict = "correct" | "wrong" | "missing" | "phantom";

// A row's ground truth is the turn whose transcript contains it under the
// matcher's own rule; rows several turns claim are ambiguous and score nothing.
function scoreCapture(capture: Capture, turns: BoopTurn[]) {
  const visible = locateVisibleTurns(capture.lines, turns);
  // One structural rule, no thresholds to tune: a turn owns a row when the row
  // is a substring of that turn's whole text with its own line breaks removed,
  // which is what any app-side wrap, table cell, or reflow produces.
  const sources = turns.map((turn) => ({
    id: `${turn.session}:${turn.turn}`,
    said: turn.said.split("\n").map(normalizeTurnLine).filter(Boolean).join(" "),
  }));
  const owns = (source: { said: string }, screen: string) => source.said.includes(screen);
  const reportedAt = (row: number) =>
    visible.find((turn) => turn.anchorStart <= row && row <= turn.anchorEnd)?.id ?? null;

  const tally: Record<Verdict, number> = { correct: 0, wrong: 0, missing: 0, phantom: 0 };
  const failures: Array<{ row: number; text: string; truth: string | null; reported: string | null }> = [];
  let ambiguous = 0;
  let skipped = 0;
  for (const line of capture.lines) {
    const text = normalizeTurnLine(line.text);
    if (text.length < 12) {
      skipped += 1;
      continue;
    }
    const owners = sources.filter((source) => owns(source, text));
    if (owners.length > 1) {
      ambiguous += 1;
      continue;
    }
    const truth = owners[0]?.id ?? null;
    const reported = reportedAt(line.start);
    const verdict: Verdict = truth === reported
      ? "correct"
      : truth === null
        ? "phantom"
        : reported === null
          ? "missing"
          : "wrong";
    tally[verdict] += 1;
    if (verdict !== "correct") failures.push({ row: line.start, text: text.slice(0, 72), truth, reported });
  }
  return {
    visible,
    tally,
    failures,
    ambiguous,
    skipped,
    scored: Object.values(tally).reduce((total, count) => total + count, 0),
  };
}

const fixtures = [
  { name: "claude", capture: claudeCapture as Capture, turns: claudeTurns as BoopTurn[] },
  { name: "claude-wide-tables", capture: claudeWideCapture as Capture, turns: claudeTurns as BoopTurn[] },
  { name: "claude-narrow-tables", capture: claudeNarrowCapture as Capture, turns: claudeTurns as BoopTurn[] },
  { name: "codex", capture: codexCapture as Capture, turns: codexTurns as BoopTurn[] },
  { name: "ccz", capture: cczCapture as Capture, turns: cczTurns as BoopTurn[] },
  { name: "opencode", capture: opencodeCapture as Capture, turns: opencodeTurns as BoopTurn[] },
  { name: "kimi", capture: kimiCapture as Capture, turns: kimiTurns as BoopTurn[] },
];

describe("turn identity against real resumed harness panes", () => {
  for (const { name, capture, turns } of fixtures) {
    it(`names no turn for a row no turn wrote, in the ${name} pane`, () => {
      const result = scoreCapture(capture, turns);
      console.log([
        `\n== ${name} == ${capture.session} ${capture.cols}x${capture.rows}`,
        `${capture.bytes} pty bytes, ${capture.lines.length} logical lines, ${turns.length} boop turns in window`,
        ...result.visible.map((turn) =>
          `  turn ${turn.turn} ${turn.role} ${turn.confidence}`
          + ` anchor ${turn.anchorStart}..${turn.anchorEnd} span ${turn.bufferStart}..${turn.bufferEnd}`),
        `scored ${result.scored} rows (skipped short ${result.skipped}, ambiguous ${result.ambiguous})`,
        `correct ${result.tally.correct} wrong ${result.tally.wrong}`
        + ` missing ${result.tally.missing} phantom ${result.tally.phantom}`,
        ...result.failures.slice(0, 12).map((failure) =>
          `  row ${String(failure.row).padStart(3)}`
          + ` truth=${failure.truth ?? "none"} reported=${failure.reported ?? "none"} :: ${failure.text}`),
      ].join("\n"));
      expect(result.scored).toBeGreaterThan(0);
      expect(result.tally.phantom).toBe(0);
      expect(result.tally.wrong).toBe(0);
    });
  }
});
