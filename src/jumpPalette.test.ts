import { describe, expect, it } from "vitest";
import { jumpLabel } from "./jumpPalette";

describe("jump palette labels", () => {
  it("shows a path under the pane cwd relative to it", () => {
    expect(jumpLabel("/Users/me/projects/a/labs/out/timeline.txt", "/Users/me/projects/a", "/Users/me")).toBe("labs/out/timeline.txt");
  });
  it("falls back to ~ for a path outside the cwd", () => {
    expect(jumpLabel("/Users/me/.agent/mail/forks/comment-26.md", "/Users/me/projects/a", "/Users/me")).toBe("~/.agent/mail/forks/comment-26.md");
  });
  it("leaves a foreign path whole", () => {
    expect(jumpLabel("/tmp/x.log", "/Users/me/projects/a", "/Users/me")).toBe("/tmp/x.log");
  });
});
