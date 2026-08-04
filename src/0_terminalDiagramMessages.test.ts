import { describe, expect, it } from "vitest";
import type { AiMessage } from "./state";
import { diagramsFromMessageTail, normalizedDiagramLines } from "./0_terminalDiagramMessages";

const message = (id: string, role: string, text: string): AiMessage => ({
  editor: "codex",
  session_id: "session-1",
  id,
  seq: Number(id.slice(1)),
  role,
  ts: 0,
  preview: text.slice(0, 20),
  text,
  locator: id,
});

describe("terminal message diagrams", () => {
  it("extracts fenced diagrams only from the assistant message tail", () => {
    const messages = [
      message("m1", "user", "```mermaid\ngraph LR\nA --> B\n```"),
      message("m2", "assistant", "before\n```d2\na -> b\n```\nafter"),
      message("m3", "assistant", "```mermaid\nflowchart LR\nPTY --> tmux\n```"),
    ];

    expect(diagramsFromMessageTail(messages)).toMatchInlineSnapshot(`
      [
        {
          "code": "a -> b",
          "language": "d2",
          "messageId": "m2",
        },
        {
          "code": "flowchart LR
      PTY --> tmux",
          "language": "mermaid",
          "messageId": "m3",
        },
      ]
    `);
    expect(normalizedDiagramLines("  flowchart LR\n  • PTY --> tmux\n")).toEqual([
      "flowchart lr",
      "pty --> tmux",
    ]);
  });
});
