import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import {
  asciinemaAvailability,
  parseTerminalCast,
  terminalCastReplay,
  terminalHarnesses,
} from "./0_terminalCast";

const availability = asciinemaAvailability();

describe("terminal asciicast and Boop replay fixtures", () => {
  it("keeps terminal input/output events synchronized with user and assistant turns", () => {
    const contracts = terminalHarnesses.map((harness) => {
      const replay = terminalCastReplay(harness);
      const cast = parseTerminalCast(replay.artifact);
      return {
        harness,
        artifact: basename(replay.artifact),
        executable: replay.executable,
        args: replay.args.slice(0, -1),
        readiness: replay.readiness,
        input: replay.input,
        header: cast.header,
        inputEvents: cast.inputEvents,
        output: cast.outputEvents.map((event) => event[2]).join("").replaceAll("\r", ""),
        turns: replay.turns,
      };
    });

    expect(contracts).toMatchInlineSnapshot(`
      [
        {
          "args": [
            "play",
            "--quiet",
            "--idle-time-limit",
            "0.25",
            "--speed",
            "1",
          ],
          "artifact": "codex-markdown.cast",
          "executable": "asciinema",
          "harness": "codex",
          "header": {
            "env": {
              "INSTANT_HARNESS": "codex",
              "SHELL": "/bin/sh",
              "TERM": "xterm-256color",
            },
            "height": 30,
            "title": "Instant Codex terminal transcript",
            "version": 2,
            "width": 100,
          },
          "input": "render the terminal flow",
          "inputEvents": [
            [
              0.1,
              "i",
              "render the terminal flow
      ",
            ],
          ],
          "output": "Codex ready
      › render the terminal flow
      Codex response:
      \`\`\`mermaid
      flowchart LR
        PTY --> tmux
        tmux --> xterm
        xterm --> Markdown
      \`\`\`
      ",
          "readiness": "Codex ready",
          "turns": [
            {
              "harness": "codex",
              "role": "user",
              "said": "render the terminal flow",
              "session": "e2e-codex-1",
              "ts": 1,
              "turn": 1,
            },
            {
              "harness": "codex",
              "role": "assistant",
              "said": "Codex response:
      \`\`\`mermaid
      flowchart LR
        PTY --> tmux
        tmux --> xterm
        xterm --> Markdown
      \`\`\`",
              "session": "e2e-codex-1",
              "ts": 2,
              "turn": 2,
            },
          ],
        },
        {
          "args": [
            "play",
            "--quiet",
            "--idle-time-limit",
            "0.25",
            "--speed",
            "1",
          ],
          "artifact": "claude-markdown.cast",
          "executable": "asciinema",
          "harness": "claude",
          "header": {
            "env": {
              "INSTANT_HARNESS": "claude",
              "SHELL": "/bin/sh",
              "TERM": "xterm-256color",
            },
            "height": 30,
            "title": "Instant Claude Code terminal transcript",
            "version": 2,
            "width": 100,
          },
          "input": "render the terminal flow",
          "inputEvents": [
            [
              0.1,
              "i",
              "render the terminal flow
      ",
            ],
          ],
          "output": "Claude Code ready
      ❯ render the terminal flow
      Claude Code response:
      \`\`\`mermaid
      flowchart LR
        PTY --> tmux
        tmux --> xterm
        xterm --> Markdown
      \`\`\`
      ",
          "readiness": "Claude Code ready",
          "turns": [
            {
              "harness": "claude",
              "role": "user",
              "said": "render the terminal flow",
              "session": "e2e-claude-1",
              "ts": 1,
              "turn": 1,
            },
            {
              "harness": "claude",
              "role": "assistant",
              "said": "Claude Code response:
      \`\`\`mermaid
      flowchart LR
        PTY --> tmux
        tmux --> xterm
        xterm --> Markdown
      \`\`\`",
              "session": "e2e-claude-1",
              "ts": 2,
              "turn": 2,
            },
          ],
        },
        {
          "args": [
            "play",
            "--quiet",
            "--idle-time-limit",
            "0.25",
            "--speed",
            "1",
          ],
          "artifact": "opencode-markdown.cast",
          "executable": "asciinema",
          "harness": "opencode",
          "header": {
            "env": {
              "INSTANT_HARNESS": "opencode",
              "SHELL": "/bin/sh",
              "TERM": "xterm-256color",
            },
            "height": 30,
            "title": "Instant OpenCode terminal transcript",
            "version": 2,
            "width": 100,
          },
          "input": "render the terminal flow",
          "inputEvents": [
            [
              0.1,
              "i",
              "render the terminal flow
      ",
            ],
          ],
          "output": "OpenCode ready
      › render the terminal flow
      OpenCode response:
      \`\`\`mermaid
      flowchart LR
        PTY --> tmux
        tmux --> xterm
        xterm --> Markdown
      \`\`\`
      ",
          "readiness": "OpenCode ready",
          "turns": [
            {
              "harness": "opencode",
              "role": "user",
              "said": "render the terminal flow",
              "session": "e2e-opencode-1",
              "ts": 1,
              "turn": 1,
            },
            {
              "harness": "opencode",
              "role": "assistant",
              "said": "OpenCode response:
      \`\`\`mermaid
      flowchart LR
        PTY --> tmux
        tmux --> xterm
        xterm --> Markdown
      \`\`\`",
              "session": "e2e-opencode-1",
              "ts": 2,
              "turn": 2,
            },
          ],
        },
      ]
    `);
    for (const contract of contracts) {
      expect(contract.inputEvents.map((event) => event[2].trim())).toEqual([contract.turns[0].said]);
      expect(contract.output).toContain(contract.turns[0].said);
      expect(contract.output).toContain(contract.turns[1].said);
    }
  });

  it.skipIf(!availability.available)("reports the installed asciinema executable used by the replay contract", () => {
    expect(availability).toEqual({
      available: true,
      command: "asciinema",
      detail: expect.stringMatching(/^asciinema \d+\.\d+\.\d+$/),
      version: expect.stringMatching(/^asciinema \d+\.\d+\.\d+$/),
    });
  });
});
