/** @vitest-environment jsdom */
// The note prompt's suggestion list: askText with `suggestions` renders the
// palette's own `.cmdp-list` / `.cmdp-item` rows under the input, so an existing
// tag is picked instead of retyped, and free text still commits.
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
// Resolves to a sentinel when the prompt is still open after a turn of the loop.
const PENDING = Symbol("pending");
function settled<T>(p: Promise<T>) {
  return Promise.race([p, Promise.resolve(PENDING)]);
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("askText suggestions", () => {
  it("renders one row per suggestion", async () => {
    const done = askText("note", "", { suggestions: TAGS });
    expect(items()).toEqual(TAGS);
    press("Escape");
    await done;
  });

  it("fuzzy-filters the rows by what is typed", async () => {
    const done = askText("note", "", { suggestions: TAGS });
    type("ru");
    expect(items()).toContain("rust");
    expect(items()).not.toContain("docs");
    press("Escape");
    await done;
  });

  it("caps the empty-query rows at the limit", async () => {
    const done = askText("note", "", { suggestions: TAGS, limit: 2 });
    expect(items()).toEqual(["rust", "review"]);
    press("Escape");
    await done;
  });

  it("ArrowDown then Enter resolves the highlighted row", async () => {
    const done = askText("note", "", { suggestions: TAGS });
    press("ArrowDown");
    expect(document.querySelectorAll(".cmdp-active")).toHaveLength(1);
    press("Enter");
    expect(await done).toBe("rust");
    expect(box()).toBeNull();
  });

  it("Enter with nothing highlighted commits the typed text", async () => {
    const done = askText("note", "", { suggestions: TAGS });
    type("new tag");
    press("Enter");
    expect(await done).toBe("new tag");
  });

  it("Tab fills the input from the highlighted row without committing", async () => {
    const done = askText("note", "", { suggestions: TAGS });
    press("ArrowDown");
    press("Tab");
    expect(input().value).toBe("rust");
    expect(await settled(done)).toBe(PENDING);
    press("Escape");
    await done;
  });

  it("a click on a row resolves that row", async () => {
    const done = askText("note", "", { suggestions: TAGS });
    (document.querySelectorAll(".cmdp-item")[1] as HTMLElement).click();
    expect(await done).toBe("review");
  });

  it("Escape still resolves null", async () => {
    const done = askText("note", "", { suggestions: TAGS });
    press("Escape");
    expect(await done).toBeNull();
  });

  it("renders no list when no suggestions are passed", async () => {
    const done = askText("note");
    expect(document.querySelector(".cmdp-list")).toBeNull();
    type("plain");
    press("Enter");
    expect(await done).toBe("plain");
  });
});
