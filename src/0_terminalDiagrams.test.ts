import { describe, expect, it, vi } from "vitest";
import { Signal } from "@hafley66/signals";
import type { Terminal } from "@xterm/xterm";
import { diagramElementAtPoint, diagramElementKey, findDiagramFences, loadMermaid, mergeLocatedDiagrams, projectedDiagramIsCurrent, renderDiagram, svgAspectRatio, TerminalDiagramOverlay, type DiagramFence } from "./0_terminalDiagrams";
import type { ProjectedTurnRegion } from "@hafley66/boop-xterm";
import type { TurnVisibilityEvent, VisibleTurn } from "@hafley66/boop-xterm";

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

describe("fences under tmux copy mode", () => {
  it("keeps a fence whose opener or closer carries the copy-mode indicator", () => {
    const terminal = terminalWithRows([
      "```mermaid                                   [3/120]",
      "graph LR; a --> b",
      "```                                          [4/120]",
    ]);
    const fences = findDiagramFences(terminal);
    expect(fences).toHaveLength(1);
    expect(fences[0].language).toBe("mermaid");
    expect(fences[0].code).toBe("graph LR; a --> b");
    expect(fences[0].start).toBe(0);
    expect(fences[0].end).toBe(2);
  });
});

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

  it("infers an opencode assistant timeline whose fence and label the TUI stripped", () => {
    // The opencode TUI paints an assistant code block with no backticks and no
    // language label, so the only origin left is the diagram keyword that opens
    // the body. The block stays bounded by the blank rows around it.
    const terminal = terminalWithRows([
      "     The zorbulon migration runs in three phases.",
      "",
      "     timeline",
      "         title zorbulon migration roadmap",
      "         Q1 : harvest the quux",
      "         Q2 : align the frobnicator",
      "         Q3 : ship zorbulon v2",
      "",
      "     Nothing else is in scope this quarter.",
    ]);

    const fences = findDiagramFences(terminal);
    expect(fences).toHaveLength(1);
    expect(fences[0].language).toBe("mermaid");
    expect(fences[0].inferred).toBe(true);
    expect(fences[0].stripped).toBeUndefined();
    expect(fences[0].start).toBe(2);
    expect(fences[0].end).toBe(6);
    expect(fences[0].code).toContain("title zorbulon migration roadmap");
    expect(fences[0].code).not.toContain("Nothing else is in scope");
  });
});

