import { describe, expect, it } from "vitest";
import { closedTabFate } from "./0_closedTabFate";

const base = {
  isViewer: false,
  isAgentProc: false,
  launchNamesAgent: false,
  proc: "",
  sessionListed: true,
  onDiskSessions: 0,
};

describe("closedTabFate", () => {
  it("kills a tab whose live foreground is an agent", () => {
    expect(closedTabFate({ ...base, isAgentProc: true, proc: "2.1.193" })).toBe("kill");
  });

  it("detaches an idle shell even when the cwd has old agent jsonl", () => {
    expect(closedTabFate({ ...base, onDiskSessions: 3 })).toBe("detach");
  });

  it("detaches an idle shell even when the tab was launched as claude", () => {
    expect(closedTabFate({ ...base, launchNamesAgent: true, onDiskSessions: 3 })).toBe("detach");
  });

  it("kills on launch command when the sessions poll had no row", () => {
    expect(closedTabFate({ ...base, sessionListed: false, launchNamesAgent: true })).toBe("kill");
  });

  it("falls back to the on-disk probe when the sessions poll had no row", () => {
    expect(closedTabFate({ ...base, sessionListed: false, onDiskSessions: 1 })).toBe("kill");
    expect(closedTabFate({ ...base, sessionListed: false, onDiskSessions: 0 })).toBe("detach");
  });

  it("detaches a known non-agent foreground", () => {
    expect(closedTabFate({ ...base, proc: "vim", onDiskSessions: 3 })).toBe("detach");
  });

  it("never kills a viewer tab", () => {
    expect(closedTabFate({ ...base, isViewer: true, isAgentProc: true, proc: "2.1.193" })).toBe(
      "detach",
    );
  });
});
