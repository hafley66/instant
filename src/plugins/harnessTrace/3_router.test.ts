import { describe, expect, it } from "vitest";
import { TermRouter } from "./3_router";

function agentView(id: string) {
  return { kind: "agent-session" as const, agentSessionId: id };
}

describe("TermRouter", () => {
  it("push/push/back/back walks the stack in order and empties to null", () => {
    const router = new TermRouter();
    router.push("s1", agentView("a"));
    router.push("s1", agentView("b"));
    expect(router.current("s1")?.agentSessionId).toBe("b");
    expect(router.canGoBack("s1")).toBe(true);
    expect(router.back("s1")?.agentSessionId).toBe("b");
    expect(router.current("s1")?.agentSessionId).toBe("a");
    expect(router.back("s1")?.agentSessionId).toBe("a");
    expect(router.current("s1")).toBeNull();
    expect(router.canGoBack("s1")).toBe(false);
    expect(router.back("s1")).toBeNull();
    expect(router.back("s1")).toBeNull();
  });

  it("keeps per-sid stacks isolated", () => {
    const router = new TermRouter();
    router.push("s1", agentView("a"));
    router.push("s2", agentView("x"));
    expect(router.current("s1")?.agentSessionId).toBe("a");
    expect(router.current("s2")?.agentSessionId).toBe("x");
    expect(router.canGoBack("s2")).toBe(true);
    router.back("s2");
    expect(router.current("s1")?.agentSessionId).toBe("a");
    expect(router.current("s2")).toBeNull();
    expect(router.back("s1")?.agentSessionId).toBe("a");
  });

  it("back on an empty stack returns null and canGoBack is false", () => {
    const router = new TermRouter();
    expect(router.canGoBack("fresh")).toBe(false);
    expect(router.current("fresh")).toBeNull();
    expect(router.back("fresh")).toBeNull();
  });

  it("subscribe fires on push and back and stops after unsubscribe", () => {
    const router = new TermRouter();
    let calls = 0;
    const unsub = router.subscribe(() => calls++);
    router.push("s1", agentView("a"));
    expect(calls).toBe(1);
    router.back("s1");
    expect(calls).toBe(2);
    unsub();
    router.push("s1", agentView("b"));
    expect(calls).toBe(2);
  });
});