describe("Mermaid rendering", () => {
  it("keeps the full source when Mermaid accepts it", async () => {
    const code = "flowchart LR\n  A --> B\n  B --> C";
    const render = vi.fn().mockResolvedValue({ svg: '<svg viewBox="0 0 30 10"></svg>' });
    const mermaid = { initialize: vi.fn(), render };
    vi.stubGlobal("window", { mermaid });

    const result = await renderDiagram({ language: "mermaid", code, start: 1, end: 3, inferred: false, stripped: true }, false);

    expect({ calls: render.mock.calls.map(([, source]) => source), result }).toMatchInlineSnapshot(`
      {
        "calls": [
          "flowchart LR
        A --> B
        B --> C",
        ],
        "result": {
          "code": "flowchart LR
        A --> B
        B --> C",
          "lineCount": 3,
          "svg": "<svg viewBox=\"0 0 30 10\"></svg>",
        },
      }
    `);
    vi.unstubAllGlobals();
  });

  it("never accepts a diagram declaration without a body", async () => {
    const code = "flowchart LR\n  A --> B\ntrailing prose";
    const render = vi.fn(async (_id: string, source: string) => {
      if (source.includes("trailing prose")) throw new Error("parse failure");
      return { svg: '<svg viewBox="0 0 30 10"></svg>' };
    });
    vi.stubGlobal("window", { mermaid: { initialize: vi.fn(), render } });

    const result = await renderDiagram({ language: "mermaid", code, start: 1, end: 3, inferred: false, stripped: true }, false);

    expect({ calls: render.mock.calls.map(([, source]) => source), result }).toMatchInlineSnapshot(`
      {
        "calls": [
          "flowchart LR
        A --> B
      trailing prose",
          "flowchart LR
        A --> B",
        ],
        "result": {
          "code": "flowchart LR
        A --> B",
          "lineCount": 2,
          "svg": "<svg viewBox=\"0 0 30 10\"></svg>",
        },
      }
    `);
    vi.unstubAllGlobals();
  });

  it("bounds tail recovery for large malformed inferred sources", async () => {
    const render = vi.fn().mockRejectedValue(new Error("parse failure"));
    vi.stubGlobal("window", { mermaid: { initialize: vi.fn(), render } });
    const code = ["flowchart LR", ...Array.from({ length: 999 }, (_, index) => `  n${index} --> broken prose`)].join("\n");

    await expect(renderDiagram({ language: "mermaid", code, start: 1, end: 1000, inferred: true }, false))
      .rejects.toThrow("parse failure");
    expect(render.mock.calls).toHaveLength(16);
    expect(render.mock.calls.map(([, source]) => source.split("\n").length)).toEqual(
      Array.from({ length: 16 }, (_, index) => 1000 - index),
    );
    vi.unstubAllGlobals();
  });

  it("attempts a one-line explicit Mermaid source once", async () => {
    const render = vi.fn().mockRejectedValue(new Error("single-line failure"));
    vi.stubGlobal("window", { mermaid: { initialize: vi.fn(), render } });
    await expect(renderDiagram({ language: "mermaid", code: "flowchart LR", start: 1, end: 1, inferred: false }, false))
      .rejects.toThrow("single-line failure");
    expect(render).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
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
  it("rejects a projected diagram after its buffer rows contain different source", () => {
    const terminal = terminalWithRows([
      "flowchart LR",
      "CURRENT --> GRAPH",
      "GRAPH --> OUTPUT",
    ]);
    const stale: ProjectedTurnRegion = {
      id: "turn:mermaid:1",
      turnId: "turn",
      kind: "mermaid",
      sourceStart: 1,
      sourceEnd: 5,
      text: "flowchart LR\nOLD --> PLAN\nPLAN --> MAIN",
      bufferStart: 0,
      bufferEnd: 2,
      sourceBufferRows: [null, 0, 1, 2, null],
    };

    expect(projectedDiagramIsCurrent(terminal, stale)).toMatchInlineSnapshot(`false`);
  });

  it("accepts a projected diagram whose source still occupies its mapped rows", () => {
    const terminal = terminalWithRows([
      "flowchart LR",
      "CURRENT --> GRAPH",
      "GRAPH --> OUTPUT",
    ]);
    const current: ProjectedTurnRegion = {
      id: "turn:mermaid:1",
      turnId: "turn",
      kind: "mermaid",
      sourceStart: 1,
      sourceEnd: 5,
      text: "flowchart LR\nCURRENT --> GRAPH\nGRAPH --> OUTPUT",
      bufferStart: 0,
      bufferEnd: 2,
      sourceBufferRows: [null, 0, 1, 2, null],
    };

    expect(projectedDiagramIsCurrent(terminal, current)).toMatchInlineSnapshot(`true`);
  });

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
          "true:mermaid:flowchart lr
        pty --> tmux
        tmux --> xterm",
          "true:mermaid:flowchart lr
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

describe("diagram overlay flicker (diagnostic lane)", () => {
  it("leaves the root visible on a write that changes nothing", () => {
    // Overlay construction touches only a handful of browser globals; the
    // write/scroll/resize subscriptions are captured, not exercised, and the
    // frame never fires because requestAnimationFrame is a no-op stub here.
    vi.stubGlobal("requestAnimationFrame", () => 9);
    vi.stubGlobal("getComputedStyle", () => ({ backgroundColor: "rgb(24, 24, 24)" }));
    vi.stubGlobal("document", {
      createElement: () => ({
        className: "", hidden: false,
        dataset: {}, style: {}, classList: { contains: () => false },
        addEventListener() {}, querySelectorAll: () => [], remove() {},
      }),
    });
    let onWrite: (() => void) | null = null;
    const term = {
      rows: 20,
      buffer: { active: { viewportY: 0, length: 30, getLine: () => null } },
      onWriteParsed: (cb: () => void) => { onWrite = cb; return { dispose() {} }; },
      onScroll: () => ({ dispose() {} }),
      onResize: () => ({ dispose() {} }),
    } as unknown as Terminal;
    const host = {
      appendChild() {}, addEventListener() {}, removeEventListener() {},
      querySelector: () => null,
    } as unknown as HTMLElement;
    const projection = {
      state: Signal({ visible: [] as VisibleTurn[] }),
      changes: Signal<TurnVisibilityEvent>(),
      settled: Signal<void>(),
      scanning: Signal(false),
    };
    const overlay = new TerminalDiagramOverlay(term, host, undefined, projection);

    expect(overlay.root.hidden).toBe(false);
    onWrite!();
    expect(overlay.root.hidden).toBe(false);
  });

  it("keeps the DOM element when a projected fence's buffer rows shift", () => {
    // Element reuse at paint() keys only on diagramElementKey(), which now codes
    // the stable turn-scoped locator, not the physical buffer row. A rescan that
    // moves the same logical diagram one row down therefore reuses the element
    // instead of re-minting it: no idle re-create flash.
    const fence = (start: number, end: number): DiagramFence => ({
      language: "mermaid", code: "flowchart LR\n  A --> B",
start, end, inferred: false, locator: "boop:turn:1", messageId: "turn:1",
    });
    expect(fence(10, 12).locator).toBe(fence(11, 13).locator);
    expect(diagramElementKey(fence(10, 12), false)).toBe(diagramElementKey(fence(11, 13), false));
  });
});

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

function overlayRig(rows: string[], scanning = false) {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("getComputedStyle", () => ({ backgroundColor: "rgb(24, 24, 24)" }));
  const created: Array<Record<string, any>> = [];
  vi.stubGlobal("document", {
    createElement: () => {
      const element: Record<string, any> = {
        className: "", hidden: false, title: "", innerHTML: "", textContent: "",
        dataset: {}, style: {}, children: [],
        classList: { contains: () => false },
        addEventListener() {}, removeEventListener() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 }),
        querySelectorAll: () => element.children.filter((child: any) =>
          String(child.className).split(" ").includes("term-diagram")),
        replaceChildren: (...next: any[]) => { element.children = next; },
        remove() {},
      };
      created.push(element);
      return element;
    },
  });
  const screen = {
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 }),
  };
  const host = {
    appendChild() {}, addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    querySelector: (selector: string) => selector === ".xterm-screen" ? screen : null,
  } as unknown as HTMLElement;
  let onWrite: (() => void) | null = null;
  let onScroll: (() => void) | null = null;
  const term = {
    rows: 24,
    buffer: {
      active: {
        viewportY: 0,
        length: Math.max(rows.length, 24),
        getLine: (row: number) => row < rows.length
          ? { isWrapped: false, translateToString: () => rows[row] }
          : null,
      },
    },
    onWriteParsed: (cb: () => void) => { onWrite = cb; return { dispose() {} }; },
    onScroll: (cb: () => void) => { onScroll = cb; return { dispose() {} }; },
    onResize: () => ({ dispose() {} }),
  } as unknown as Terminal;
  const projection = {
    state: Signal({ visible: [] as VisibleTurn[] }),
    changes: Signal<TurnVisibilityEvent>(),
    settled: Signal<void>(),
    scanning: Signal(scanning),
  };
  const overlay = new TerminalDiagramOverlay(term, host, undefined, projection);
  return { overlay, projection, frames, term, write: () => onWrite!(), scroll: () => onScroll!(), elements: created };
}

