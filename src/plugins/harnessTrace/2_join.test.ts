import { describe, expect, it } from "vitest";
import { joinTmuxSession, type JoinTmuxRow } from "./2_join";

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
