import { describe, expect, it } from "vitest";
import { locateVisibleTurns, selectProjectionTurns, type BoopTurn } from "./0_terminalTurnVisibility";
import { projectionTurnSources } from "./0b_ompTurnBinding";

const turn = (
  session: string,
  turn: number,
  role: string,
  said: string,
): BoopTurn => ({ session, harness: "omp", turn, ts: turn, role, said });

describe("OMP coordinator turn binding", () => {
  it("keeps the registered session's multiline user and assistant turns ahead of repeated sibling prose", () => {
    const prompt = ["read the parse scan event list", "then publish the grapht demo"].join("\n");
    const reply = "the grapht demo is ready";
    const bound = [
      turn("omp-route", 310, "user", prompt),
      turn("omp-route", 311, "assistant", reply),
    ];
    const sibling = [turn("omp-sibling", 88, "user", `quoted context\n${prompt}`)];
    const sources = projectionTurnSources("omp", "omp-route", bound, sibling, sibling);
    const visible = locateVisibleTurns([
      { text: "› read the parse scan event list", start: 10, end: 10 },
      { text: "  then publish the grapht demo", start: 11, end: 11 },
      { text: "", start: 12, end: 12 },
      { text: "the grapht demo is ready", start: 13, end: 13 },
    ], selectProjectionTurns(sources.direct, sources.candidates));
    expect({
      sources,
      visible: visible.map(({ id, role, anchorStart, anchorEnd }) => ({ id, role, anchorStart, anchorEnd })),
    }).toMatchInlineSnapshot(`
      {
        "sources": {
          "candidates": [],
          "direct": [
            {
              "harness": "omp",
              "role": "user",
              "said": "read the parse scan event list
      then publish the grapht demo",
              "session": "omp-route",
              "ts": 310,
              "turn": 310,
            },
            {
              "harness": "omp",
              "role": "assistant",
              "said": "the grapht demo is ready",
              "session": "omp-route",
              "ts": 311,
              "turn": 311,
            },
          ],
        },
        "visible": [
          {
            "anchorEnd": 11,
            "anchorStart": 10,
            "id": "omp-route:310",
            "role": "user",
          },
          {
            "anchorEnd": 13,
            "anchorStart": 13,
            "id": "omp-route:311",
            "role": "assistant",
          },
        ],
      }
    `);
  });

  it("does not borrow a same-cwd session when the coordinator route has no exact session", () => {
    const sibling = [turn("omp-sibling", 88, "user", "repeat this common request")];
    expect(projectionTurnSources("omp", null, [], sibling, sibling)).toMatchInlineSnapshot(`
      {
        "candidates": [],
        "direct": [],
      }
    `);
  });

  it("does not fall back to repeated sibling prose when a stale route session has no turns", () => {
    const sibling = [turn("omp-sibling", 88, "user", "repeat this common request")];
    expect(projectionTurnSources("omp", "stale-route-session", [], sibling, sibling)).toMatchInlineSnapshot(`
      {
        "candidates": [],
        "direct": [],
      }
    `);
  });

  it("preserves the existing fallback sources for other harnesses", () => {
    const tab = [turn("codex-cwd", 9, "user", "same cwd fallback")];
    const candidates = [turn("codex-recent", 10, "assistant", "recent fallback")];
    expect(projectionTurnSources("codex", null, [], tab, candidates)).toMatchInlineSnapshot(`
      {
        "candidates": [
          {
            "harness": "omp",
            "role": "assistant",
            "said": "recent fallback",
            "session": "codex-recent",
            "ts": 10,
            "turn": 10,
          },
        ],
        "direct": [
          {
            "harness": "omp",
            "role": "user",
            "said": "same cwd fallback",
            "session": "codex-cwd",
            "ts": 9,
            "turn": 9,
          },
        ],
      }
    `);
  });
});
