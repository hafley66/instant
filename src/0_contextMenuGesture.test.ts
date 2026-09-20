/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
vi.mock("./0_NavMenuView", () => ({ openNavMenu: vi.fn(), closeNavMenu: vi.fn() }));
import { openNavMenu, closeNavMenu } from "./0_NavMenuView";
import { wireContextMenu } from "./ctxmenu";

let dispose = () => {};
afterEach(() => { dispose(); document.body.replaceChildren(); vi.useRealTimers(); vi.clearAllMocks(); });

it("captures once per physical right click and runs the first snapshot on a second press over the menu", () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  host.className = "term-host";
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  document.body.append(host, menu);
  const selected: string[] = [];
  let text = "original quote";
  const itemsFor = vi.fn(() => {
    const snapshot = text;
    return [{ label: "Ask about this", doubleRightClick: true, action: () => selected.push(snapshot) }];
  });
  dispose = wireContextMenu(itemsFor);
  const fire = (target: Element, type: string, button: number) => target.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, button, clientX: 100, clientY: 100,
  }));
  fire(host, "mousedown", 2);
  fire(host, "contextmenu", 0); // terminal's synthetic menu
  text = ""; // TUI rewrites selected cells
  fire(host, "contextmenu", 2); // native event for the same click
  vi.advanceTimersByTime(100);
  fire(menu, "mousedown", 2);
  fire(menu, "contextmenu", 2);
  expect({ builds: itemsFor.mock.calls.length, opens: vi.mocked(openNavMenu).mock.calls.length,
    closes: vi.mocked(closeNavMenu).mock.calls.length, selected }).toMatchInlineSnapshot(`
    {
      "builds": 1,
      "closes": 1,
      "opens": 1,
      "selected": [
        "original quote",
      ],
    }
  `);
});

it.each(["expired", "moved", "left-click", "escape", "scroll", "resize"])("does not invoke the shortcut after %s", (reason) => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  host.className = "term-host";
  document.body.append(host);
  const action = vi.fn();
  dispose = wireContextMenu(() => [{ label: "Ask about this", doubleRightClick: true, action }]);
  host.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 100 }));
  if (reason === "expired") vi.advanceTimersByTime(501);
  if (reason === "left-click") host.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  if (reason === "escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  if (reason === "scroll") host.dispatchEvent(new Event("scroll"));
  if (reason === "resize") window.dispatchEvent(new Event("resize"));
  host.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2, clientX: reason === "moved" ? 200 : 100, clientY: 100 }));
  expect(action.mock.calls).toEqual([]);
});