describe("diagram overlay idle render", () => {
  const fenceRows = ["```mermaid", "flowchart LR", "  A --> B", "```"];

  it("paints a terminal fence on write even when the ledger has no turn", async () => {
    vi.stubGlobal("window", { mermaid: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '<svg viewBox="0 0 30 10"></svg>' }) } });
    const { overlay, write, elements } = overlayRig(fenceRows);

    write();
    expect(overlay.hideRequested).toBe(true);
    await overlay.paint();

    expect(overlay.root.hidden).toBe(false);
    expect(elements[elements.length - 1].dataset.language).toBe("mermaid");
    vi.unstubAllGlobals();
  });

  it("leaves a painted overlay alone on a write that changes nothing", async () => {
    vi.stubGlobal("window", { mermaid: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '<svg viewBox="0 0 30 10"></svg>' }) } });
    const { overlay, write } = overlayRig(fenceRows);
    await overlay.paint();

    const generationBefore = overlay.generation;
    write();

    expect(overlay.hideRequested).toBe(false);
    expect(overlay.generation).toBe(generationBefore);
    expect(overlay.root.hidden).toBe(false);
    vi.unstubAllGlobals();
  });

  it("unhides on activate even when nothing about the fences changed", async () => {
    vi.stubGlobal("window", { mermaid: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '<svg viewBox="0 0 30 10"></svg>' }) } });
    const { overlay } = overlayRig(fenceRows);
    await overlay.paint();
    expect(overlay.lastPaintedFingerprint).not.toBe("");

    overlay.activate();
    await overlay.paint();

    expect(overlay.root.hidden).toBe(false);
    vi.unstubAllGlobals();
  });

  it("leaves the fingerprint unpinned on a failed render and schedules a retry", async () => {
    const render = vi.fn().mockRejectedValue(new Error("bundle unreachable"));
    vi.stubGlobal("window", { mermaid: { initialize: vi.fn(), render } });
    const { overlay } = overlayRig(fenceRows);

    await overlay.paint();
    expect(overlay.lastPaintedFingerprint).toBe("");
    expect(overlay.retryTimer).not.toBeNull();

    render.mockResolvedValue({ svg: '<svg viewBox="0 0 30 10"></svg>' });
    await overlay.paint();
    expect(overlay.lastPaintedFingerprint).not.toBe("");
    expect(overlay.retryTimer).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("diagram overlay scroll debounce", () => {
  const fenceRows = ["```mermaid", "flowchart LR", "  A --> B", "```"];

  it("holds the root hidden across paints while the wheel is active", async () => {
    vi.stubGlobal("window", { mermaid: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '<svg viewBox="0 0 30 10"></svg>' }) } });
    const { overlay } = overlayRig(fenceRows);
    await overlay.paint();
    expect(overlay.root.hidden).toBe(false);

    overlay.viewportScrolled();
    expect(overlay.root.hidden).toBe(true);
    await overlay.paint();
    expect(overlay.root.hidden).toBe(true);

    overlay.scrollEvents.next();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await overlay.paint();
    expect(overlay.scrolling).toBe(false);
    expect(overlay.root.hidden).toBe(false);
    vi.unstubAllGlobals();
  });
});

