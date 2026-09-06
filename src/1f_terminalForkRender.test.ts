/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { Signal } from "@hafley66/signals";
import type { VisibleTerminalLine } from "./00b_terminalLineAnchors";
import type { TerminalRowGeometry } from "./0_terminalRowGeometry";
import type { VisibleTurn } from "./0_terminalTurnVisibility";
import type { GutterPaint } from "./1a2_terminalContextGutter";
import type { BoopTurnComment, BoopTurnCommentFork } from "./1b_terminalContextSync";
import { placeAnnotations, type PlacedAnnotation } from "./1d_terminalTurnMarks";
import { placeForks, type PlacedFork } from "./1e_terminalForkMarks";
import {
  forkAge,
  forkBodyLines,
  forkCommand,
  forkHeaderText,
  forkKey,
  forkMenuTargets,
  forkShape,
  placeForkOverlays,
  placeForkPanes,
  tailLines,
  TerminalForkRender,
  fork_indent_px,
  fork_pane_rows,
} from "./1f_terminalForkRender";

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
  createdTs: FORKED_AT,
  state: "done",
  rc: 0,
  reply: { session: "fork-comment-26", turn: 40, said: "moved the budget into deliver_hail_budgeted" },
  tmux: "fork-comment-26",
  ...over,
});

const FORKED_AT = 1_700_000_000_000;

const lines = [
  line("l1", 20, "  - DBSP.State.Integrate"),
  line("l2", 21, "  - DBSP.State.Retain"),
  line("l3", 22, "  - DBSP.Event.Arrival"),
];

const geometry: TerminalRowGeometry = {
  viewportY: 18,
  rows: 24,
  cellHeight: 20,
  top: 0,
  left: 60,
  right: 8,
  screen: { top: 0, bottom: 480, left: 60, right: 800, height: 480 },
};

const placedAnnotations = (over: Partial<BoopTurnComment> = {}): PlacedAnnotation[] =>
  placeAnnotations([comment(over)], [turn("sess-a:3080", 20, 22)], lines);

const placed = (forks: BoopTurnCommentFork[]): PlacedFork[] =>
  placeForks(placedAnnotations(), forks);

describe("the shape switch", () => {
  it("reads the boolean: false is the overlay, true is the child pane", () => {
    expect(forkShape(false)).toBe("overlay");
    expect(forkShape(true)).toBe("pane");
  });
});

describe("header and body", () => {
  it("names the lane, preset, state, rc and age, with the disclosure arrow", () => {
    expect(forkHeaderText(fork(), false, FORKED_AT + 72_000))
      .toBe("▸ fork-comment-26  flash4  done rc=0  1m12s");
    expect(forkHeaderText(fork(), true, FORKED_AT + 72_000).startsWith("▾")).toBe(true);
  });

  it("drops rc and keeps the age while a lane is running", () => {
    expect(forkHeaderText(fork({ state: "running", rc: null, reply: null }), false, FORKED_AT + 12_000))
      .toBe("▸ fork-comment-26  flash4  running  12s");
  });

  it("formats an age in seconds, minutes and hours", () => {
    expect(forkAge(FORKED_AT, FORKED_AT + 9_000)).toBe("9s");
    expect(forkAge(FORKED_AT, FORKED_AT + 72_000)).toBe("1m12s");
    expect(forkAge(FORKED_AT, FORKED_AT + 7_440_000)).toBe("2h04m");
  });

  it("reads a lane whose row carries seconds, not milliseconds", () => {
    expect(forkAge(FORKED_AT / 1000, FORKED_AT + 9_000)).toBe("9s");
    expect(forkAge(0, FORKED_AT)).toBe("");
  });

  it("wraps the reply and closes on the branch and brief", () => {
    const body = forkBodyLines(fork(), 30);
    expect(body[0].startsWith("│ ")).toBe(true);
    expect(body[body.length - 1]).toBe("└ fork/comment-26  ~/agents/mail/forks/comment-26.md");
  });

  it("has only the branch line while a lane has not replied", () => {
    expect(forkBodyLines(fork({ state: "running", rc: null, reply: null }), 30))
      .toEqual(["└ fork/comment-26  ~/agents/mail/forks/comment-26.md"]);
  });
});

describe("placement", () => {
  it("puts an overlay on the mark row plus one, spanning the grid", () => {
    const [box] = placeForkOverlays(geometry, placed([fork()]));
    expect(box).toMatchObject({ key: "26:fork-comment-26", bufferRow: 22, top: 80, left: 60, right: 8, onScreen: true });
  });

  it("indents a pane and gives it a fixed height in rows", () => {
    const [box] = placeForkPanes(geometry, placed([fork()]));
    expect(box).toMatchObject({ top: 80, left: 60 + fork_indent_px, height: fork_pane_rows * 20, spacer: 0 });
  });

  it("stacks two panes on one row: the second starts where the first ends", () => {
    const panes = placeForkPanes(geometry, placed([fork(), fork({ lane: "fork-comment-26-retry" })]));
    expect(panes.map((pane) => pane.top)).toEqual([80, 80 + fork_pane_rows * 20]);
    expect(panes[1].spacer).toBe(fork_pane_rows * 20);
  });

  it("leaves a pane far below its neighbour on its own row", () => {
    const near = placed([fork()])[0];
    const far: PlacedFork = { ...near, bufferRow: 60, fork: fork({ lane: "fork-comment-26-retry" }) };
    const panes = placeForkPanes(geometry, [near, far]);
    expect(panes.map((pane) => pane.spacer)).toEqual([0, 0]);
    expect(panes[1].top).toBe((61 - geometry.viewportY) * geometry.cellHeight);
  });

  it("hides an overlay whose row scrolled off the viewport", () => {
    const off = placeForkOverlays({ ...geometry, viewportY: 200 }, placed([fork()]));
    expect(off[0].onScreen).toBe(false);
  });
});

