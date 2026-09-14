// Pure helpers of the Boop selection model: parsing, shell-safe command
// construction, focus-target resolution, focus dedup, and age formatting.
// No invoke and no fakes -- the RPC wrappers are exercised by the app, not here
// (unit doubles of IO would lie; see the repo test law). jsdom is only the
// environment for the import chain (core/state read location at module load).
/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";

// Import-chain barrier only: core -> reactdock pulls the file-explorer/preview
// tree, whose PDF worker URL vite denies under test. Nothing under test comes
// from reactdock, so an empty module keeps the pure helpers isolated without
// doubling any product behavior.
vi.mock("./reactdock", () => ({ activeGroupEl: () => null }));

import {
  boopFocusTarget,
  eligibleRows,
  formatRecentFocus,
  isRedundantFocus,
  parseSelectionList,
  rowIsRecipient,
  selectionClearCommand,
  selectionFocusCommand,
  selectionListCommand,
  selectionSetCommand,
  selectionShoutCommand,
  tabReachesRow,
  type BoopSelectionRow,
} from "./0_boopSelection";

describe("parseSelectionList", () => {
  it("parses a well-formed array and coerces fields", () => {
    const rows = parseSelectionList(
      JSON.stringify([
        {
          route: "flash4",
          kind: "coordinator",
          session: "lane-flash4",
          pane: "%12",
          target: "lane-flash4:0.0",
          title: "build lane",
          lastFocusedAt: 1730000000000,
          selected: true,
        },
      ]),
    );
    expect(rows).toEqual([
      {
        route: "flash4",
        kind: "coordinator",
        session: "lane-flash4",
        pane: "%12",
        target: "lane-flash4:0.0",
        title: "build lane",
        lastFocusedAt: 1730000000000,
        selected: true,
      },
    ]);
  });

  it("defaults kind and target to empty for an older backend", () => {
    const [row] = parseSelectionList(JSON.stringify([{ route: "a", session: "s" }]));
    expect(row).toMatchObject({ route: "a", kind: "", target: "", pane: "" });
  });

  it("rejects a row without a route", () => {
    expect(() => parseSelectionList(JSON.stringify([{ session: "orphan" }]))).toThrow(
      /row 0/,
    );
  });

  it("rejects non-object rows", () => {
    expect(() => parseSelectionList(JSON.stringify(["nope"]))).toThrow(/row 0 is not an object/);
    expect(() => parseSelectionList(JSON.stringify([7]))).toThrow(/row 0 is not an object/);
    expect(() => parseSelectionList(JSON.stringify([null]))).toThrow(/row 0 is not an object/);
    expect(() => parseSelectionList(JSON.stringify([[]]))).toThrow(/row 0 is not an object/);
  });

  it("defaults session to route and null focus when absent", () => {
    const [row] = parseSelectionList(JSON.stringify([{ route: "a" }]));
    expect(row).toMatchObject({ route: "a", session: "a", pane: "", title: "", lastFocusedAt: null, selected: false });
  });

  it("rejects wrong-typed selected and non-finite focus", () => {
    expect(() =>
      parseSelectionList(JSON.stringify([{ route: "a", selected: "yes" }])),
    ).toThrow(/selected must be a boolean/);
    expect(() =>
      parseSelectionList(JSON.stringify([{ route: "a", lastFocusedAt: "soon" }])),
    ).toThrow(/lastFocusedAt must be a finite number/);
  });

  it("throws on junk, empty, or a non-array JSON body", () => {
    expect(() => parseSelectionList("not json")).toThrow(/invalid JSON/);
    expect(() => parseSelectionList("")).toThrow(/empty output/);
    expect(() => parseSelectionList('{"route":"a"}')).toThrow(/expected a JSON array/);
  });
});

describe("command construction", () => {
  it("lists, clears, and sets with and without --checked", () => {
    expect(selectionListCommand()).toBe("boop beep selection list");
    expect(selectionClearCommand()).toBe("boop beep selection clear");
    expect(selectionSetCommand("flash4", true)).toBe(
      "boop beep selection set 'flash4' --checked",
    );
    expect(selectionSetCommand("flash4", false)).toBe("boop beep selection set 'flash4'");
  });

  it("single-quotes a route so shell metacharacters cannot escape", () => {
    const cmd = selectionSetCommand("a'; rm -rf /; echo '", false);
    expect(cmd).toBe("boop beep selection set 'a'\\''; rm -rf /; echo '\\'''");
    expect(cmd).not.toMatch(/set\s+a;/);
  });

  it("floors the focus timestamp and quotes the target", () => {
    expect(selectionFocusCommand("lane-a", 1730000000123.9)).toBe(
      "boop beep selection focus 'lane-a' --at 1730000000123",
    );
  });

  it("emits one --to per route, in order, then --as instant, --, and the quoted body", () => {
    expect(selectionShoutCommand(["a", "b"], "hello world")).toBe(
      "boop beep shout --to 'a' --to 'b' --as 'instant' -- 'hello world'",
    );
  });

  it("throws rather than build a broad shout with no recipients", () => {
    expect(() => selectionShoutCommand([], "hi")).toThrow(/no recipients/);
  });

  it("separates the body with -- so a dash-prefixed body stays literal", () => {
    expect(selectionShoutCommand(["a"], "--checked")).toBe(
      "boop beep shout --to 'a' --as 'instant' -- '--checked'",
    );
  });

  it("quotes a body carrying quotes and shell syntax", () => {
    expect(selectionShoutCommand(["a"], "it's $(evil)")).toBe(
      "boop beep shout --to 'a' --as 'instant' -- 'it'\\''s $(evil)'",
    );
  });
});

