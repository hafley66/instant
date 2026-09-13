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
  formatRecentFocus,
  isRedundantFocus,
  parseSelectionList,
  selectionClearCommand,
  selectionFocusCommand,
  selectionListCommand,
  selectionSetCommand,
  selectionShoutCommand,
} from "./0_boopSelection";

describe("parseSelectionList", () => {
  it("parses a well-formed array and coerces fields", () => {
    const rows = parseSelectionList(
      JSON.stringify([
        {
          route: "flash4",
          session: "lane-flash4",
          pane: "%12",
          title: "build lane",
          lastFocusedAt: 1730000000000,
          selected: true,
        },
      ]),
    );
    expect(rows).toEqual([
      {
        route: "flash4",
        session: "lane-flash4",
        pane: "%12",
        title: "build lane",
        lastFocusedAt: 1730000000000,
        selected: true,
      },
    ]);
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