describe("the child pane's mirror", () => {
  it("keeps the last rows of a capture", () => {
    expect(tailLines("a\nb\nc\nd\n\n", 2)).toEqual(["c", "d"]);
    expect(tailLines("a", 4)).toEqual(["a"]);
  });
});

describe("the fork trigger", () => {
  it("spells the verb boop already has", () => {
    expect(forkCommand(26, "flash4")).toBe("boop beep fork 26 --preset flash4");
  });

  it("offers one target per stored comment, labelled by its note", () => {
    expect(forkMenuTargets(placedAnnotations())).toEqual([{ commentId: 26, label: "bad name" }]);
  });

  it("refuses a comment the store has never seen", () => {
    expect(forkMenuTargets(placedAnnotations({ commentId: 0 }))).toEqual([]);
  });
});

/// The painter under a fake gutter: one element per fork, both shapes off the
/// same placed rows.
function render(livePane: boolean, forks: BoopTurnCommentFork[], capture?: (target: string) => Promise<string>) {
  const gutter = document.createElement("div");
  const followers = new Set<(paint: GutterPaint) => void>();
  const host = { gutter, gutterPaint: { followers, schedule: () => {} }, term: { cols: 80 } };
  const view = new TerminalForkRender(host, {
    livePane: Signal(livePane),
    placedForks: () => placed(forks),
    capture,
    now: () => FORKED_AT + 72_000,
  });
  view.paint({ geometry, turns: [], lines } as unknown as GutterPaint);
  return { view, gutter };
}

describe("TerminalForkRender", () => {
  it("paints one collapsed overlay per fork, headers only", () => {
    const { view, gutter } = render(false, [fork()]);
    const node = gutter.querySelector<HTMLElement>(".term-fork")!;
    expect(node.dataset.shape).toBe("overlay");
    expect(node.style.top).toBe("80px");
    expect(node.querySelector(".term-fork-header")!.textContent)
      .toBe("▸ fork-comment-26  flash4  done rc=0  1m12s");
    expect(node.querySelector<HTMLElement>(".term-fork-body")!.hidden).toBe(true);
    view.dispose();
  });

  it("expands on a click and collapses on the next one", () => {
    const { view, gutter } = render(false, [fork()]);
    const header = gutter.querySelector<HTMLButtonElement>(".term-fork-header")!;
    header.click();
    view.paint({ geometry, turns: [], lines } as unknown as GutterPaint);
    const body = gutter.querySelector<HTMLElement>(".term-fork-body")!;
    expect(body.hidden).toBe(false);
    expect(body.textContent).toContain("deliver_hail_budgeted");
    header.click();
    view.paint({ geometry, turns: [], lines } as unknown as GutterPaint);
    expect(gutter.querySelector<HTMLElement>(".term-fork-body")!.hidden).toBe(true);
    view.dispose();
  });

  it("switches to a child pane bound to the lane's tmux target", async () => {
    const capture = vi.fn(async () => "one\ntwo\nthree");
    const { view, gutter } = render(true, [fork()], capture);
    const node = gutter.querySelector<HTMLElement>(".term-fork")!;
    expect(node.dataset.shape).toBe("pane");
    expect(node.style.height).toBe(`${fork_pane_rows * 20}px`);
    expect(node.querySelector(".term-fork-header")!.textContent)
      .toBe("tmux fork-comment-26 · flash4 · done");
    expect(capture).toHaveBeenCalledWith("fork-comment-26");
    await Promise.resolve();
    await Promise.resolve();
    expect(node.querySelector(".term-fork-body")!.textContent).toBe("one\ntwo\nthree");
    view.dispose();
  });

  it("never captures in the overlay shape", () => {
    const capture = vi.fn(async () => "");
    const { view } = render(false, [fork()], capture);
    expect(capture).not.toHaveBeenCalled();
    view.dispose();
  });

  it("drops the element of a fork that left the screen", () => {
    const gutter = document.createElement("div");
    const followers = new Set<(paint: GutterPaint) => void>();
    const host = { gutter, gutterPaint: { followers, schedule: () => {} }, term: { cols: 80 } };
    let forks = [fork()];
    const view = new TerminalForkRender(host, {
      livePane: Signal(false),
      placedForks: () => placed(forks),
      now: () => FORKED_AT + 72_000,
    });
    view.paint({ geometry, turns: [], lines } as unknown as GutterPaint);
    expect(gutter.querySelectorAll(".term-fork")).toHaveLength(1);
    forks = [];
    view.paint({ geometry, turns: [], lines } as unknown as GutterPaint);
    expect(gutter.querySelectorAll(".term-fork")).toHaveLength(0);
    view.dispose();
  });

  it("keys elements by comment and lane", () => {
    expect(forkKey(fork())).toBe("26:fork-comment-26");
  });
});
