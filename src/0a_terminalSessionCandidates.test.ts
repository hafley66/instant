import { describe, expect, it } from "vitest";
import { boundSessionFirst } from "./0a_terminalSessionCandidates";

describe("terminal session candidates", () => {
  it("reads the tab-bound session across cwd candidates before cwd-latest sessions", () => {
    expect(boundSessionFirst(
      [
        { editor: "claude", sessionId: "newest-sibling", cwd: "/repo/subdir" },
        { editor: "codex", sessionId: "other-harness", cwd: "/repo" },
      ],
      ["/repo/subdir", "/repo"],
      { editor: "claude", sessionId: "this-tab" },
    )).toMatchInlineSnapshot(`
      [
        {
          "cwd": "/repo/subdir",
          "editor": "claude",
          "sessionId": "this-tab",
        },
        {
          "cwd": "/repo",
          "editor": "claude",
          "sessionId": "this-tab",
        },
        {
          "cwd": "/repo/subdir",
          "editor": "claude",
          "sessionId": "newest-sibling",
        },
        {
          "cwd": "/repo",
          "editor": "codex",
          "sessionId": "other-harness",
        },
      ]
    `);
  });
});
