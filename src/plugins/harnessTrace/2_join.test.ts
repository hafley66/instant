import { describe, expect, it } from "vitest";
import { joinTmuxSession, joinTmuxSessions, type JoinTmuxRow } from "./2_join";

function tmux(partial: Partial<JoinTmuxRow> & { name: string }): JoinTmuxRow {
  return { pwd: "", chipPaths: [], proc: "", ...partial };
}

describe("joinTmuxSession", () => {
  it("joins by the untildified pwd match", () => {
    const rows = [tmux({ name: "s-1", pwd: "/Users/x/projects/app", proc: "zsh" })];
    expect(joinTmuxSession("/Users/x/projects/app", rows)).toBe("s-1");
  });

  it("joins by a chip path match when pwd differs", () => {
    const rows = [
      tmux({
        name: "s-2",
        pwd: "/Users/x/projects/other",
        chipPaths: ["/Users/x/projects/app"],
        proc: "zsh",
      }),
    ];
    expect(joinTmuxSession("/Users/x/projects/app", rows)).toBe("s-2");
  });

  it("prefers the row whose proc names the harness binary over a plain-shell match", () => {
    const rows = [
      tmux({ name: "s-sh", pwd: "/Users/x/projects/app", proc: "zsh" }),
      tmux({ name: "s-claude", pwd: "/Users/x/projects/app", proc: "claude" }),
    ];
    expect(joinTmuxSession("/Users/x/projects/app", rows)).toBe("s-claude");
  });

  it("names a path-qualified harness binary too", () => {
    const rows = [
      tmux({ name: "s-sh", pwd: "/Users/x/projects/app", proc: "zsh" }),
      tmux({ name: "s-oc", pwd: "/Users/x/projects/app", proc: "/usr/local/bin/opencode" }),
    ];
    expect(joinTmuxSession("/Users/x/projects/app", rows)).toBe("s-oc");
  });

  it("returns null on no match", () => {
    const rows = [tmux({ name: "s-1", pwd: "/elsewhere", proc: "claude" })];
    expect(joinTmuxSession("/Users/x/projects/app", rows)).toBeNull();
  });

  it("returns null for an empty cwd", () => {
    expect(joinTmuxSession("", [tmux({ name: "s-1", pwd: "/Users/x/projects/app" })])).toBeNull();
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

  it("keep the single-guess tiebreak on joinTmuxSession for display", () => {
    const rows = [
      tmux({ name: "demo", pwd: "/Users/x/projects/app", proc: "zsh" }),
      tmux({ name: "demo-3", pwd: "/Users/x/projects/app", proc: "claude" }),
    ];
    expect(joinTmuxSessions("/Users/x/projects/app", rows)).toEqual(["demo", "demo-3"]);
    expect(joinTmuxSession("/Users/x/projects/app", rows)).toBe("demo-3");
  });
});
