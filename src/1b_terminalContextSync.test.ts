import { Signal } from "@hafley66/signals";
import { Subject } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { turnsAcrossRange } from "./1a_terminalContextQueue";

const native = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]> }));
vi.mock("./generated/native", () => ({
  commands: {
    boop: {
      boopTurnComments: "boop_turn_comments",
      boopTurnCommentUpsert: "boop_turn_comment_upsert",
      boopTurnCommentDelete: "boop_turn_comment_delete",
      boopTurnCommentsSent: "boop_turn_comments_sent",
      boopTurnAnnotations: "boop_turn_annotations",
    },
  },
  invoke: async (command: string, args: unknown) => {
    native.calls.push([command, args]);
    return command === "boop_turn_comments" || command === "boop_turn_annotations" ? [] : undefined;
  },
}));
import { TerminalContextSync } from "./1b_terminalContextSync";
import type { PromptContextItem } from "./1a_terminalContextQueue";
import type { VisibleTurn } from "./0_terminalTurnVisibility";
import {
  diffItems,
  rowShowsOn,
  shapeOf,
  splitTurnId,
  toComment,
  toItem,
  type BoopTurnComment,
} from "./1b_terminalContextSync";

const item = (over: Partial<PromptContextItem> = {}): PromptContextItem => ({
  id: "selection:1:0",
  kind: "selection",
  text: "some quote",
  turnIds: ["sess-a:3"],
  enabled: true,
  ...over,
});

describe("splitTurnId", () => {
  it("splits at the last colon so sessions may contain colons", () => {
    expect(splitTurnId("sess:with:colons:12")).toEqual({ session: "sess:with:colons", turn: 12 });
  });

  it("rejects ids with no numeric turn", () => {
    expect(splitTurnId("no-colon")).toBeNull();
    expect(splitTurnId("sess:abc")).toBeNull();
  });
});

describe("toComment / toItem", () => {
  it("round-trips an annotated item through the wire shape", () => {
    const original = item({ note: "do it in rust", turnIds: ["sess-a:3", "sess-b:9"] });
    const comment = toComment(original, "tab-1");
    expect(comment.tabName).toBe("tab-1");
    expect(comment.targets).toEqual([
      { session: "sess-a", turn: 3, role: "" },
      { session: "sess-b", turn: 9, role: "" },
    ]);
    const roles: BoopTurnComment = {
      ...comment,
      targets: comment.targets.map((target, index) => ({
        ...target,
        role: index === 0 ? "user" : "assistant",
      })),
    };
    expect(toItem(roles)).toEqual(original);
  });

  it("stores a blank note as null", () => {
    expect(toComment(item({ note: "  " }), "tab-1").note).toBeNull();
  });
});

describe("diffItems", () => {
  it("reports a new item as an upsert", () => {
    const { upserts, removals } = diffItems(new Map(), [item()]);
    expect(upserts.map((entry) => entry.id)).toEqual(["selection:1:0"]);
    expect(removals).toEqual([]);
  });

  it("reports nothing for an unchanged item", () => {
    const synced = item();
    const last = new Map([[synced.id, shapeOf(synced)]]);
    expect(diffItems(last, [synced])).toEqual({ upserts: [], removals: [] });
  });

  it("reports a note edit as an upsert and a vanished id as a removal", () => {
    const synced = item();
    const last = new Map([
      [synced.id, shapeOf(synced)],
      ["selection:2:0", shapeOf(item({ id: "selection:2:0" }))],
    ]);
    const edited = item({ note: "now annotated" });
    const { upserts, removals } = diffItems(last, [edited]);
    expect(upserts.map((entry) => entry.id)).toEqual(["selection:1:0"]);
    expect(removals).toEqual(["selection:2:0"]);
  });
});

describe("rowShowsOn", () => {
  const row = (over: Partial<BoopTurnComment> = {}): BoopTurnComment => ({
    ...toComment(item({ turnIds: ["sess-a:3"] }), "tab-owner"),
    ...over,
  });

  it("always shows a row on the tab that owns it", () => {
    expect(rowShowsOn(row(), "tab-owner", new Set())).toBe(true);
  });

  it("hides a foreign row whose turns are not on screen", () => {
    expect(rowShowsOn(row({ tabName: "tab-other" }), "tab-owner", new Set(["sess-a:9"])))
      .toBe(false);
  });

  it("shows a foreign row while one of its target turns is visible", () => {
    expect(rowShowsOn(row({ tabName: "tab-other" }), "tab-owner", new Set(["sess-a:3"])))
      .toBe(true);
  });
});

describe("turnsAcrossRange", () => {  const turn = (id: string, role: string, anchorStart: number, anchorEnd: number) =>
    ({ id, role, anchorStart, anchorEnd }) as VisibleTurn;

  it("tags user turns exactly like assistant turns", () => {
    const turns = [
      turn("sess-a:3", "user", 0, 4),
      turn("sess-a:4", "assistant", 5, 9),
      turn("sess-a:5", "assistant", 20, 30),
    ];
    expect(turnsAcrossRange(turns, 2, 7)).toEqual(["sess-a:3", "sess-a:4"]);
  });
});

/// The queue as the sync layer sees it: items by id, a change stream, and the
/// `sent` burst that fires before the clear.
function fakeQueue() {
  const items = new Map<string, PromptContextItem>();
  const state = Signal<PromptContextItem[]>([]);
  return {
    items,
    state,
    changes: state.$,
    sent: new Subject<string[]>(),
    projection: { visible: [] as VisibleTurn[] },
    hydrate: () => {},
  };
}

describe("send never loses the last edit", () => {
  it("writes the final note before stamping the row sent, ahead of the debounce", async () => {
    native.calls.length = 0;
    const queue = fakeQueue();
    const sync = new TerminalContextSync(
      queue as unknown as ConstructorParameters<typeof TerminalContextSync>[0],
      "tab-1",
      async () => ["sess-a"],
    );
    const row = item({ note: "typed fast" });
    queue.items.set(row.id, row);
    queue.state.$([row]);
    // Send inside the 300 ms debounce window: the queue emits `sent`, then
    // clears, and the debounced change collapses to the empty list.
    queue.sent.next([row.id]);
    queue.items.clear();
    queue.state.$([]);
    await sync.flush();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await sync.flush();

    const writes = native.calls.filter(([command]) => command !== "boop_turn_comments" && command !== "boop_turn_annotations");
    expect(writes.map(([command]) => command)).toEqual(["boop_turn_comment_upsert", "boop_turn_comments_sent"]);
    const upsert = writes[0][1] as { comment: BoopTurnComment };
    expect(upsert.comment.note).toBe("typed fast");
    expect(writes[1][1]).toEqual({ clientIds: [row.id] });
    expect(native.calls.some(([command]) => command === "boop_turn_comment_delete"), "a sent row is never deleted").toBe(false);
    sync.dispose();
  });
});
