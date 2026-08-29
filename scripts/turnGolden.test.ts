import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { locateVisibleTurns, normalizeTurnLine, type BoopTurn } from "../src/0_terminalTurnVisibility";
import type { LogicalLine } from "../src/00a_terminalIntersection";

// The one artifact the TypeScript matcher and the Rust port both assert
// against. `EMIT_GOLDEN=1 npx vitest run scripts/turnGolden.test.ts` rewrites
// it; a plain run compares and fails on any drift.
const dir = fileURLToPath(new URL("../labs/turn-identity/fixtures/", import.meta.url));
const NAMES = ["claude", "claude-wide", "claude-narrow", "codex", "ccz", "opencode", "kimi"];
const TURNS: Record<string, string> = {
  "claude": "claude",
  "claude-wide": "claude",
  "claude-narrow": "claude",
  "codex": "codex",
  "ccz": "ccz",
  "opencode": "opencode",
  "kimi": "kimi",
};

type Capture = { session: string; cols: number; rows: number; lines: LogicalLine[] };

function assignments(name: string) {
  const capture = JSON.parse(readFileSync(`${dir}${name}.json`, "utf8")) as Capture;
  const turns = JSON.parse(readFileSync(`${dir}${TURNS[name]}.turns.json`, "utf8")) as BoopTurn[];
  const located = locateVisibleTurns(capture.lines, turns);
  // Per-turn spans alone let a normalization change pass unseen: a turn keeps
  // its outer anchor when an interior row stops matching. Rows pin every row.
  const identity = (row: number) =>
    located.find((turn) => turn.anchorStart <= row && row <= turn.anchorEnd)?.id ?? null;
  return {
    fixture: name,
    cols: capture.cols,
    rows: capture.rows,
    lines: capture.lines.map((line) => ({
      start: line.start,
      end: line.end,
      normalized: normalizeTurnLine(line.text),
      id: identity(line.start),
    })),
    turns: located.map((turn) => ({
      id: turn.id,
      turn: turn.turn,
      role: turn.role,
      confidence: turn.confidence,
      anchorStart: turn.anchorStart,
      anchorEnd: turn.anchorEnd,
      bufferStart: turn.bufferStart,
      bufferEnd: turn.bufferEnd,
    })),
  };
}

describe("turn assignment golden", () => {
  for (const name of NAMES) {
    it(`matches the checked-in golden for ${name}`, () => {
      const actual = assignments(name);
      const path = `${dir}${name}.golden.json`;
      if (process.env.EMIT_GOLDEN) writeFileSync(path, `${JSON.stringify(actual, null, 1)}\n`);
      expect(actual).toEqual(JSON.parse(readFileSync(path, "utf8")));
    });
  }
});
