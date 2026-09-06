/** @vitest-environment jsdom */
import { Signal } from "@hafley66/signals";
import type { Signal as SignalOf } from "@hafley66/signals";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeNavMenu,
  empty_nav_order,
  moveNavGroup,
  moveNavItem,
  moveWithin,
  favoriteHomeId,
  filterGroups,
  navGroupOf,
  levelRows,
  navMenuLevels,
  navMenuModel,
  openNavMenu,
  orderedGroups,
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

afterEach(() => closeNavMenu());

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

function rowsOf(level: number): HTMLElement[] {
  return [...navMenuLevels()[level].querySelectorAll<HTMLElement>(".ctx-item")];
}

describe("the menu", () => {
  it("paints a row per entry with its subtext and a submenu arrow", () => {
    const run = vi.fn();
    openNavMenu(10, 10, [
      { id: "fork", label: "Fork selection", subtext: "flash4", run, children: groups() },
      { sep: true },
      { id: "copy", label: "Copy selection", run: () => {} },
    ]);
    const rows = rowsOf(0);
    expect(rows.map((row) => row.dataset.navId)).toEqual(["fork", "copy"]);
    expect(rows[0].querySelector(".ctx-subtext")!.textContent).toBe("flash4");
    expect(rows[0].querySelector(".ctx-arrow")).toBeTruthy();
    expect(navMenuLevels()[0].querySelectorAll(".ctx-sep")).toHaveLength(1);
  });

  it("runs the main item on click without opening the submenu", () => {
    const run = vi.fn();
    openNavMenu(10, 10, [{ id: "fork", label: "Fork selection", run, children: groups() }]);
    rowsOf(0)[0].click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(navMenuLevels()).toHaveLength(0);
  });

  it("opens a submenu of groups on hover, resolving children that are a function", async () => {
    openNavMenu(10, 10, [{ id: "fork", label: "Fork selection", children: async () => groups() }]);
    rowsOf(0)[0].dispatchEvent(new MouseEvent("mouseenter"));
    await flush();
    expect(navMenuLevels()).toHaveLength(2);
    const headers = [...navMenuLevels()[1].querySelectorAll<HTMLElement>(".ctx-group")];
    expect(headers.map((header) => header.dataset.groupId)).toEqual(["opencode", "claude"]);
    expect(rowsOf(1).map((row) => row.dataset.navId)).toEqual(["flash4", "pro4", "opus"]);
  });

  it("walks with the arrows, runs on Enter and closes on Escape", () => {
    const run = vi.fn();
    openNavMenu(10, 10, [
      { id: "a", label: "A", run: () => {} },
      { id: "b", label: "B", run },
    ]);
    const key = (k: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    key("ArrowDown");
    key("ArrowDown");
    expect(rowsOf(0)[1].classList.contains("ctx-active")).toBe(true);
    key("Enter");
    expect(run).toHaveBeenCalledTimes(1);
    openNavMenu(10, 10, [{ id: "a", label: "A", run: () => {} }]);
    key("Escape");
    expect(navMenuLevels()).toHaveLength(0);
  });

  it("opens the submenu on ArrowRight and closes it on ArrowLeft", async () => {
    openNavMenu(10, 10, [{ id: "fork", label: "Fork selection", children: groups() }]);
    const key = (k: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    key("ArrowDown");
    key("ArrowRight");
    await flush();
    expect(navMenuLevels()).toHaveLength(2);
    key("ArrowLeft");
    expect(navMenuLevels()).toHaveLength(1);
  });
});

describe("hold to reorder", () => {
  const pointer = (type: string, target: HTMLElement) =>
    target.dispatchEvent(Object.assign(
      new MouseEvent(type, { bubbles: true, clientX: 20, clientY: 20, button: 0 }),
      { pointerId: 1 },
    ));

  async function openSubmenu(order: SignalOf<NavMenuOrder>) {
    openNavMenu(10, 10, [{ id: "fork", label: "Fork selection", children: groups() }], {
      persistence: { order, favorites: Signal<string[]>([]) },
      holdMs: 10,
    });
    rowsOf(0)[0].dispatchEvent(new MouseEvent("mouseenter"));
    await flush();
  }

  it("moves an item within its group after the hold and persists the order", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const order = Signal<NavMenuOrder>(empty_nav_order);
    await openSubmenu(order);
    pointer("pointerdown", rowsOf(1)[0]);
    vi.advanceTimersByTime(20);
    // Arming repaints, so the row under the pointer is the freshly drawn one.
    pointer("pointermove", rowsOf(1)[1]);
    pointer("pointerup", rowsOf(1)[1]);
    expect(order.$().items.opencode).toEqual(["pro4", "flash4"]);
    expect(rowsOf(1).map((row) => row.dataset.navId)).toEqual(["pro4", "flash4", "opus"]);
    vi.useRealTimers();
  });

  it("leaves the order alone when the pointer never held", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const order = Signal<NavMenuOrder>(empty_nav_order);
    await openSubmenu(order);
    const [flash4, pro4] = rowsOf(1);
    pointer("pointerdown", flash4);
    pointer("pointermove", pro4);
    pointer("pointerup", pro4);
    expect(order.$()).toEqual(empty_nav_order);
    vi.useRealTimers();
  });

  it("refuses a move that would take an item out of its group", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const order = Signal<NavMenuOrder>(empty_nav_order);
    await openSubmenu(order);
    pointer("pointerdown", rowsOf(1)[0]);
    vi.advanceTimersByTime(20);
    pointer("pointermove", rowsOf(1)[2]);
    pointer("pointerup", rowsOf(1)[2]);
    expect(order.$()).toEqual(empty_nav_order);
    vi.useRealTimers();
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

describe("the submenu's search row and stars", () => {
  const many = (): NavGroup[] => [
    { id: "opencode", label: "opencode", items: Array.from({ length: 6 }, (_, at) => ({
      id: `o${at}`, label: `preset-${at}`,
    })) },
    { id: "claude", label: "claude", items: [{ id: "opus", label: "opus" }] },
  ];

  async function openSub(children: NavGroup[], favorites = Signal<string[]>([])) {
    openNavMenu(10, 10, [{ id: "fork", label: "Fork", children }], {
      persistence: { order: Signal<NavMenuOrder>(empty_nav_order), favorites },
    });
    rowsOf(0)[0].dispatchEvent(new MouseEvent("mouseenter"));
    await flush();
  }

  it("draws a search row past the item threshold and filters as it is typed", async () => {
    await openSub(many());
    const input = navMenuLevels()[1].querySelector<HTMLInputElement>(".ctx-search-input")!;
    expect(input).toBeTruthy();
    input.value = "opus";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(rowsOf(1).map((row) => row.dataset.navId)).toEqual(["opus"]);
    const groupsShown = [...navMenuLevels()[1].querySelectorAll<HTMLElement>(".ctx-group")];
    expect(groupsShown.map((group) => group.dataset.groupId)).toEqual(["claude"]);
  });

  it("draws no search row for a short submenu", async () => {
    await openSub(groups());
    expect(navMenuLevels()[1].querySelector(".ctx-search-input")).toBeNull();
  });

  it("clears the query on Escape before it closes the menu", async () => {
    await openSub(many());
    const input = navMenuLevels()[1].querySelector<HTMLInputElement>(".ctx-search-input")!;
    input.value = "opus";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    escape();
    expect(navMenuLevels()).toHaveLength(2);
    expect(rowsOf(1).length).toBeGreaterThan(1);
    escape();
    expect(navMenuLevels()).toHaveLength(0);
  });

  it("stars a row from its glyph and pins it to the top on the next render", async () => {
    const favorites = Signal<string[]>([]);
    await openSub(groups(), favorites);
    const star = rowsOf(1)[2].querySelector<HTMLButtonElement>(".ctx-star")!;
    star.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(favorites.$()).toEqual(["opus"]);
    expect(rowsOf(1)[0].dataset.navId).toBe("fav:opus");
    expect(rowsOf(1)[0].querySelector(".ctx-label")!.textContent).toBe("claude: opus");
  });

  it("stars the focused row from the keyboard", async () => {
    const favorites = Signal<string[]>([]);
    await openSub(groups(), favorites);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
    expect(favorites.$()).toEqual(["flash4"]);
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

describe("the star is reachable with a real pointer", () => {
  const persistence = () => ({ order: Signal<NavMenuOrder>(empty_nav_order), favorites: Signal<string[]>([]) });
  const press = (target: HTMLElement, type: string) =>
    target.dispatchEvent(Object.assign(
      new MouseEvent(type, { bubbles: true, clientX: 5, clientY: 5, button: 0 }),
      { pointerId: 1 },
    ));

  async function openFork(persist: ReturnType<typeof persistence>) {
    openNavMenu(10, 10, [{ id: "fork", label: "Fork selection", children: groups(), persist }]);
    const owner = navMenuLevels()[0].querySelector<HTMLElement>('[data-nav-id="fork"]')!;
    owner.dispatchEvent(new MouseEvent("mouseenter"));
    await flush();
  }

  it("stars on the press, so a redraw between press and click cannot swallow it", async () => {
    const persist = persistence();
    await openFork(persist);
    const row = navMenuLevels()[1].querySelector<HTMLElement>('[data-nav-id="opus"]')!;
    row.dispatchEvent(new MouseEvent("mouseenter"));
    const star = navMenuLevels()[1].querySelector<HTMLElement>('[data-nav-id="opus"] .ctx-star')!;
    press(star, "pointerdown");
    expect(persist.favorites.$()).toEqual(["opus"]);
    expect(navMenuLevels()[1].querySelector('[data-nav-id="fav:opus"]')).toBeTruthy();
  });

  it("never runs the row it starred", async () => {
    const ran: string[] = [];
    const persist = persistence();
    const withRun: NavGroup[] = [{ id: "claude", label: "claude", items: [
      { id: "opus", label: "opus", run: () => ran.push("opus") },
    ] }];
    openNavMenu(10, 10, [{ id: "fork", label: "Fork selection", children: withRun, persist }]);
    navMenuLevels()[0].querySelector<HTMLElement>('[data-nav-id="fork"]')!
      .dispatchEvent(new MouseEvent("mouseenter"));
    await flush();
    const star = navMenuLevels()[1].querySelector<HTMLElement>('[data-nav-id="opus"] .ctx-star')!;
    press(star, "pointerdown");
    star.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(persist.favorites.$()).toEqual(["opus"]);
    expect(ran).toEqual([]);
  });

  it("does not redraw the row the pointer is resting on when hover repeats", async () => {
    const persist = persistence();
    await openFork(persist);
    const row = navMenuLevels()[1].querySelector<HTMLElement>('[data-nav-id="opus"]')!;
    row.dispatchEvent(new MouseEvent("mouseenter"));
    const settled = navMenuLevels()[1].querySelector<HTMLElement>('[data-nav-id="opus"]')!;
    settled.dispatchEvent(new MouseEvent("mouseenter"));
    expect(navMenuLevels()[1].querySelector('[data-nav-id="opus"]')).toBe(settled);
  });
});
