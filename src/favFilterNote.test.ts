// Favorites panel search reads the note, so a tag typed at ★ time finds the row.
import { describe, expect, it, vi } from "vitest";

// tablepanels pulls the store in through useStore; the predicate needs neither.
vi.mock("./useStore", () => ({ useApp: () => {} }));

const { favFilter } = await import("./tablepanels");
import type { FavTreeRow } from "./tablepanels";

const row: FavTreeRow = {
  id: "boop-favorite:1",
  kind: "turn",
  editor: "boop",
  label: "turn:sess-a:3",
  starredAt: 0,
  role: "turn",
  preview: "some body text",
  note: "rust",
};

describe("favFilter", () => {
  it("matches a favorite by its note", () => {
    expect(favFilter(row, "rus")).toBe(true);
  });

  it("still misses a query in neither label, preview nor note", () => {
    expect(favFilter(row, "zzz")).toBe(false);
  });

  it("leaves a note-less row on the other fields", () => {
    expect(favFilter({ ...row, note: undefined }, "body")).toBe(true);
    expect(favFilter({ ...row, note: undefined }, "rust")).toBe(false);
  });
});