describe("boopFocusTarget", () => {
  it("prefers the leaf pane target when present", () => {
    expect(boopFocusTarget({ name: "lane-a", tmuxTarget: "%12" })).toBe("%12");
  });

  it("falls back to the session name when the pane target is absent or blank", () => {
    expect(boopFocusTarget({ name: "lane-a" })).toBe("lane-a");
    expect(boopFocusTarget({ name: "lane-a", tmuxTarget: "   " })).toBe("lane-a");
  });
});

describe("isRedundantFocus", () => {
  it("is redundant only for the same target inside the window", () => {
    expect(isRedundantFocus("a", 1000, "a", 1500, 2000)).toBe(true);
    expect(isRedundantFocus("a", 1000, "a", 3500, 2000)).toBe(false);
    expect(isRedundantFocus("a", 1000, "b", 1500, 2000)).toBe(false);
    expect(isRedundantFocus(null, 0, "a", 1500, 2000)).toBe(false);
  });
});

describe("open-tab eligibility", () => {
  const row = (over: Partial<BoopSelectionRow> = {}): BoopSelectionRow => ({
    route: "coord",
    kind: "coordinator",
    session: "coord-session",
    pane: "%3",
    target: "coord-session:0.0",
    title: "coord",
    lastFocusedAt: null,
    selected: false,
    ...over,
  });

  it("treats only coordinator and native (and an unstamped kind) as recipients", () => {
    expect(rowIsRecipient({ kind: "coordinator" })).toBe(true);
    expect(rowIsRecipient({ kind: "native" })).toBe(true);
    expect(rowIsRecipient({ kind: "" })).toBe(true);
    expect(rowIsRecipient({ kind: "lane" })).toBe(false);
    expect(rowIsRecipient({ kind: "shell" })).toBe(false);
  });

  it("matches a plain tab by session name, never a display alias", () => {
    expect(tabReachesRow({ name: "coord-session" }, row())).toBe(true);
    expect(tabReachesRow({ name: "coord-session" }, row({ session: "other" }))).toBe(false);
  });

  it("matches a viewer tab by pane id, composed target, session, or window", () => {
    expect(tabReachesRow({ name: "v", tmuxTarget: "%3" }, row())).toBe(true);
    expect(tabReachesRow({ name: "v", tmuxTarget: "coord-session:0.0" }, row())).toBe(true);
    expect(tabReachesRow({ name: "v", tmuxTarget: "coord-session" }, row())).toBe(true);
    expect(tabReachesRow({ name: "v", tmuxTarget: "coord-session:0" }, row())).toBe(true);
    expect(tabReachesRow({ name: "v", tmuxTarget: "coord-session:1" }, row())).toBe(false);
    expect(tabReachesRow({ name: "v", tmuxTarget: "%9" }, row())).toBe(false);
  });

  it("keeps a coordinator whose tab is open, drops a lane and a closed tab", () => {
    const rows = [
      row({ route: "open-coord" }),
      row({ route: "open-lane", kind: "lane", session: "lane-session", pane: "%4" }),
      row({ route: "closed-coord", session: "closed-session", pane: "%5", target: "closed-session:0.0" }),
    ];
    const tabs = [
      { name: "coord-session" },
      { name: "lane-session" },
      { name: "viewer", tmuxTarget: "%4" },
    ];
    const visible = eligibleRows(rows, tabs);
    expect(visible.map((r) => r.route)).toEqual(["open-coord"]);
    // A checked closed coord never enters the send snapshot: eligibility is the
    // one predicate the count and the send both read.
    expect(visible.filter((r) => r.selected).map((r) => r.route)).toEqual([]);
  });

  it("treats a pane-specific viewer as reaching only its pane", () => {
    const rows = [
      row({ route: "a", pane: "%1", target: "s:0.0" }),
      row({ route: "b", pane: "%2", target: "s:0.1" }),
    ];
    const tabs = [{ name: "viewer", tmuxTarget: "%2" }];
    expect(eligibleRows(rows, tabs).map((r) => r.route)).toEqual(["b"]);
  });

  it("drops a checked recipient the moment its tab closes", () => {
    const rows = [row({ route: "a", selected: true })];
    expect(eligibleRows(rows, [{ name: "coord-session" }]).map((r) => r.route)).toEqual(["a"]);
    expect(eligibleRows(rows, []).filter((r) => r.selected)).toEqual([]);
  });
});

describe("formatRecentFocus", () => {
  const now = 1_730_000_000_000;
  it("reads never-focused as an em dash", () => {
    expect(formatRecentFocus(null, now)).toBe("—");
    expect(formatRecentFocus(0, now)).toBe("—");
  });
  it("renders compact seconds, minutes, hours, and days", () => {
    expect(formatRecentFocus(now - 5_000, now)).toBe("5s");
    expect(formatRecentFocus(now - 5 * 60_000, now)).toBe("5m");
    expect(formatRecentFocus(now - 5 * 3_600_000, now)).toBe("5h");
    expect(formatRecentFocus(now - 5 * 86_400_000, now)).toBe("5d");
  });
});