import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { diagramElementAtPoint, diagramElementKey, findDiagramFences, loadMermaid, mergeLocatedDiagrams, svgAspectRatio, type DiagramFence } from "./0_terminalDiagrams";

function terminalWithRows(rows: string[], viewportY = 0, height = rows.length): Terminal {
  const lines = rows.map((text) => ({
    isWrapped: false,
    translateToString: () => text,
  }));
  return {
    rows: height,
    buffer: {
      active: {
        viewportY,
        length: lines.length,
        getLine: (row: number) => lines[row],
      },
    },
  } as unknown as Terminal;
}

describe("stripped terminal diagrams", () => {
  it("captures rich D2 with internal blank rows and stops at assistant prose", () => {
    const terminal = terminalWithRows([
      "• d2",
      "  direction: right",
      "",
      "  classes: {",
      "    ok: {",
      "      style.fill: \"#d3f9d8\"",
      "    }",
      "  }",
      "",
      "  IN: inputs { class: ok }",
      "  IN -> OUT",
      "Self-contained: no imported house file.",
    ]);

    expect(findDiagramFences(terminal)).toMatchInlineSnapshot(`
      [
        {
          "code": "direction: right

      classes: {
        ok: {
          style.fill: \"#d3f9d8\"
        }
      }

      IN: inputs { class: ok }
      IN -> OUT",
          "end": 10,
          "inferred": false,
          "language": "d2",
          "start": 0,
          "stripped": true,
        },
      ]
    `);
  });

  it("splits two zero-indent mermaid blocks separated by prose", () => {
    // The first code row (`flowchart LR`) sits at column 0 while the node rows
    // are indented, so codeIndent is 0. Without a blank-row boundary the first
    // block runs to the end of the buffer and the second never renders.
    const terminal = terminalWithRows([
      "2. Today, four tables",
      "mermaid",
      "flowchart LR",
      "  P[\"your program\"]",
      "  R[\"registry.pl\"]",
      "  P --> R",
      "",
      "3. After, one table",
      "mermaid",
      "flowchart LR",
      "  P2[\"rel soopy.files\"]",
      "  L2[\"LINKED_EXECUTORS\"]",
      "  P2 --> L2",
      "",
    ]);

    const fences = findDiagramFences(terminal);
    expect(fences).toHaveLength(2);
    expect(fences[0].start).toBe(1);
    expect(fences[0].end).toBe(5);
    expect(fences[0].code).toContain("registry.pl");
    expect(fences[0].code).not.toContain("LINKED_EXECUTORS");
    expect(fences[1].start).toBe(8);
    expect(fences[1].end).toBe(12);
    expect(fences[1].code).toContain("LINKED_EXECUTORS");
  });
});

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

describe("diagramElementAtPoint", () => {
  it("selects the last painted diagram when allocated rows overlap", () => {
    const element = (key: string, top: number, bottom: number) => ({
      dataset: { diagramKey: key },
      hidden: false,
      classList: { contains: () => false },
      getBoundingClientRect: () => ({ left: 0, right: 800, top, bottom }),
    }) as unknown as HTMLElement;
    const lower = element("lower", 100, 500);
    const visibleTop = element("visible-top", 300, 700);

    expect(diagramElementAtPoint([lower, visibleTop], 400, 400)?.dataset.diagramKey)
      .toMatchInlineSnapshot(`"visible-top"`);
  });
});

describe("diagram location precedence", () => {
  it("retains an explicit terminal fence while the ledger has no located match", () => {
    const direct: DiagramFence = {
      language: "d2",
      code: "terminal -> tmux -> xterm",
      start: 12,
      end: 14,
      inferred: false,
    };

    expect(mergeLocatedDiagrams([direct], [])).toMatchInlineSnapshot(`
      [
        {
          "code": "terminal -> tmux -> xterm",
          "end": 14,
          "inferred": false,
          "language": "d2",
          "start": 12,
        },
      ]
    `);
  });

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

type ScriptStub = {
  src: string;
  listeners: Map<string, () => void>;
  addEventListener: (event: string, listener: () => void) => void;
};

function scriptRecorder() {
  const scripts: ScriptStub[] = [];
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {
    createElement: () => {
      const listeners = new Map<string, () => void>();
      const script: ScriptStub = {
        src: "",
        listeners,
        addEventListener: (event, listener) => { listeners.set(event, listener); },
      };
      scripts.push(script);
      return script;
    },
    head: { appendChild: (script: ScriptStub) => script },
  });
  return scripts;
}

describe("mermaid bundle loader", () => {
  it("reports the network reason a script element hides", async () => {
    const scripts = scriptRecorder();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Load failed"); }));

    const pending = loadMermaid();
    scripts[0].listeners.get("error")!();

    await expect(pending).rejects.toThrow(/mermaid\.min\.js.* did not load: TypeError: Load failed/);
  });

  it("reports the served status when the bundle is reachable but never executes", async () => {
    const scripts = scriptRecorder();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, statusText: "Not Found" })));

    const pending = loadMermaid();
    scripts[0].listeners.get("error")!();

    await expect(pending).rejects.toThrow(/did not load: HTTP 404 Not Found/);
  });

  it("names the missing global when the bundle runs without publishing its API", async () => {
    const scripts = scriptRecorder();

    const pending = loadMermaid();
    scripts[0].listeners.get("load")!();

    await expect(pending).rejects.toThrow(/ran without defining globalThis\.mermaid/);
  });

  it("retries after a failed load instead of holding the rejected attempt", async () => {
    const scripts = scriptRecorder();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Load failed"); }));

    const first = loadMermaid();
    scripts[0].listeners.get("error")!();
    await expect(first).rejects.toThrow();

    const second = loadMermaid();
    expect(scripts).toHaveLength(2);
    scripts[1].listeners.get("error")!();
    await expect(second).rejects.toThrow();
  });
});
