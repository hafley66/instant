/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { LineAnchorModel, TurnVisibilityEvent, VisibleTurn } from "@hafley66/boop-xterm";
import { Signal } from "@hafley66/signals";
vi.mock("./1a2_terminalContextGutter", () => ({ TerminalContextGutter: class { schedule() {} dispose() {} } }));
import { TerminalContextQueue } from "./1a_terminalContextQueue";

let queue: TerminalContextQueue;
afterEach(() => { queue?.dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); });
function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  queue = new TerminalContextQueue(
    { clearSelection: vi.fn() } as unknown as Terminal,
    host,
    { state: Signal({ visible: [] as VisibleTurn[] }), changes: Signal<TurnVisibilityEvent>() },
    {} as LineAnchorModel,
    vi.fn(),
    () => true,
  );
}

it("keeps the annotation caret and selected characters when stored rows hydrate", () => {
  mount();
  const id = queue.addSelection({ text: "first quote", turnIds: [], note: "explain this" })!;
  const note = queue.queue.querySelector("textarea")!;
  note.focus();
  note.setSelectionRange(2, 6, "backward");
  queue.hydrate([{ id: "stored", kind: "selection", text: "other quote", note: "other note", turnIds: [], enabled: true }]);
  const focused = document.activeElement as HTMLTextAreaElement;
  expect({ id: focused.closest<HTMLElement>("[data-context-id]")?.dataset.contextId === id,
    value: focused.value, start: focused.selectionStart, end: focused.selectionEnd,
    direction: focused.selectionDirection, quotes: [...queue.items.values()].map((item) => item.text) }).toMatchInlineSnapshot(`
    {
      "direction": "backward",
      "end": 6,
      "id": true,
      "quotes": [
        "first quote",
        "other quote",
      ],
      "start": 2,
      "value": "explain this",
    }
  `);
});

it("does not overwrite a retained quote when delete and add happen in the same millisecond", () => {
  mount();
  vi.spyOn(Date, "now").mockReturnValue(123);
  const first = queue.addSelection({ text: "first", turnIds: [] })!;
  queue.addSelection({ text: "keep", turnIds: [] });
  queue.items.delete(first);
  queue.addSelection({ text: "new", turnIds: [] });
  expect([...queue.items.values()].map(({ text }) => text)).toEqual(["keep", "new"]);
});