describe("diagram overlay scan settle", () => {
  it("paints a stripped fence once the scan that suppressed it settles", async () => {
    vi.stubGlobal("window", { mermaid: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '<svg viewBox="0 0 30 10"></svg>' }) } });
    const { overlay, projection, frames, write, elements } = overlayRig(["• mermaid", "  flowchart LR", "    A --> B"], true);
    const painted = () => elements
      .filter((element) => String(element.className).split(" ").includes("term-diagram"))
      .map((element) => ({ language: element.dataset.language, code: element.dataset.diagramCode, rows: `${element.dataset.bufferStart}-${element.dataset.bufferEnd}` }));
    const flush = async () => {
      while (frames.length) {
        frames.shift()!(0);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };

    await flush();
    write();
    await flush();
    expect({ fingerprint: overlay.lastPaintedFingerprint, painted: painted() }).toMatchInlineSnapshot(`
      {
        "fingerprint": "true:0:",
        "painted": [],
      }
    `);

    projection.scanning.$(false);
    projection.settled.$(undefined);
    await flush();
    expect({ fingerprint: overlay.lastPaintedFingerprint, painted: painted() }).toMatchInlineSnapshot(`
      {
        "fingerprint": "true:0:true:mermaid:flowchart lr
      a --> b#22",
        "painted": [
          {
            "code": "flowchart LR
        A --> B",
            "language": "mermaid",
            "rows": "0-2",
          },
        ],
      }
    `);
    vi.unstubAllGlobals();
  });
});

