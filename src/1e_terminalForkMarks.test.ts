import { describe, expect, it } from "vitest";
import type { VisibleTerminalLine } from "./00b_terminalLineAnchors";
import type { VisibleTurn } from "./0_terminalTurnVisibility";
import type { BoopTurnComment, BoopTurnCommentFork } from "./1b_terminalContextSync";
import { placeAnnotations, type PlacedAnnotation } from "./1d_terminalTurnMarks";
import { forkBlock, placeForks, wrapText } from "./1e_terminalForkMarks";

const line = (id: string, row: number, text: string): VisibleTerminalLine =>
  ({ id, bufferStart: row, bufferEnd: row, viewportStart: row, viewportEnd: row, text });

const turn = (id: string, start: number, end: number): VisibleTurn => ({
  id, bufferStart: start, bufferEnd: end, anchorStart: start, anchorEnd: end,
  regions: [], confidence: "anchored", source: "xterm+boop",
} as unknown as VisibleTurn);

const comment = (over: Partial<BoopTurnComment> = {}): BoopTurnComment => ({
  commentId: 26,
  clientId: "selection:26:0",
  kind: "selection",
  quote: "DBSP.State.Retain",
  note: "bad name",
  enabled: true,
  tabName: "sprefa-2",
  targets: [{ session: "sess-a", turn: 3080, role: "assistant", replyTurn: 3083 }],
  createdTs: 0,
  updatedTs: 0,
  ...over,
});

const fork = (over: Partial<BoopTurnCommentFork> = {}): BoopTurnCommentFork => ({
  commentId: 26,
  lane: "fork-comment-26",
  branch: "fork/comment-26",
  brief: "~/agents/mail/forks/comment-26.md",
  createdTs: 0,
  state: "done",
  rc: 0,
  reply: { session: "fork-comment-26", turn: 40, said: "the fix is a one-line change to the query" },
  ...over,
});

const lines = [
  line("l1", 20, "  - DBSP.State.Integrate"),
  line("l2", 21, "  - DBSP.State.Retain"),
  line("l3", 22, "  - DBSP.Event.Arrival"),
];

const placed = (): PlacedAnnotation[] =>
  placeAnnotations([comment()], [turn("sess-a:3080", 20, 22)], lines);

describe("placeForks", () => {
  it("places one fork per (comment_id, lane) on the comment's row", () => {
    const result = placeForks(placed(), [
      fork(),
      fork({ lane: "fork-comment-26-retry", branch: "fork/comment-26-retry" }),
    ]);
    expect(result).toHaveLength(2);
    for (const entry of result) expect(entry.bufferRow).toBe(21);
    expect(result.map((entry) => entry.fork.lane))
      .toEqual(["fork-comment-26", "fork-comment-26-retry"]);
  });

  it("drops forks whose comment is not placed on screen", () => {
    const result = placeForks(placed(), [fork({ commentId: 99 })]);
    expect(result).toHaveLength(0);
  });
});

describe("forkBlock", () => {
  it("renders a done header with the lane, preset, state and rc", () => {
    const block = forkBlock({ ...placed()[0], fork: fork() }, 80);
    expect(block.afterBufferRow).toBe(21);
    expect(block.lines[0]).toBe("└ fork-comment-26 (flash4) done rc=0");
  });

  it("wraps the reply at cols", () => {
    const block = forkBlock({ ...placed()[0], fork: fork() }, 20);
    expect(block.lines.slice(1))
      .toEqual(wrapText("the fix is a one-line change to the query", 20).map((text) => `  ${text}`));
    expect(block.lines.slice(1).every((text) => text.length <= 22)).toBe(true);
  });

  it("renders the header only while a lane is running", () => {
    const running = fork({ state: "running", rc: null, reply: null });
    const block = forkBlock({ ...placed()[0], fork: running }, 40);
    expect(block.lines).toEqual(["└ fork-comment-26 (flash4) running"]);
  });
});
