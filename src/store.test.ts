import { describe, it, expect, vi } from "vitest";
import { createStore } from "./store";

// A type alias, not an interface: the signal's nested field access is typed via
// an implicit index signature, which interfaces do not get.
type TestState = {
  a: number;
  b: string;
  c: boolean;
};

describe("createStore", () => {
  it("get() returns the initial state", () => {
    const store = createStore<TestState>({ a: 1, b: "x", c: false });
    expect(store.get()).toEqual({ a: 1, b: "x", c: false });
  });

  it("set() shallow-merges a patch", () => {
    const store = createStore<TestState>({ a: 1, b: "x", c: false });
    store.set({ a: 2 });
    expect(store.get()).toEqual({ a: 2, b: "x", c: false });
  });

  it("subscribe() with no keys fires on any changed field", () => {
    const store = createStore<TestState>({ a: 1, b: "x", c: false });
    const fn = vi.fn();
    store.subscribe(fn);
    store.set({ b: "y" });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ a: 1, b: "y", c: false });
  });

  it("subscribe() with keys only fires when one of those keys changed", () => {
    const store = createStore<TestState>({ a: 1, b: "x", c: false });
    const fn = vi.fn();
    store.subscribe(fn, ["a"]);
    store.set({ b: "y" }); // not in keys -> no notification
    expect(fn).not.toHaveBeenCalled();
    store.set({ a: 5 }); // in keys -> notified
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not notify when the patch value is unchanged (same reference)", () => {
    const store = createStore<TestState>({ a: 1, b: "x", c: false });
    const fn = vi.fn();
    store.subscribe(fn);
    store.set({ a: 1 }); // identical value
    expect(fn).not.toHaveBeenCalled();
  });

  it("notifies once per set() even when multiple keys change", () => {
    const store = createStore<TestState>({ a: 1, b: "x", c: false });
    const fn = vi.fn();
    store.subscribe(fn);
    store.set({ a: 2, b: "z" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops further notifications", () => {
    const store = createStore<TestState>({ a: 1, b: "x", c: false });
    const fn = vi.fn();
    const unsubscribe = store.subscribe(fn);
    unsubscribe();
    store.set({ a: 2 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("supports multiple independent subscribers", () => {
    const store = createStore<TestState>({ a: 1, b: "x", c: false });
    const all = vi.fn();
    const aOnly = vi.fn();
    store.subscribe(all);
    store.subscribe(aOnly, ["a"]);
    store.set({ b: "y" });
    expect(all).toHaveBeenCalledTimes(1);
    expect(aOnly).not.toHaveBeenCalled();
  });
});

describe("createStore signal access", () => {
  it("$ exposes each field as its own signal", () => {
    const store = createStore<TestState>({ a: 1, b: "x", c: false });
    expect(store.$.a.$()).toBe(1);
    store.set({ a: 7 });
    expect(store.$.a.$()).toBe(7);
  });

  it("changed$ emits only the keys whose value actually changed", () => {
    const store = createStore<TestState>({ a: 1, b: "x", c: false });
    const seen: (keyof TestState)[][] = [];
    store.changed$.subscribe((keys) => seen.push(keys));
    store.set({ a: 2, b: "x" }); // b is identical, so only a is dirty
    store.set({ b: "z", c: true });
    expect(seen).toEqual([["a"], ["b", "c"]]);
  });

  it("changed$ stays silent when nothing changed", () => {
    const store = createStore<TestState>({ a: 1, b: "x", c: false });
    const fn = vi.fn();
    store.changed$.subscribe(fn);
    store.set({ a: 1 });
    expect(fn).not.toHaveBeenCalled();
  });
});
