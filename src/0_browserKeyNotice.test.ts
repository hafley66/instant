import { describe, it, expect } from "vitest";
import { browserKeyNotices, comboLabel, reservedNotice, type NoticeStore } from "./0_browserKeyNotice";
import type { Command } from "./keymap";

const noop = () => {};
const commands: Command[] = [
  { id: "palette.open", keys: ["$mod+Shift+p"], title: "Show All Commands", run: noop },
  { id: "tab.close", keys: ["$mod+w"], title: "Close Tab", run: noop },
  { id: "tab.open", keys: ["$mod+t"], title: "New Tab at Current Directory", run: noop },
  { id: "tab.reopen", keys: ["$mod+Shift+t"], title: "Reopen Closed Tab", run: noop },
  { id: "app.reload", keys: ["$mod+r"], title: "Reload Window", run: noop },
  { id: "app.zoomIn", keys: ["$mod+Equal", "$mod+Shift+Equal"], title: "Zoom In", run: noop },
  { id: "tab.goto2", keys: ["$mod+2"], run: noop },
  { id: "term.sidebar", keys: ["$mod+Shift+Backslash"], title: "Toggle Session Sidebar", run: noop },
];
const byId = (id: string) => commands.find((c) => c.id === id)!;

function mapStore(): NoticeStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

function run(store: NoticeStore, mac = true) {
  const flashed: [string, number | undefined][] = [];
  const n = browserKeyNotices(commands, (msg, ms) => flashed.push([msg, ms]), store, mac);
  return { n, flashed };
}

describe("browser key notices", () => {
  it("labels combos for mac and elsewhere", () => {
    const keys = ["$mod+r", "$mod+Shift+t", "$mod+Shift+BracketRight", "$mod+Digit0", "$mod+Equal", "$mod+Shift+Backslash", "Control+Shift+Tab", "$mod+2"];
    expect(keys.map((k) => [comboLabel(k, true), comboLabel(k, false)])).toMatchInlineSnapshot(`
      [
        [
          "⌘R",
          "Ctrl+R",
        ],
        [
          "⌘⇧T",
          "Ctrl+Shift+T",
        ],
        [
          "⌘⇧]",
          "Ctrl+Shift+]",
        ],
        [
          "⌘0",
          "Ctrl+0",
        ],
        [
          "⌘=",
          "Ctrl+=",
        ],
        [
          "⌘⇧\\",
          "Ctrl+Shift+\\",
        ],
        [
          "⌃⇧Tab",
          "Ctrl+Shift+Tab",
        ],
        [
          "⌘2",
          "Ctrl+2",
        ],
      ]
    `);
  });

  it("flashes each overridden browser default once per session and skips combos without one", () => {
    const store = mapStore();
    const { n, flashed } = run(store);
    n.onFire(byId("app.reload"), "$mod+r");
    n.onFire(byId("app.reload"), "$mod+r");
    n.onFire(byId("app.zoomIn"), "$mod+Equal");
    n.onFire(byId("app.zoomIn"), "$mod+Shift+Equal");
    n.onFire(byId("tab.goto2"), "$mod+2");
    n.onFire(byId("term.sidebar"), "$mod+Shift+Backslash");
    // A reload in the same session reads the seen set back.
    const again = run(store);
    again.n.onFire(byId("app.reload"), "$mod+r");
    again.n.onFire(byId("tab.goto2"), "$mod+2");
    expect({ flashed, again: again.flashed, stored: [...store.data] }).toMatchInlineSnapshot(`
      {
        "again": [],
        "flashed": [
          [
            "⌘R → instant: Reload Window (browser reload overridden)",
            undefined,
          ],
          [
            "⌘= → instant: Zoom In (browser zoom in overridden)",
            undefined,
          ],
          [
            "⌘⇧= → instant: Zoom In (browser zoom in overridden)",
            undefined,
          ],
          [
            "⌘2 → instant: tab.goto2 (browser tab 2 overridden)",
            undefined,
          ],
        ],
        "stored": [
          [
            "instant.browserKeyNotices",
            "["$mod+r","$mod+equal","$mod+shift+equal","$mod+2"]",
          ],
        ],
      }
    `);
  });

  it("lists bound browser-reserved combos once at startup and names the palette", () => {
    const store = mapStore();
    const { n, flashed } = run(store);
    n.startup();
    n.startup();
    run(store).n.startup();
    const pc = run(mapStore(), false);
    pc.n.startup();
    expect({ mac: flashed, pc: pc.flashed }).toMatchInlineSnapshot(`
      {
        "mac": [
          [
            "The browser keeps ⌘W (Close Tab), ⌘T (New Tab at Current Directory), ⌘⇧T (Reopen Closed Tab) for itself — run them from the palette (⌘⇧P)",
            8000,
          ],
        ],
        "pc": [
          [
            "The browser keeps Ctrl+W (Close Tab), Ctrl+T (New Tab at Current Directory), Ctrl+Shift+T (Reopen Closed Tab) for itself — run them from the palette (Ctrl+Shift+P)",
            8000,
          ],
        ],
      }
    `);
  });

  it("stays silent when no reserved combo is bound", () => {
    expect(reservedNotice([byId("app.reload")], true)).toMatchInlineSnapshot(`null`);
  });
});
