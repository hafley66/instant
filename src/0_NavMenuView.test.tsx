/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Signal } from "@hafley66/signals";
import type { Signal as SignalOf } from "@hafley66/signals";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  empty_nav_order,
  navMenuModel,
  type NavGroup,
  type NavMenuFavorites,
  type NavMenuOrder,
  type NavMenuPersistence,
} from "./0_navMenu";
import { closeNavMenu, navMenuLevels, NavMenu, openNavMenu } from "./0_NavMenuView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const groups = (): NavGroup[] => [
  { id: "opencode", label: "opencode", items: [
    { id: "flash4", label: "flash4", subtext: "deepseek-v4-flash" },
    { id: "pro4", label: "pro4", subtext: "deepseek-v4-pro" },
  ] },
  { id: "claude", label: "claude", items: [
    { id: "opus", label: "opus", subtext: "claude-opus-5 @high" },
  ] },
];

const persistence = (favorites: NavMenuFavorites = []): NavMenuPersistence => ({
  order: Signal<NavMenuOrder>(empty_nav_order),
  favorites: Signal<NavMenuFavorites>(favorites),
});

const settle = () => act(async () => { await Promise.resolve(); });

async function open(entries: Parameters<typeof openNavMenu>[2], options: Parameters<typeof openNavMenu>[3] = {}) {
  await act(async () => { openNavMenu(10, 10, entries, options); });
}

async function fire(target: Element, type: string, init: MouseEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(Object.assign(
      new MouseEvent(type, { bubbles: true, clientX: 5, clientY: 5, button: 0, ...init }),
      { pointerId: 1 },
    ));
  });
}

/// React derives mouseenter from a delegated mouseover, so a hover is a
/// bubbling mouseover, not a synthetic mouseenter.
const hover = (target: Element) => fire(target, "mouseover");

async function key(name: string) {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
  });
}

const level = (depth: number) => navMenuLevels()[depth];
const rowsOf = (depth: number) => [...level(depth).querySelectorAll<HTMLElement>(".ctx-item")];
const idsOf = (depth: number) => rowsOf(depth).map((row) => row.dataset.navId);

afterEach(async () => { await act(async () => { closeNavMenu(); }); });

describe("the menu, rendered by React", () => {
  it("paints a row per entry with its subtext and a submenu arrow", async () => {
    await open([
      { id: "fork", label: "Fork selection", subtext: "flash4", run: () => {}, children: groups() },
      { sep: true },
      { id: "copy", label: "Copy selection", run: () => {} },
    ]);
    expect(idsOf(0)).toEqual(["fork", "copy"]);
    expect(rowsOf(0)[0].querySelector(".ctx-subtext")!.textContent).toBe("flash4");
    expect(rowsOf(0)[0].querySelector(".ctx-arrow")).toBeTruthy();
    expect(level(0).querySelectorAll(".ctx-sep")).toHaveLength(1);
    expect(level(0).getAttribute("popover")).toBe("manual");
  });

  it("runs the main item on click without opening the submenu", async () => {
    const run = vi.fn();
    await open([{ id: "fork", label: "Fork selection", run, children: groups() }]);
    await fire(rowsOf(0)[0], "click");
    expect(run).toHaveBeenCalledTimes(1);
    expect(navMenuLevels()).toHaveLength(0);
  });

  it("opens a submenu of groups on hover, resolving children that are a function", async () => {
    await open([{ id: "fork", label: "Fork selection", children: async () => groups() }]);
    await hover(rowsOf(0)[0]);
    await settle();
    expect(navMenuLevels()).toHaveLength(2);
    const headers = [...level(1).querySelectorAll<HTMLElement>(".ctx-group")];
    expect(headers.map((header) => header.dataset.groupId)).toEqual(["opencode", "claude"]);
    expect(idsOf(1)).toEqual(["flash4", "pro4", "opus"]);
  });

  it("walks with the arrows, runs on Enter and closes on Escape", async () => {
    const run = vi.fn();
    await open([
      { id: "a", label: "A", run: () => {} },
      { id: "b", label: "B", run },
    ]);
    await key("ArrowDown");
    await key("ArrowDown");
    expect(rowsOf(0)[1].classList.contains("ctx-active")).toBe(true);
    await key("Enter");
    expect(run).toHaveBeenCalledTimes(1);
    await open([{ id: "a", label: "A", run: () => {} }]);
    await key("Escape");
    expect(navMenuLevels()).toHaveLength(0);
  });

  it("opens the submenu on ArrowRight and closes it on ArrowLeft", async () => {
    await open([{ id: "fork", label: "Fork selection", children: groups() }]);
    await key("ArrowDown");
    await key("ArrowRight");
    await settle();
    expect(navMenuLevels()).toHaveLength(2);
    await key("ArrowLeft");
    expect(navMenuLevels()).toHaveLength(1);
  });
});

