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
  navGroupOf,
  navMenuLevels,
  openNavMenu,
  orderedGroups,
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
    expect(rows[0].dataset.hasChildren).toBe("true");
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
      order,
      holdMs: 10,
    });
    rowsOf(0)[0].dispatchEvent(new MouseEvent("mouseenter"));
    await flush();
  }

  it("moves an item within its group after the hold and persists the order", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const order = Signal<NavMenuOrder>(empty_nav_order);
    await openSubmenu(order);
    const [flash4, pro4] = rowsOf(1);
    pointer("pointerdown", flash4);
    vi.advanceTimersByTime(20);
    pointer("pointermove", pro4);
    pointer("pointerup", pro4);
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
    const rows = rowsOf(1);
    pointer("pointerdown", rows[0]);
    vi.advanceTimersByTime(20);
    pointer("pointermove", rows[2]);
    pointer("pointerup", rows[2]);
    expect(order.$()).toEqual(empty_nav_order);
    vi.useRealTimers();
  });
});