// Claude Code's shape from the owner's screenshot: a stripped mermaid fence
// whose last node row is followed, with no blank row, by a box-drawn table and
// prose at the same indentation. Mermaid reported `Lexical error on line 13.
// Unrecognized text. ... --> DD  G --> SQ┌──────┬──────`.
const claudeStrippedFenceIntoTable = [
  "● The query path, then the storage table:",
  "  mermaid",
  "  flowchart TD",
  "    A[client] --> B[router]",
  "    B --> C[planner]",
  "    C --> D[executor]",
  "    D --> DD[cache]",
  "    C --> E[index]",
  "    E --> F[scan]",
  "    F --> G[merge]",
  "    DD --> G",
  "    B --> H[auth]",
  "    H --> G",
  "    G --> SQ",
  "  ┌──────┬──────────────────┐",
  "  │ key  │ meaning          │",
  "  ├──────┼──────────────────┤",
  "  │ A    │ client request   │",
  "  ├──────┼──────────────────┤",
  "  │ B    │ router           │",
  "  ├──────┼──────────────────┤",
  "  │ G    │ merge step       │",
  "  └──────┴──────────────────┘",
  "  The merge step joins the cache and the scan results before the",
  "  final sort, so the planner never sees partial rows. Each stage",
  "  writes its own trace span, which is how the timings above were",
  "  collected in the first place.",
  "  - one bullet",
  "  - another bullet",
  "",
];

