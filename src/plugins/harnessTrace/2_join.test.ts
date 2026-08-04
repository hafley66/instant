import { describe, expect, it } from "vitest";
import {
  assignTmuxPanes,
  joinTmuxSessions,
  procHarness,
  type JoinTmuxRow,
  type PaneClaimant,
} from "./2_join";

function tmux(partial: Partial<JoinTmuxRow> & { name: string }): JoinTmuxRow {
  return { pwd: "", chipPaths: [], proc: "", ...partial };
}

function claimant(partial: Partial<PaneClaimant> & { id: string }): PaneClaimant {
  return {
    harness: "claude",
    cwd: "/Users/x/projects/app",
    lastActivity: "",
    routedTmux: null,
    going: true,
    ...partial,
  };
}

describe("procHarness", () => {
  it("names the harness binaries, path-qualified or bare", () => {
    expect(procHarness("claude")).toBe("claude");
    expect(procHarness("/usr/local/bin/opencode")).toBe("opencode");
    expect(procHarness("codex")).toBe("codex");
  });

  it("reads a bare version string as the claude TUI", () => {
    expect(procHarness("2.1.221")).toBe("claude");
    expect(procHarness("2.1.217")).toBe("claude");
  });

  it("returns null for shells and empty procs", () => {
    expect(procHarness("zsh")).toBeNull();
    expect(procHarness("bash")).toBeNull();
    expect(procHarness("")).toBeNull();
  });
});

describe("assignTmuxPanes", () => {
  const app = "/Users/x/projects/app";

  it("never hands a claude session a codex pane", () => {
    const rows = [
      tmux({ name: "guard", pwd: app, proc: "codex" }),
      tmux({ name: "work", pwd: app, proc: "2.1.220" }),
    ];
    const out = assignTmuxPanes(
      [claimant({ id: "c1" }), claimant({ id: "x1", harness: "codex" })],
      rows,
    );
    expect(out.get("c1")).toBe("work");
    expect(out.get("x1")).toBe("guard");
  });

  it("assigns same-cwd sessions distinct panes, newest activity first", () => {
    const rows = [
      tmux({ name: "s1", pwd: app, proc: "2.1.217" }),
      tmux({ name: "s2", pwd: app, proc: "2.1.220" }),
    ];
    const out = assignTmuxPanes(
      [
        claimant({ id: "older", lastActivity: "2026-08-04T17:53:00Z" }),
        claimant({ id: "newer", lastActivity: "2026-08-04T18:01:00Z" }),
      ],
      rows,
    );
    expect(out.get("newer")).toBe("s1");
    expect(out.get("older")).toBe("s2");
  });

  it("leaves a session pane-less when every match is claimed", () => {
    const rows = [tmux({ name: "s1", pwd: app, proc: "claude" })];
    const out = assignTmuxPanes(
      [
        claimant({ id: "winner", lastActivity: "2026-08-04T18:01:00Z" }),
        claimant({ id: "loser", lastActivity: "2026-08-04T17:00:00Z" }),
      ],
      rows,
    );
    expect(out.get("winner")).toBe("s1");
    expect(out.get("loser")).toBeNull();
  });

  it("falls back to a plain-shell pane only when no harness pane is free", () => {
    const rows = [
      tmux({ name: "sh", pwd: app, proc: "bash" }),
      tmux({ name: "hz", pwd: app, proc: "claude" }),
    ];
    const out = assignTmuxPanes(
      [
        claimant({ id: "first", lastActivity: "2026-08-04T18:01:00Z" }),
        claimant({ id: "second", lastActivity: "2026-08-04T17:00:00Z" }),
      ],
      rows,
    );
    expect(out.get("first")).toBe("hz");
    expect(out.get("second")).toBe("sh");
  });

  it("a routed going session pins and claims its recorded name", () => {
    const rows = [
      tmux({ name: "s1", pwd: app, proc: "claude" }),
      tmux({ name: "s2", pwd: app, proc: "claude" }),
    ];
    const out = assignTmuxPanes(
      [claimant({ id: "lane", routedTmux: "s1" }), claimant({ id: "walkin" })],
      rows,
    );
    expect(out.get("lane")).toBe("s1");
    expect(out.get("walkin")).toBe("s2");
  });

  it("a stale route on a done session neither claims nor blocks the live one", () => {
    const rows = [tmux({ name: "s3", pwd: app, proc: "2.1.220" })];
    const out = assignTmuxPanes(
      [claimant({ id: "stale", routedTmux: "s3", going: false }), claimant({ id: "live" })],
      rows,
    );
    expect(out.get("live")).toBe("s3");
    expect(out.get("stale")).toBe("s3");
  });

  it("non-going sessions get a display match without claiming", () => {
    const rows = [tmux({ name: "s1", pwd: app, proc: "claude" })];
    const out = assignTmuxPanes(
      [claimant({ id: "done", going: false }), claimant({ id: "live" })],
      rows,
    );
    expect(out.get("live")).toBe("s1");
    expect(out.get("done")).toBe("s1");
  });

  it("matches by chip path and returns null on no match or empty cwd", () => {
    const rows = [
      tmux({ name: "s2", pwd: "/Users/x/projects/other", chipPaths: [app], proc: "claude" }),
      tmux({ name: "blank", pwd: "" }),
    ];
    const out = assignTmuxPanes(
      [claimant({ id: "chip" }), claimant({ id: "lost", cwd: "/nowhere" }), claimant({ id: "bare", cwd: "" })],
      rows,
    );
    expect(out.get("chip")).toBe("s2");
    expect(out.get("lost")).toBeNull();
    expect(out.get("bare")).toBeNull();
  });
});

describe("joinTmuxSessions", () => {
  it("returns every matching row name in row order for a shared pwd", () => {
    const rows = [
      tmux({ name: "demo", pwd: "/Users/x/projects/app", proc: "claude" }),
      tmux({ name: "demo-3", pwd: "/Users/x/projects/app", proc: "claude" }),
    ];
    expect(joinTmuxSessions("/Users/x/projects/app", rows)).toEqual(["demo", "demo-3"]);
  });

  it("returns empty when nothing matches or the cwd is empty", () => {
    const rows = [tmux({ name: "demo", pwd: "/elsewhere", proc: "claude" })];
    expect(joinTmuxSessions("/Users/x/projects/app", rows)).toEqual([]);
    expect(joinTmuxSessions("", rows)).toEqual([]);
  });
});