describe("hold to reorder", () => {
  async function openSub(persist: NavMenuPersistence, children = groups()) {
    await open([{ id: "fork", label: "Fork selection", children, persist }], { holdMs: 10 });
    await hover(rowsOf(0)[0]);
    await settle();
  }

  it("moves an item within its group after the hold and persists the order", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const persist = persistence();
    await openSub(persist);
    await fire(rowsOf(1)[0], "pointerdown");
    await act(async () => { vi.advanceTimersByTime(20); });
    await fire(rowsOf(1)[1], "pointermove");
    await fire(rowsOf(1)[1], "pointerup");
    expect(persist.order.$().items.opencode).toEqual(["pro4", "flash4"]);
    expect(idsOf(1)).toEqual(["pro4", "flash4", "opus"]);
    vi.useRealTimers();
  });

  it("leaves the order alone when the pointer never held", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const persist = persistence();
    await openSub(persist);
    await fire(rowsOf(1)[0], "pointerdown");
    await fire(rowsOf(1)[1], "pointermove");
    await fire(rowsOf(1)[1], "pointerup");
    expect(persist.order.$()).toEqual(empty_nav_order);
    vi.useRealTimers();
  });

  it("refuses a move that would take an item out of its group", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const persist = persistence();
    await openSub(persist);
    await fire(rowsOf(1)[0], "pointerdown");
    await act(async () => { vi.advanceTimersByTime(20); });
    await fire(rowsOf(1)[2], "pointermove");
    await fire(rowsOf(1)[2], "pointerup");
    expect(persist.order.$()).toEqual(empty_nav_order);
    vi.useRealTimers();
  });
});

