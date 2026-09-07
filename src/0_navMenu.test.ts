/** @vitest-environment jsdom */
import { Signal } from "@hafley66/signals";
import { describe, expect, it } from "vitest";
import {
  empty_nav_order,
  moveNavGroup,
  moveNavItem,
  moveWithin,
  favoriteHomeId,
  filterGroups,
  navGroupOf,
  levelRows,
  navMenuModel,
  orderedGroups,
  placeMenu,
  toggleFavorite,
  withFavorites,
  type NavGroup,
  type NavMenuOrder,
} from "./0_navMenu";

const groups = (): NavGroup[] => [
  { id: "opencode", label: "opencode", items: [
    { id: "flash4", label: "flash4", subtext: "deepseek-v4-flash" },
    { id: "pro4", label: "pro4", subtext: "deepseek-v4-pro" },
  ] },
  { id: "claude", label: "claude", items: [
    { id: "opus", label: "opus", subtext: "claude-opus-5 @high" },
  ] },
];

describe("order", () => {
  it("keeps the user's group order and appends groups it has never seen", () => {
    const order: NavMenuOrder = { groups: ["claude"], items: {} };
    expect(orderedGroups(groups(), order).map((group) => group.id)).toEqual(["claude", "opencode"]);
  });

  it("keeps the user's item order inside a group and drops ids that are gone", () => {
    const order: NavMenuOrder = { groups: [], items: { opencode: ["pro4", "retired", "flash4"] } };
    const [opencode] = orderedGroups(groups(), order);
    expect(opencode.items.map((item) => item.id)).toEqual(["pro4", "flash4"]);
  });

  it("takes the slot it was dropped on, dragging either way", () => {
    expect(moveWithin(["a", "b", "c"], "a", "b")).toEqual(["b", "a", "c"]);
    expect(moveWithin(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveWithin(["a", "b"], "a", "a")).toEqual(["a", "b"]);
  });

  it("moves an item inside its own group", () => {
    const next = moveNavItem(groups(), empty_nav_order, "flash4", "pro4");
    expect(next.items.opencode).toEqual(["pro4", "flash4"]);
  });

  it("refuses to move an item out of its harness group", () => {
    const next = moveNavItem(groups(), empty_nav_order, "opus", "flash4");
    expect(next).toBe(empty_nav_order);
    expect(navGroupOf(groups(), "opus")).toBe("claude");
  });

  it("moves a whole group", () => {
    expect(moveNavGroup(groups(), empty_nav_order, "claude", "opencode").groups)
      .toEqual(["claude", "opencode"]);
  });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("placeMenu", () => {
  const size = { width: 100, height: 40 };
  const viewport = { width: 1000, height: 1000 };

  it("stays at the point when the menu fits right", () => {
    expect(placeMenu(size, { x: 0, y: 0 }, viewport, 50)).toEqual({ left: 0, top: 0 });
  });

  it("puts its right edge on the owner's right edge when it overflows right", () => {
    expect(placeMenu(size, { x: 950, y: 0 }, viewport, 960)).toEqual({ left: 860, top: 0 });
  });

  it("clamps to zero instead of going negative", () => {
    expect(placeMenu(size, { x: 950, y: 0 }, viewport, 40)).toEqual({ left: 0, top: 0 });
  });
});

describe("favorites", () => {
  it("pins a starred item to a top group titled by its home group", () => {
    const pinned = withFavorites(groups(), ["opus"]);
    expect(pinned[0].id).toBe("__favorites");
    expect(pinned[0].items.map((item) => [item.id, item.label]))
      .toEqual([["fav:opus", "claude: opus"]]);
    expect(pinned[2].items.map((item) => item.id)).toEqual(["opus"]);
  });

  it("keeps the favorites order and drops ids that no longer exist", () => {
    const pinned = withFavorites(groups(), ["opus", "gone", "flash4"]);
    expect(pinned[0].items.map((item) => item.id)).toEqual(["fav:opus", "fav:flash4"]);
  });

  it("adds no group when nothing is starred", () => {
    expect(withFavorites(groups(), []).map((group) => group.id)).toEqual(["opencode", "claude"]);
  });

  it("stars and unstars by home id, whichever id the row carried", () => {
    expect(toggleFavorite([], "fav:opus")).toEqual(["opus"]);
    expect(toggleFavorite(["opus"], "opus")).toEqual([]);
    expect(favoriteHomeId("fav:opus")).toBe("opus");
    expect(favoriteHomeId("opus")).toBe("opus");
  });
});

describe("search", () => {
  it("matches across every group on \"<group>: <item>\" and collapses the rest", () => {
    const hit = filterGroups(groups(), "clop");
    expect(hit.map((group) => group.id)).toEqual(["claude"]);
    expect(hit[0].items.map((item) => item.id)).toEqual(["opus"]);
  });

  it("returns every group for an empty query", () => {
    expect(filterGroups(groups(), "  ")).toEqual(groups());
  });

  it("returns nothing when no row matches", () => {
    expect(filterGroups(groups(), "zzzz")).toEqual([]);
  });
});

describe("the model, with no DOM at all", () => {
  const persistence = () => ({ order: Signal<NavMenuOrder>(empty_nav_order), favorites: Signal<string[]>([]) });

  it("draws one level's rows from state alone", () => {
    const rows = levelRows(
      { ownerId: "fork", entries: [], groups: groups(), persistence: null },
      empty_nav_order,
      ["opus"],
      "",
      "flash4",
      null,
    );
    expect(rows.filter((row) => row.kind === "group").map((row) => row.kind === "group" && row.id))
      .toEqual(["__favorites", "opencode", "claude"]);
    const focused = rows.find((row) => row.kind === "item" && row.focused);
    expect(focused?.kind === "item" && focused.id).toBe("flash4");
    expect(rows.some((row) => row.kind === "search")).toBe(false);
  });

  it("moves through open, submenu, query and favourite as one derived view", async () => {
    const persist = persistence();
    const model = navMenuModel();
    model.view.$.subscribe(() => {});
    model.open(0, 0, [{ id: "fork", label: "Fork", children: groups(), persist }]);
    expect(model.view.$().levels).toHaveLength(1);
    model.openSubmenu(0, "fork");
    await flush();
    expect(model.view.$().levels).toHaveLength(2);
    model.toggleFavorite(1, "opus");
    expect(persist.favorites.$()).toEqual(["opus"]);
    expect(model.view.$().levels[1].rows[0]).toMatchObject({ kind: "group", id: "__favorites" });
    model.armDrag(1, "flash4", "item");
    model.dragOver("pro4");
    expect(persist.order.$().items.opencode).toEqual(["pro4", "flash4"]);
    model.endDrag();
    expect(model.consumeDragClick("flash4")).toBe(true);
    model.close();
    expect(model.view.$().open).toBe(false);
  });

  it("runs the focused row and closes before the action fires", () => {
    const ran: string[] = [];
    const model = navMenuModel();
    model.view.$.subscribe(() => {});
    model.open(0, 0, [
      { id: "a", label: "A", run: () => ran.push(`a:${model.view.$().open}`) },
      { id: "b", label: "B", run: () => ran.push("b") },
    ]);
    model.moveFocus(1);
    model.activate();
    expect(ran).toEqual(["a:false"]);
  });
});
