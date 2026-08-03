import { describe, expect, it } from "vitest";
import { mailPreviewView, pushMailPreview, termViewRouter } from "./3_router";

describe("mail-preview view registration", () => {
  it("pushes one agent id's queue onto a terminal's stack and pops it", () => {
    const sid = "term-mail-1";
    pushMailPreview(sid, "lane-a");
    expect(termViewRouter.current(sid)).toEqual({ kind: "mail-preview", agentId: "lane-a" });
    expect(termViewRouter.canGoBack(sid)).toBe(true);
    expect(termViewRouter.back(sid)).toEqual(mailPreviewView("lane-a"));
    expect(termViewRouter.current(sid)).toBeNull();
  });

  it("stacks over an agent-session view without disturbing it", () => {
    const sid = "term-mail-2";
    termViewRouter.push(sid, { kind: "agent-session", agentSessionId: "sess-9" });
    pushMailPreview(sid, "lane-b");
    expect(termViewRouter.current(sid)?.kind).toBe("mail-preview");
    termViewRouter.back(sid);
    expect(termViewRouter.current(sid)).toEqual({ kind: "agent-session", agentSessionId: "sess-9" });
    termViewRouter.back(sid);
  });

  it("is the same instance the strips subscribe to", () => {
    const sid = "term-mail-3";
    let fired = 0;
    const unsub = termViewRouter.subscribe(() => (fired += 1));
    pushMailPreview(sid, "lane-c");
    expect(fired).toBe(1);
    termViewRouter.back(sid);
    unsub();
  });
});
