/** @vitest-environment jsdom */
// Regression for issues/kernel-wired-growth: app boot must not poll the boop
// session graph. c1daeb89 pinned the query at registerBuiltin, so the backend
// graph read (tmux/bash spawns) ran every 3 s for the app's lifetime.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.location = { search: "", hash: "" } as unknown as Location;
  globalThis.localStorage = storage as unknown as Storage;
  globalThis.sessionStorage = storage as unknown as Storage;
});

const calls = vi.hoisted(() => [] as string[]);

vi.mock("./reactive/nativeTransport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reactive/nativeTransport")>()),
  nativeRequestTransport: async (...args: unknown[]) => {
    calls.push(JSON.stringify(args));
    return { status: 200, body: null };
  },
  listenNativeEvent: () => new Promise(() => {}),
}));

describe("app boot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    calls.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("registers the builtin panels without reading the boop session graph", async () => {
    const { registerBuiltin } = await import("./panels");
    registerBuiltin();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.filter((call) => call.includes("boop_session_graph"))).toEqual([]);
  });
});
