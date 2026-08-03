// Fail-first receipt: with the viewer branch removed, "a viewer tab running an
// agent detaches" fails with "kill" — that is the bug that killed two lanes on
// 2026-08-03 (closing the tab a strip row opened ran the agent-tab kill).
import { describe, expect, it } from "vitest";
import { ViewerTabPolicy } from "./0_viewerTab";

describe("ViewerTabPolicy.closeAction", () => {
  it("a viewer tab running an agent detaches", () => {
    expect(ViewerTabPolicy.closeAction({ viewer: true, agent: true })).toBe("detach");
  });

  it("a viewer tab with no agent detaches", () => {
    expect(ViewerTabPolicy.closeAction({ viewer: true, agent: false })).toBe("detach");
  });

  it("the user's own agent tab still kills", () => {
    expect(ViewerTabPolicy.closeAction({ viewer: false, agent: true })).toBe("kill");
  });

  it("the user's own shell tab still detaches", () => {
    expect(ViewerTabPolicy.closeAction({ viewer: false, agent: false })).toBe("detach");
  });
});