describe("the submenu's search row and stars", () => {
  const many = (): NavGroup[] => [
    { id: "opencode", label: "opencode", items: Array.from({ length: 6 }, (_, at) => ({
      id: `o${at}`, label: `preset-${at}`,
    })) },
    { id: "claude", label: "claude", items: [{ id: "opus", label: "opus" }] },
  ];

  async function openSub(children: NavGroup[], persist = persistence()) {
    await open([{ id: "fork", label: "Fork", children, persist }]);
    await hover(rowsOf(0)[0]);
    await settle();
    return persist;
  }

  async function type(text: string) {
    const input = level(1).querySelector<HTMLInputElement>(".ctx-search-input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input;
  }

  it("draws a search row past the item threshold and filters as it is typed", async () => {
    await openSub(many());
    expect(level(1).querySelector(".ctx-search-input")).toBeTruthy();
    await type("opus");
    expect(idsOf(1)).toEqual(["opus"]);
    const shown = [...level(1).querySelectorAll<HTMLElement>(".ctx-group")];
    expect(shown.map((group) => group.dataset.groupId)).toEqual(["claude"]);
  });

  it("keeps the same input element as the query narrows the list", async () => {
    await openSub(many());
    const first = level(1).querySelector<HTMLInputElement>(".ctx-search-input")!;
    await type("opus");
    expect(level(1).querySelector(".ctx-search-input")).toBe(first);
  });

  it("draws no search row for a short submenu", async () => {
    await openSub(groups());
    expect(level(1).querySelector(".ctx-search-input")).toBeNull();
  });

  it("clears the query on Escape before it closes the menu", async () => {
    await openSub(many());
    await type("opus");
    await key("Escape");
    expect(navMenuLevels()).toHaveLength(2);
    expect(rowsOf(1).length).toBeGreaterThan(1);
    await key("Escape");
    expect(navMenuLevels()).toHaveLength(0);
  });

  it("stars a row from its glyph and pins it to the top", async () => {
    const persist = await openSub(groups());
    const star = rowsOf(1)[2].querySelector<HTMLButtonElement>(".ctx-star")!;
    await fire(star, "pointerdown");
    expect(persist.favorites.$()).toEqual(["opus"]);
    expect(idsOf(1)[0]).toBe("fav:opus");
    expect(rowsOf(1)[0].querySelector(".ctx-label")!.textContent).toBe("claude: opus");
  });

  it("stars the focused row from the keyboard", async () => {
    const persist = await openSub(groups());
    await key("ArrowDown");
    await key("f");
    expect(persist.favorites.$()).toEqual(["flash4"]);
  });

  it("never runs the row it starred", async () => {
    const ran: string[] = [];
    const withRun: NavGroup[] = [{ id: "claude", label: "claude", items: [
      { id: "opus", label: "opus", run: () => ran.push("opus") },
    ] }];
    const persist = await openSub(withRun);
    const star = rowsOf(1)[0].querySelector<HTMLButtonElement>(".ctx-star")!;
    await fire(star, "pointerdown");
    await fire(star, "click");
    expect(persist.favorites.$()).toEqual(["opus"]);
    expect(ran).toEqual([]);
  });

  it("keeps the row element the pointer rests on across a repeated hover", async () => {
    await openSub(groups());
    const row = rowsOf(1)[0];
    await hover(row);
    await hover(rowsOf(1)[0]);
    expect(rowsOf(1)[0]).toBe(row);
  });
});

describe("one signal, one row repainted", () => {
  it("re-renders only the row whose star changed", async () => {
    const renders: string[] = [];
    const persist = persistence(["opus"]);
    const model = navMenuModel();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<NavMenu model={model} onRowRender={(id) => renders.push(id)} />);
    });
    await act(async () => {
      model.open(0, 0, [{ id: "fork", label: "Fork", children: groups(), persist }]);
    });
    await act(async () => { model.openSubmenu(0, "fork"); });
    await settle();
    renders.length = 0;
    await act(async () => { model.toggleFavorite(1, "flash4"); });
    expect(renders.filter((id) => id === "pro4")).toHaveLength(0);
    expect(renders.filter((id) => id === "opus")).toHaveLength(0);
    expect(renders).toContain("flash4");
    expect(renders).toContain("fav:flash4");
    await act(async () => { root.unmount(); });
    host.remove();
  });
});

describe("placement", () => {
  it("hands the levels back in depth order", async () => {
    await open([{ id: "fork", label: "Fork", children: groups() }]);
    await hover(rowsOf(0)[0]);
    await settle();
    const levels = navMenuLevels();
    expect(levels).toHaveLength(2);
    expect(levels[0].contains(levels[1])).toBe(false);
    expect(levels.every((element) => element.classList.contains("ctx-menu"))).toBe(true);
  });
});

describe("persistence stays injected", () => {
  it("never writes when no persistence is given", async () => {
    const order: SignalOf<NavMenuOrder> = Signal<NavMenuOrder>(empty_nav_order);
    await open([{ id: "fork", label: "Fork", children: groups() }]);
    await hover(rowsOf(0)[0]);
    await settle();
    expect(level(1).querySelector(".ctx-star")).toBeNull();
    expect(order.$()).toEqual(empty_nav_order);
  });
});
