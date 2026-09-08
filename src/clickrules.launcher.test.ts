import { describe, expect, it } from "vitest";
import { launcherOf } from "./0_clickLaunchers";

// A ⌘-click on a URL runs the `open $1` rule. The browser comes forward and
// `open` prints nothing; an empty results tab on top of that is the bug.
describe("launcherOf", () => {
  it("names the launcher a rule hands the token to", () => {
    expect(launcherOf("open $1")).toBe("open");
    expect(launcherOf("/usr/bin/open -a Safari $1")).toBe("open");
    expect(launcherOf("code -g $1")).toBe("code");
  });
  it("answers null for a command whose stdout is the answer", () => {
    expect(launcherOf("rg -n -F -e $1 .")).toBeNull();
    expect(launcherOf("test -e $1 && code -g $1 || rg -n $1")).toBeNull();
    expect(launcherOf("")).toBeNull();
  });
});