describe("stripped fence boundaries", () => {
  it("ends a stripped mermaid fence at a box-drawn table row", () => {
    const fences = findDiagramFences(terminalWithRows(claudeStrippedFenceIntoTable, 0, 24));
    expect(fences.map((fence) => ({ start: fence.start, end: fence.end, last: fence.code.split("\n").pop() })))
      .toMatchInlineSnapshot(`
        [
          {
            "end": 13,
            "last": "  G --> SQ",
            "start": 1,
          },
        ]
      `);
  });

  it("ends a stripped mermaid fence at the first blank row before same-indent prose", () => {
    const rows = [
      "● The flow:",
      "  mermaid",
      "  flowchart TD",
      "    A --> B",
      "",
      "  The flow above feeds the planner, which reads the index first.",
      "  A second paragraph at the same indent as the diagram code.",
    ];
    expect(findDiagramFences(terminalWithRows(rows, 0, 24)).map((fence) => `${fence.start}-${fence.end}`))
      .toMatchInlineSnapshot(`
        [
          "1-3",
        ]
      `);
  });

  it("ends stripped and inferred fences at bullet, prompt and dedented rows", () => {
    const rows = [
      "  mermaid",
      "  flowchart LR",
      "    A --> B",
      "  • next message",
      "  mermaid",
      "  flowchart LR",
      "    C --> D",
      "  > composer prompt",
      "    flowchart LR",
      "      E --> F",
      "  dedented prose",
      "    flowchart LR",
      "      G --> H",
      "    * starred bullet",
      "",
    ];
    expect(findDiagramFences(terminalWithRows(rows, 0, 24)).map((fence) => `${fence.start}-${fence.end}:${fence.inferred}`))
      .toMatchInlineSnapshot(`
        [
          "0-2:false",
          "4-6:false",
          "8-9:true",
          "11-12:true",
        ]
      `);
  });

  it("paints the screenshot's stripped fence over its diagram rows only", async () => {
    const render = vi.fn(async (_id: string, source: string) => {
      if (/[┌│└├]/.test(source) || source.includes("merge step joins")) throw new Error("Lexical error on line 13. Unrecognized text.");
      return { svg: '<svg viewBox="0 0 30 10"></svg>' };
    });
    vi.stubGlobal("window", { mermaid: { initialize: vi.fn(), render } });
    const { overlay } = overlayRig(claudeStrippedFenceIntoTable);
    await overlay.paint();
    const children = overlay.root.children as unknown as Array<Record<string, any>>;
    expect(children.map((element) => ({ className: element.className, text: element.textContent, rows: `${element.dataset.bufferStart}-${element.dataset.sourceRows}` })))
      .toMatchInlineSnapshot(`
        [
          {
            "className": "term-diagram",
            "rows": "1-13",
            "text": "",
          },
        ]
      `);
    vi.unstubAllGlobals();
  });

  it("paints nothing over the rows when a stripped fence fails to render", async () => {
    vi.stubGlobal("window", { mermaid: { initialize: vi.fn(), render: vi.fn().mockRejectedValue(new Error("Lexical error on line 13. Unrecognized text.")) } });
    const { overlay } = overlayRig(claudeStrippedFenceIntoTable);
    await overlay.paint();
    const children = overlay.root.children as unknown as Array<Record<string, any>>;
    expect(children.map((element) => element.textContent)).toMatchInlineSnapshot(`[]`);
    overlay.clearRetry();
    vi.unstubAllGlobals();
  });

  it("paints nothing over the rows when an explicit fence fails to render", async () => {
    vi.stubGlobal("window", { mermaid: { initialize: vi.fn(), render: vi.fn().mockRejectedValue(new Error("Parse error on line 2")) } });
    const { overlay } = overlayRig(["```mermaid", "flowchart LR", "  A -->", "```"]);
    await overlay.paint();
    const children = overlay.root.children as unknown as Array<Record<string, any>>;
    expect({ texts: children.map((element) => element.textContent), retry: overlay.retryTimer !== null, reason: overlay.root.dataset.diagramError }).toMatchInlineSnapshot(`
      {
        "reason": "Parse error on line 2",
        "retry": true,
        "texts": [],
      }
    `);
    overlay.clearRetry();
    vi.unstubAllGlobals();
  });
});

