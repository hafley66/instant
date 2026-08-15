// Closing any dock tab detaches its PTY client. Explicit kill controls own
// tmux session termination.
import { describe, expect, it } from "vitest";
import { ViewerTabPolicy } from "./0_viewerTab";

describe("ViewerTabPolicy.closeAction", () => {
  it("a viewer tab running an agent detaches", () => {
    expect(ViewerTabPolicy.closeAction({ viewer: true, agent: true })).toBe("detach");
  });

  it("a viewer tab with no agent detaches", () => {
    expect(ViewerTabPolicy.closeAction({ viewer: true, agent: false })).toBe("detach");
  });

  it("the user's own agent tab detaches", () => {
    expect(ViewerTabPolicy.closeAction({ viewer: false, agent: true })).toBe("detach");
  });

  it("the user's own shell tab still detaches", () => {
    expect(ViewerTabPolicy.closeAction({ viewer: false, agent: false })).toBe("detach");
  });
});
