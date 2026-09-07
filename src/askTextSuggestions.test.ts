/** @vitest-environment jsdom */
// The tag prompt's row list: askText with `suggest` asks the source for the
// typed fragment and paints the answer as the palette's own `.cmdp-item` rows,
// and with `multi` a picked row lands in the input instead of closing the box.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./state", () => ({ store: { get: () => ({}), set: vi.fn(), sub: vi.fn() } }));
vi.mock("./reactdock", () => ({ activeGroupEl: () => null }));
vi.mock("./generated/native", () => ({ invoke: vi.fn() }));
vi.mock("./0_terminalFonts", () => ({ terminalFontCss: () => "" }));
vi.mock("./0_settings", () => ({ settings: { active: { $: () => null } } }));

const { askText } = await import("./core");

const TAGS = ["rust", "review", "docs"];

function box() {
  return document.querySelector(".cmdp-root") as HTMLElement;
}
function input() {
  return document.querySelector(".cmdp-input") as HTMLInputElement;
}
function items(): string[] {
  return [...document.querySelectorAll(".cmdp-item")].map((el) => el.textContent ?? "");
}
function press(key: string) {
  input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}
function type(text: string) {
  input().value = text;
  input().dispatchEvent(new Event("input", { bubbles: true }));
}
// A suggest read is a promise chain, so let the microtasks run before reading rows.
const tick = () => new Promise((done) => setTimeout(done, 0));
// Resolves to a sentinel when the prompt is still open after a turn of the loop.
const PENDING = Symbol("pending");
function settled<T>(p: Promise<T>) {
  return Promise.race([p, Promise.resolve(PENDING)]);
}

const suggest = vi.fn<(query: string) => Promise<string[]>>();

beforeEach(() => {
  document.body.replaceChildren();
  suggest.mockReset();
  suggest.mockResolvedValue(TAGS);
});

describe("askText suggest", () => {
  it("asks the source with an empty query on open", async () => {
    const done = askText("tags", "", { suggest });
    await tick();
    expect(suggest).toHaveBeenCalledWith("");
    expect(items()).toEqual(TAGS);
    press("Escape");
    await done;
  });

  it("asks again with what is typed and replaces the rows", async () => {
    const done = askText("tags", "", { suggest });
    await tick();
    suggest.mockResolvedValue(["rust"]);
    type("ru");
    await tick();
    expect(suggest).toHaveBeenLastCalledWith("ru");
    expect(items()).toEqual(["rust"]);
    press("Escape");
    await done;
  });

  it("asks with the last comma-separated fragment, not the whole input", async () => {
    const done = askText("tags", "", { suggest, multi: true });
    await tick();
    type("perf, ru");
    await tick();
    expect(suggest).toHaveBeenLastCalledWith("ru");
    press("Escape");
    await done;
  });

  it("drops a slow earlier answer when a later one landed first", async () => {
    let releaseFirst = (_rows: string[]) => {};
    suggest.mockReturnValueOnce(new Promise((resolve) => { releaseFirst = resolve; }));
    const done = askText("tags", "", { suggest });
    suggest.mockResolvedValue(["second"]);
    type("s");
    await tick();
    releaseFirst(["first"]);
    await tick();
    expect(items()).toEqual(["second"]);
    press("Escape");
    await done;
  });

  it("caps the rows at the limit", async () => {
    const done = askText("tags", "", { suggest, limit: 2 });
    await tick();
    expect(items()).toEqual(["rust", "review"]);
    press("Escape");
    await done;
  });

  it("multi: Tab appends the row and keeps the prompt open", async () => {
    const done = askText("tags", "", { suggest, multi: true });
    await tick();
    type("perf");
    await tick();
    press("ArrowDown");
    press("Tab");
    expect(input().value).toBe("perf, rust, ");
    expect(await settled(done)).toBe(PENDING);
    press("Escape");
    await done;
  });

  it("multi: Enter on a row appends it and commits without the trailing separator", async () => {
    const done = askText("tags", "", { suggest, multi: true });
    await tick();
    type("perf, ");
    await tick();
    press("ArrowDown");
    press("Enter");
    expect(await done).toBe("perf, rust");
  });

  it("multi: Enter with no row commits the whole text", async () => {
    const done = askText("tags", "", { suggest, multi: true });
    await tick();
    type("perf, rust, ");
    await tick();
    press("Enter");
    expect(await done).toBe("perf, rust");
  });

  it("single: ArrowDown then Enter resolves the highlighted row", async () => {
    const done = askText("tags", "", { suggest });
    await tick();
    press("ArrowDown");
    expect(document.querySelectorAll(".cmdp-active")).toHaveLength(1);
    press("Enter");
    expect(await done).toBe("rust");
    expect(box()).toBeNull();
  });

  it("single: a click on a row resolves that row", async () => {
    const done = askText("tags", "", { suggest });
    await tick();
    (document.querySelectorAll(".cmdp-item")[1] as HTMLElement).click();
    expect(await done).toBe("review");
  });

  it("Escape still resolves null", async () => {
    const done = askText("tags", "", { suggest });
    await tick();
    press("Escape");
    expect(await done).toBeNull();
  });

  it("renders no list and asks nothing when no source is passed", async () => {
    const done = askText("note");
    expect(document.querySelector(".cmdp-list")).toBeNull();
    expect(suggest).not.toHaveBeenCalled();
    type("plain");
    press("Enter");
    expect(await done).toBe("plain");
  });
});