describe("diagram overlay across scans", () => {
  it("keeps a painted stripped fence on screen while later scans run and the pane keeps writing", async () => {
    vi.stubGlobal("window", { mermaid: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '<svg viewBox="0 0 30 10"></svg>' }) } });
    const rows = ["• mermaid", "  flowchart LR", "    A --> B", "", "✻ Thinking… (1s)"];
    const { overlay, projection, frames, write, scroll } = overlayRig(rows);
    const flush = async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      while (frames.length) {
        frames.shift()!(0);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    const onScreen = () => ({
      hidden: overlay.root.hidden,
      diagrams: (overlay.root.children as unknown as Array<Record<string, any>>).map((element) => element.dataset.bufferStart),
    });
    await flush();
    const trace = [onScreen()];
    // Claude's spinner row repaints while the turn ledger rescans the pane.
    for (let tick = 2; tick <= 4; tick++) {
      projection.scanning.$(true);
      rows[4] = `✻ Thinking… (${tick}s)`;
      write();
      scroll();
      await flush();
      trace.push(onScreen());
      projection.scanning.$(false);
      projection.settled.$(undefined);
      await flush();
      trace.push(onScreen());
    }
    expect(trace).toMatchInlineSnapshot(`
      [
        {
          "diagrams": [
            "0",
          ],
          "hidden": false,
        },
        {
          "diagrams": [
            "0",
          ],
          "hidden": false,
        },
        {
          "diagrams": [
            "0",
          ],
          "hidden": false,
        },
        {
          "diagrams": [
            "0",
          ],
          "hidden": false,
        },
        {
          "diagrams": [
            "0",
          ],
          "hidden": false,
        },
        {
          "diagrams": [
            "0",
          ],
          "hidden": false,
        },
        {
          "diagrams": [
            "0",
          ],
          "hidden": false,
        },
      ]
    `);
    vi.unstubAllGlobals();
  });

  it("paints a stripped fence a settled scan saw even when the next scan starts before the repaint", async () => {
    // A fresh render (a growing explicit fence) keeps a paint in flight when the
    // scan settles, so the settle's repaint queues behind it and runs after the
    // next scan has already started.
    const renders: Array<() => void> = [];
    const render = vi.fn((_id: string, _code: string) => new Promise((resolve) => {
      renders.push(() => resolve({ svg: '<svg viewBox="0 0 30 10"></svg>' }));
    }));
    vi.stubGlobal("window", { mermaid: { initialize: vi.fn(), render } });
    const rows = ["```mermaid", "flowchart LR", "  X --> Y", "```", "", "• mermaid", "  flowchart LR", "    A --> B", "", "✻ Thinking… (1s)"];
    const { overlay, projection, frames, write } = overlayRig(rows, true);
    const settle = async () => {
      for (let turn = 0; turn < 20 && (frames.length || renders.length || overlay.painting); turn++) {
        frames.splice(0).forEach((frame) => frame(0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        renders.splice(0).forEach((resolve) => resolve());
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    const onScreen = () => (overlay.root.children as unknown as Array<Record<string, any>>).map((element) => element.dataset.bufferStart);
    const trace: string[][] = [];
    for (let tick = 2; tick <= 4; tick++) {
      rows[2] = `  X --> Y${tick}`;
      write();
      await new Promise((resolve) => setTimeout(resolve, 120));
      frames.splice(0).forEach((frame) => frame(0));
      projection.scanning.$(false);
      projection.settled.$(undefined);
      projection.scanning.$(true);
      await settle();
      trace.push(onScreen());
    }
    expect(trace).toEqual([["0", "5"], ["0", "5"], ["0", "5"]]);
    vi.unstubAllGlobals();
  });
});

describe("inline diagram inference setting", () => {
  const rows = [
    "```mermaid",
    "flowchart LR",
    "  A --> B",
    "```",
    "",
    "• mermaid",
    "  flowchart LR",
    "    C --> D",
    "",
    "     timeline",
    "         title roadmap",
    "         Q1 : ship",
    "",
  ];
  it("detects explicit fences, then label rows, then unlabeled bodies as the setting widens", () => {
    const terminal = terminalWithRows(rows, 0, 24);
    expect((["explicit", "labels", "inferred"] as const).map((inference) =>
      `${inference}: ${findDiagramFences(terminal, inference).map((fence) => `${fence.start}-${fence.end}${fence.stripped ? " stripped" : ""}${fence.inferred ? " inferred" : ""}`).join(", ")}`))
      .toMatchInlineSnapshot(`
        [
          "explicit: 0-3",
          "labels: 0-3, 5-7 stripped",
          "inferred: 0-3, 5-7 stripped, 9-11 inferred",
        ]
      `);
  });

  it("paints what the overlay's inference setting allows", async () => {
    vi.stubGlobal("window", { mermaid: { initialize: vi.fn(), render: vi.fn().mockResolvedValue({ svg: '<svg viewBox="0 0 30 10"></svg>' }) } });
    const { overlay } = overlayRig(rows);
    const painted = async (inference: "explicit" | "labels" | "inferred") => {
      overlay.inference = () => inference;
      overlay.activate();
      await overlay.paint();
      return `${inference}: ${(overlay.root.children as unknown as Array<Record<string, any>>).map((element) => element.dataset.bufferStart).join(", ")}`;
    };
    expect([await painted("explicit"), await painted("labels"), await painted("inferred")]).toMatchInlineSnapshot(`
      [
        "explicit: 0",
        "labels: 0, 5",
        "inferred: 0, 5, 9",
      ]
    `);
    vi.unstubAllGlobals();
  });
});
