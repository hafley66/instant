import { describe, it, expect } from "vitest";
import { mergeOrder, visibleIds, resolveRailIds, moveBefore, toggleHidden } from "./railOrder";

describe("railOrder.ts pure functions", () => {
  describe("mergeOrder", () => {
    it("keeps the saved order for still-registered ids", () => {
      expect(mergeOrder(["b", "a"], ["a", "b"])).toEqual(["b", "a"]);
    });

    it("appends newly-registered ids in registration order, at the end", () => {
      expect(mergeOrder(["b", "a"], ["a", "b", "c", "d"])).toEqual(["b", "a", "c", "d"]);
    });

    it("drops saved ids that are no longer registered", () => {
      expect(mergeOrder(["b", "gone", "a"], ["a", "b"])).toEqual(["b", "a"]);
    });

    it("returns registration order untouched when no order was ever saved", () => {
      expect(mergeOrder([], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    });

    it("handles an empty registry", () => {
      expect(mergeOrder(["a", "b"], [])).toEqual([]);
    });
  });

  describe("visibleIds", () => {
    it("drops hidden ids, preserving order of the rest", () => {
      expect(visibleIds(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
    });

    it("is a no-op when nothing is hidden", () => {
      expect(visibleIds(["a", "b"], [])).toEqual(["a", "b"]);
    });

    it("ignores hidden ids that aren't present in order", () => {
      expect(visibleIds(["a", "b"], ["nonexistent"])).toEqual(["a", "b"]);
    });

    it("can hide everything", () => {
      expect(visibleIds(["a", "b"], ["a", "b"])).toEqual([]);
    });
  });

  describe("resolveRailIds", () => {
    it("merges then filters hidden, new panels included unless hidden", () => {
      const state = { order: ["b", "a"], hidden: ["a"] };
      expect(resolveRailIds(["a", "b", "c"], state)).toEqual(["b", "c"]);
    });

    it("a stale hidden id (no longer registered) has no effect", () => {
      const state = { order: ["a"], hidden: ["gone"] };
      expect(resolveRailIds(["a", "b"], state)).toEqual(["a", "b"]);
    });

    it("default empty state falls back to plain registration order", () => {
      expect(resolveRailIds(["a", "b"], { order: [], hidden: [] })).toEqual(["a", "b"]);
    });
  });

  describe("moveBefore", () => {
    it("moves an id to sit at another id's position", () => {
      expect(moveBefore(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"]);
    });

    it("moving forward (later index) works the same way", () => {
      expect(moveBefore(["a", "b", "c", "d"], "a", "c")).toEqual(["b", "a", "c", "d"]);
    });

    it("is a no-op when dragId === overId", () => {
      expect(moveBefore(["a", "b", "c"], "b", "b")).toEqual(["a", "b", "c"]);
    });

    it("is a no-op when dragId is missing", () => {
      expect(moveBefore(["a", "b"], "ghost", "a")).toEqual(["a", "b"]);
    });

    it("is a no-op when overId is missing", () => {
      expect(moveBefore(["a", "b"], "a", "ghost")).toEqual(["a", "b"]);
    });
  });

  describe("toggleHidden", () => {
    it("adds an id that isn't hidden yet", () => {
      expect(toggleHidden(["a"], "b")).toEqual(["a", "b"]);
    });

    it("removes an id that's already hidden", () => {
      expect(toggleHidden(["a", "b"], "a")).toEqual(["b"]);
    });

    it("starting from empty hides the id", () => {
      expect(toggleHidden([], "a")).toEqual(["a"]);
    });
  });
});
