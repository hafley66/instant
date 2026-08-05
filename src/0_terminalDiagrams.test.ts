import { describe, expect, it } from "vitest";
import { diagramElementKey, mergeLocatedDiagrams, svgAspectRatio, type DiagramFence } from "./0_terminalDiagrams";

describe("svgAspectRatio", () => {
  it("reads SVG dimensions and rejects missing renderer output", () => {
    expect([
      svgAspectRatio('<svg viewBox="0 0 640 320"></svg>'),
      svgAspectRatio('<svg width="300" height="600"></svg>'),
      svgAspectRatio(undefined),
      svgAspectRatio(Promise.resolve("<svg></svg>")),
      svgAspectRatio("<svg></svg>"),
    ]).toMatchInlineSnapshot(`
      [
        2,
        0.5,
        null,
        null,
        null,
      ]
    `);
  });
});

describe("diagram location precedence", () => {
  it("keeps visible terminal source over an overlapping stale ledger estimate", () => {
    const direct: DiagramFence = {
      language: "mermaid",
      code: "flowchart LR\n1 --> 2 --> 3",
      start: 20,
      end: 21,
      inferred: true,
    };
    const staleLedger: DiagramFence = {
      language: "mermaid",
      code: "flowchart LR\nold --> tall --> diagram",
      start: 20,
      end: 31,
      inferred: false,
    };

    expect(mergeLocatedDiagrams([direct], [staleLedger])).toMatchInlineSnapshot(`
      [
        {
          "code": "flowchart LR
      1 --> 2 --> 3",
          "end": 21,
          "inferred": true,
          "language": "mermaid",
          "start": 20,
        },
      ]
    `);
  });

  it("completes a clipped visible prefix from the matching ledger diagram", () => {
    const clipped: DiagramFence = {
      language: "mermaid",
      code: "flowchart LR\n  PTY --> tmux",
      start: 20,
      end: 21,
      inferred: true,
    };
    const complete: DiagramFence = {
      language: "mermaid",
      code: "flowchart LR\n  PTY --> tmux\n  tmux --> xterm\n  xterm --> Mermaid",
      start: 20,
      end: 23,
      inferred: false,
    };

    expect(mergeLocatedDiagrams([clipped], [complete])).toEqual([complete]);
  });

  it("uses one row-scoped DOM identity across terminal and ledger indentation", () => {
    const terminal: DiagramFence = {
      language: "mermaid",
      code: "flowchart LR\n    PTY --> tmux\n    tmux --> xterm",
      start: 20,
      end: 22,
      inferred: true,
    };
    const ledger = { ...terminal, code: "flowchart LR\n  PTY --> tmux\n  tmux --> xterm", inferred: false };

    expect([diagramElementKey(terminal, true), diagramElementKey(ledger, true)])
      .toMatchInlineSnapshot(`
        [
          "true:mermaid:20:flowchart lr
        pty --> tmux
        tmux --> xterm",
          "true:mermaid:20:flowchart lr
        pty --> tmux
        tmux --> xterm",
        ]
      `);
  });
});
