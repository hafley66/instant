import { test, expect, type Page } from "@playwright/test";

type TermHooks = {
  write: (data: string) => void;
  point: (row: number, col: number) => { x: number; y: number } | null;
  resize: (cols: number, rows: number) => void;
  dims: () => { cols: number; rows: number } | null;
  scroll: (lines: number) => void;
  selection: () => string;
};

declare global {
  interface Window {
    __term?: TermHooks;
    __visibleTurnEvents?: Array<{
      visible: Array<{ id: string }>;
      entered: Array<{ id: string }>;
      exited: Array<{ id: string }>;
    }>;
    __viewportChanges?: Array<{ kind: string; cols: number; rows: number; viewportY: number; bufferLength: number }>;
  }
}

test("emits xterm geometry when its row and column count changes", async ({ page }) => {
  await openTerminal(page);
  await page.evaluate(() => window.__term!.resize(70, 10));
  await expect.poll(() => page.evaluate(() => window.__viewportChanges?.at(-1))).toMatchObject({
    kind: "resize",
    cols: 70,
    rows: 10,
  });
});

const output = (harness: "Codex" | "Claude Code") => [
  `${harness} response:`,
  "```mermaid",
  "flowchart LR",
  "  PTY --> tmux",
  "  tmux --> xterm",
  "```",
  "",
  "```d2",
  "PTY -> tmux",
  "tmux -> xterm",
  "```",
].join("\r\n");

const renderedCliOutput = (harness: "Codex" | "Claude Code") => [
  `${harness} response:`,
  "",
  "• PTY -> tmux",
  "  tmux -> xterm",
  '  xterm -> "D2 renderer"',
  "",
  "  flowchart LR",
  "    PTY --> tmux",
  "    tmux --> xterm",
  "    xterm --> Mermaid",
].join("\r\n");

const scrolledMermaidOutput = [
  "Codex response:",
  "  flowchart LR",
  "    PTY --> tmux",
  "    tmux --> xterm",
  "    xterm --> Mermaid",
  "This prose arrived later without a blank separator (click)",
].join("\r\n");

async function openTerminal(page: Page, params = "e2e=1") {
  await page.goto(`/e2e-term.html?${params}`);
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => !!window.__term?.point(0, 0));
}

async function writeFixture(page: Page, text: string) {
  await page.evaluate((fixture) => {
    window.__term!.write(`\x1b[2J\x1b[H${"\r\n".repeat(30)}${fixture}`);
  }, text);
}

test("emits Boop turn ids as terminal viewport contents change", async ({ page }, testInfo) => {
  await openTerminal(page);
  const rows = (await page.evaluate(() => window.__term!.dims()))!.rows;
  await page.evaluate(({ count }) => {
    const label = (index: number) => index < 26
      ? String.fromCharCode(65 + index)
      : `A${String.fromCharCode(65 + index - 26)}`;
    window.__term!.write(`\x1b[2J\x1b[H${Array.from({ length: count }, (_, index) =>
      `⏺ ${label(index)}`
    ).join("\r\n")}`);
  }, { count: rows });

  await expect.poll(() => page.evaluate(() => window.__visibleTurnEvents?.at(-1)?.visible.map((turn) => turn.id)))
    .toEqual(Array.from({ length: rows }, (_, index) => `e2e-codex-1:${index + 1}`));

  await testInfo.attach("boop-turn-11-visible", {
    body: await page.locator(".term-host").screenshot(),
    contentType: "image/png",
  });

  await page.evaluate(({ count }) => {
    const label = (index: number) => index < 26
      ? String.fromCharCode(65 + index)
      : `A${String.fromCharCode(65 + index - 26)}`;
    window.__term!.write(`\x1b[2J\x1b[H${Array.from({ length: count }, (_, index) =>
      `⏺ ${label(index + 10)}`
    ).join("\r\n")}`);
  }, { count: rows });

  await expect.poll(() => page.evaluate(() => window.__visibleTurnEvents?.at(-1))).toMatchObject({
    visible: Array.from({ length: rows }, (_, index) => ({ id: `e2e-codex-1:${index + 11}` })),
    entered: Array.from({ length: 10 }, (_, index) => ({ id: `e2e-codex-1:${rows + index + 1}` })),
    exited: Array.from({ length: 10 }, (_, index) => ({ id: `e2e-codex-1:${index + 1}` })),
  });

  await testInfo.attach("boop-turn-12-visible", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.screenshot({ path: "artifacts/boop-turn-visibility-v2.png", fullPage: true });
});

test("right-click resolves partially visible turns at both viewport edges", async ({ page }, testInfo) => {
  await openTerminal(page, "e2e=1&edgeTurns=1");
  const rows = (await page.evaluate(() => window.__term!.dims()))!.rows;
  const topRows = Math.max(2, Math.floor(rows / 2));
  const screen = [
    "TOP VISIBLE",
    ...Array.from({ length: topRows - 1 }, (_, index) => `TOP BODY ${index}`),
    "BOTTOM START",
    ...Array.from({ length: rows - topRows - 1 }, (_, index) => `BOTTOM BODY ${index}`),
  ];
  await page.evaluate((lines) => window.__term!.write(`\x1b[2J\x1b[H${lines.join("\r\n")}`), screen);
  await expect.poll(() => page.evaluate(() => window.__visibleTurnEvents?.at(-1)?.visible.map((turn) => turn.id)))
    .toEqual(["e2e-codex-1:101", "e2e-codex-1:102"]);

  const top = await page.evaluate(() => window.__term!.point(0, 2));
  await page.mouse.click(top!.x, top!.y, { button: "right" });
  await expect(page.locator(".ctx-menu")).toContainText("Boop e2e-codex-1:101 · assistant");
  await page.screenshot({ path: "artifacts/boop-turn-context-top-partial.png", fullPage: true });
  await testInfo.attach("top-partial-turn-context", { body: await page.screenshot(), contentType: "image/png" });

  await page.keyboard.press("Escape");
  const bottom = await page.evaluate((row) => window.__term!.point(row, 2), rows - 1);
  await page.mouse.click(bottom!.x, bottom!.y, { button: "right" });
  await expect(page.locator(".ctx-menu")).toContainText("Boop e2e-codex-1:102 · assistant");
  await page.screenshot({ path: "artifacts/boop-turn-context-bottom-partial.png", fullPage: true });
  await testInfo.attach("bottom-partial-turn-context", { body: await page.screenshot(), contentType: "image/png" });
});

test("right-click distinguishes partial edge turns around a complete middle turn", async ({ page }, testInfo) => {
  await openTerminal(page, "e2e=1&edgeTurns=3");
  const rows = (await page.evaluate(() => window.__term!.dims()))!.rows;
  const middle = ["MIDDLE START", ...Array.from({ length: 8 }, (_, index) => `MIDDLE BODY ${index}`), "MIDDLE END"];
  const remaining = rows - middle.length;
  const topCount = Math.floor(remaining / 2);
  const bottomCount = remaining - topCount;
  const screen = [
    "TOP THREE VISIBLE",
    ...Array.from({ length: topCount - 1 }, (_, index) => `TOP THREE BODY ${index}`),
    ...middle,
    "BOTTOM THREE START",
    ...Array.from({ length: bottomCount - 1 }, (_, index) => `BOTTOM THREE BODY ${index}`),
  ];
  await page.evaluate((lines) => window.__term!.write(`\x1b[2J\x1b[H${lines.join("\r\n")}`), screen);
  await expect.poll(() => page.evaluate(() => window.__visibleTurnEvents?.at(-1)?.visible.map((turn) => turn.id)))
    .toEqual(["e2e-codex-1:201", "e2e-codex-1:202", "e2e-codex-1:203"]);

  const cases = [
    { row: 0, turn: 201, receipt: "three-turn-top-partial" },
    { row: topCount + 4, turn: 202, receipt: "three-turn-middle-complete" },
    { row: rows - 1, turn: 203, receipt: "three-turn-bottom-partial" },
  ];
  for (const entry of cases) {
    const point = await page.evaluate((row) => window.__term!.point(row, 2), entry.row);
    await page.mouse.click(point!.x, point!.y, { button: "right" });
    await expect(page.locator(".ctx-menu")).toContainText(`Boop e2e-codex-1:${entry.turn} · assistant`);
    await page.screenshot({ path: `artifacts/${entry.receipt}.png`, fullPage: true });
    await testInfo.attach(entry.receipt, { body: await page.screenshot(), contentType: "image/png" });
    await page.keyboard.press("Escape");
  }
});

test("right-click resolves table turn with unicode box-drawing characters", async ({ page }, testInfo) => {
  await page.goto("/e2e-term.html?e2e=1");
  await page.evaluate(() => {
    const target = window as Window & {
      __instantE2eNativeResults?: Record<string, unknown>;
    };
    if (target.__instantE2eNativeResults) {
      target.__instantE2eNativeResults.boop_turns = () => Promise.resolve([{
        session: "e2e-codex-1",
        harness: "codex",
        turn: 10135,
        role: "assistant",
        ts: Date.now(),
        said: [
          "Claude, OpenCode, Kimi, or another harness can implement the same generic lifecycle with their native APIs.",
          "",
          "## Concepts shared with the researched systems",
          "",
          "| Boop mechanism | Common systems concept |",
          "|---|---|",
          "| Inspecting WebSocket relay | Sidecar or transparent protocol proxy |",
          "| Unix domain sockets | Local IPC used by editors, language servers, daemons |",
          "| Request-ID correlation | JSON-RPC, LSP, DAP, ACP |",
        ].join("\n"),
      }]);
    }
  });
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible({ timeout: 10_000 });
  const tableLines = [
    "Claude, OpenCode, Kimi, or another harness can implement the same generic lifecycle with their native APIs.",
    "",
    "  ## Concepts shared with the researched systems",
    "",
    "   Boop mechanism                       Common systems concept",
    "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "   Inspecting WebSocket relay           Sidecar or transparent protocol proxy",
    "  ───────────────────────────────────  ──────────────────────────────────────────────────────",
    "   Unix domain sockets                  Local IPC used by editors, language servers, daemons",
  ];
  await page.evaluate((lines) => window.__term!.write(`\x1b[2J\x1b[H${lines.join("\r\n")}`), tableLines);
  await expect.poll(() => page.evaluate(() => window.__visibleTurnEvents?.at(-1)?.visible.map((turn) => turn.id)))
    .toEqual(["e2e-codex-1:10135"]);

  const point = await page.evaluate(() => window.__term!.point(6, 4));
  await page.mouse.click(point!.x, point!.y, { button: "right" });
  await expect(page.locator(".ctx-menu")).toContainText("Boop e2e-codex-1:10135 · assistant");
  await page.screenshot({ path: "artifacts/boop-turn-context-unicode-table.png", fullPage: true });
  await testInfo.attach("unicode-table-turn-context", { body: await page.screenshot(), contentType: "image/png" });
});

async function settleScroll(page: Page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    window.__term!.scroll(-1);
    window.__term!.scroll(1);
  });
}

async function visibleDiagramPoint(diagram: ReturnType<Page["locator"]>) {
  return diagram.evaluate((element) => {
    const diagramRect = element.getBoundingClientRect();
    const screenRect = element.closest(".term-host")!.querySelector(".xterm-screen")!.getBoundingClientRect();
    return {
      x: Math.max(diagramRect.left, screenRect.left) + 20,
      y: (Math.max(diagramRect.top, screenRect.top) + Math.min(diagramRect.bottom, screenRect.bottom)) / 2,
    };
  });
}

async function rightClickVisibleDiagram(page: Page, diagram: ReturnType<Page["locator"]>) {
  const point = await visibleDiagramPoint(diagram);
  await page.mouse.click(point.x, point.y, { button: "right" });
}

for (const harness of ["Codex", "Claude Code"] as const) {
  test(`renders plain fenced Mermaid and D2 output from ${harness}`, async ({ page }, testInfo) => {
    await openTerminal(page);
    await writeFixture(page, output(harness));

    const diagrams = page.locator(".term-diagram");
    await expect(diagrams).toHaveCount(2);
    await expect(page.locator('.term-diagram[data-language="mermaid"] svg')).toBeVisible();
    await expect(page.locator('.term-diagram[data-language="d2"] > svg')).toBeVisible();
    await expect(page.locator('.term-diagram[data-language="mermaid"]')).toContainText("PTY");
    await expect(page.locator('.term-diagram[data-language="mermaid"]')).toContainText("xterm");
    await expect(page.locator('.term-diagram[data-language="mermaid"]')).not.toContainText("old diagram");
    await expect(page.locator('.term-diagram[data-language="d2"]')).toContainText("PTY");
    await expect(page.locator('.term-diagram[data-language="d2"]')).toContainText("xterm");
    const inlineBoxes = await page.locator(".term-diagram > svg").evaluateAll((svgs) => svgs.map((svg) => {
      const box = svg.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height) };
    }));
    expect(inlineBoxes).toHaveLength(2);
    expect(inlineBoxes.every(({ width, height }) => width > 500 && height > 40)).toBe(true);

    await rightClickVisibleDiagram(page, page.locator('.term-diagram[data-language="d2"]'));
    await page.locator(".ctx-item", { hasText: "Expand D2 diagram" }).click();
    const expanded = page.locator('.diagram-lightbox[data-language="d2"]');
    await expect(expanded).toBeVisible();
    await expect(expanded).toContainText("PTY");
    await expect(expanded.getByTitle(/zoom in/i)).toBeVisible();
    await expect(expanded.getByTitle("fit the complete SVG")).toBeVisible();
    const svgObject = expanded.locator(".diagram-vector-stage > svg");
    await expect(svgObject).toHaveAttribute("viewBox", /\S+/);
    const beforeZoom = await svgObject.getAttribute("viewBox");
    await expanded.getByTitle(/zoom in/i).click();
    await expect.poll(() => svgObject.getAttribute("viewBox")).not.toBe(beforeZoom);
    await expect(expanded.locator(".panzoom-canvas")).toHaveCount(0);
    await testInfo.attach(`${harness.toLowerCase().replaceAll(" ", "-")}-diagram-lightbox`, {
      body: await expanded.screenshot(),
      contentType: "image/png",
    });
    await page.keyboard.press("Escape");
    await expect(expanded).toHaveCount(0);
    await expect(page.locator(".term-host")).toBeVisible();
    await expect(diagrams).toHaveCount(2);
    await expect(page.locator('.term-diagram[data-language="mermaid"]')).toContainText("PTY");
    await expect(page.locator('.term-diagram[data-language="d2"]')).toContainText("PTY");
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    ));
    await testInfo.attach(`${harness.toLowerCase().replaceAll(" ", "-")}-inline-diagrams`, {
      body: await page.locator(".term-host").screenshot(),
      contentType: "image/png",
    });
  });

  test(`matches ${harness} viewport lines to Boop Mermaid and D2 regions`, async ({ page }) => {
    await openTerminal(page);
    await writeFixture(page, renderedCliOutput(harness));
    await settleScroll(page);

    await expect(page.locator('.term-diagram[data-language="d2"] > svg')).toBeVisible();
    await expect(page.locator('.term-diagram[data-language="mermaid"] svg')).toBeVisible();
    await expect(page.locator('.term-diagram[data-language="d2"]')).toContainText("D2 renderer");
    await expect(page.locator('.term-diagram[data-language="mermaid"]')).toContainText("Mermaid");
    const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
    const allocation = await mermaid.evaluate((element) => ({
      sourceRows: Number((element as HTMLElement).dataset.sourceRows),
      allocatedRows: Number((element as HTMLElement).dataset.allocatedRows),
    }));
    expect(allocation.allocatedRows).toBeGreaterThan(allocation.sourceRows);
  });
}

test("wheel routes to tmux copy-mode without moving xterm scrollback", async ({ page }) => {
  await openTerminal(page);
  await writeFixture(page, output("Claude Code"));
  const diagram = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(diagram).toBeVisible();
  const box = await diagram.boundingBox();
  expect(box).not.toBeNull();
  await page.evaluate(() => {
    const target = window as Window & {
      __instantE2eNativeResults?: Record<string, unknown>;
      __scrollSessionArgs?: Record<string, unknown>;
      __viewportBeforeWheel?: number;
    };
    target.__viewportBeforeWheel = window.__term!.dims() ? document.querySelector<HTMLElement>(".xterm-viewport")!.scrollTop : -1;
    if (target.__instantE2eNativeResults) {
      target.__instantE2eNativeResults.scroll_session = (args: Record<string, unknown>) => {
        target.__scrollSessionArgs = args;
      };
    }
  });

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -100);

  await expect.poll(() => page.evaluate(() => (window as Window & { __scrollSessionArgs?: Record<string, unknown> }).__scrollSessionArgs))
    .toEqual({ name: "e2e", up: true, lines: expect.any(Number) });
  const localScroll = await page.evaluate(() => {
    const target = window as Window & { __viewportBeforeWheel?: number };
    return {
      before: target.__viewportBeforeWheel,
      after: document.querySelector<HTMLElement>(".xterm-viewport")!.scrollTop,
    };
  });
  expect(localScroll.after).toBe(localScroll.before);
  await expect(page.locator(".term-diagrams")).toBeHidden();
  await expect(page.locator(".term-diagrams")).toBeVisible();
  await expect(diagram).toContainText("Mermaid");
});

test("renders explicit terminal fences while Boop has no matching visible turn", async ({ page }) => {
  await page.goto("/e2e-term.html?e2e=1");
  await page.evaluate(() => {
    const target = window as Window & {
      __instantE2eNativeResults?: Record<string, unknown>;
    };
    if (target.__instantE2eNativeResults) {
      target.__instantE2eNativeResults.read_ai_messages = [];
    }
  });
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible({ timeout: 10_000 });
  await writeFixture(page, [
    "Codex response:",
    "mermaid",
    "flowchart LR",
    "  PTY --> tmux",
    "  tmux --> xterm",
    "",
    "d2",
    "PTY -> tmux",
    "tmux -> xterm",
    "",
  ].join("\r\n"));

  await expect(page.locator(".term-diagram")).toHaveCount(2);
  await expect(page.locator('.term-diagram[data-language="mermaid"] svg')).toBeVisible();
  await expect(page.locator('.term-diagram[data-language="d2"] > svg')).toBeVisible();
});

test("renders a stripped Claude timeline while Boop has no matching visible turn", async ({ page }) => {
  await page.goto("/e2e-term.html?e2e=1");
  await page.evaluate(() => {
    const target = window as Window & { __instantE2eNativeResults?: Record<string, unknown> };
    if (target.__instantE2eNativeResults) target.__instantE2eNativeResults.read_ai_messages = [];
  });
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible({ timeout: 10_000 });
  await writeFixture(page, [
    "Committed 43d8cad6",
    "",
    "mermaid",
    "timeline",
    "    title strings-to-ids across the generations",
    "    v1 : invented it, strings(id, value UNIQUE) + fact tables with ONLY integer FKs : CREATE VIEW auto-joins every column back to text",
    "    v2 : verbatim port, intact",
    "    v3 : port + mutations table, intact",
    "    v4 : fact store keeps it (view downgraded to TEMP) : NEW runtime_graph subsystem skips it, view deferred, never lands",
    "    v5 early : dropped by deliberate doctrine",
    "    v5 now : revived 2026-07-12, interned BY DEFAULT, rel_name_txt views live at HEAD today",
    "    v6 : new compiler born without it, task 4 queued",
    "",
    "Three things worth keeping from the dig:",
  ].join("\r\n"));

  const timeline = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(timeline.locator("svg")).toBeVisible();
  await expect(timeline).toContainText("strings-to-ids across the generations");
  await expect(timeline).toContainText("v6");
});

test("opens a viewport-tall D2 target and retains clicked source entries", async ({ page }, testInfo) => {
  await openTerminal(page, "e2e=1&noHarness=1");
  const d2Lines = Array.from({ length: 28 }, (_, index) => `node_${index} -> node_${index + 1}: step ${index + 1}`);
  await writeFixture(page, [
    "```d2",
    ...d2Lines,
    "```",
    "```mermaid",
    "flowchart LR",
    "  source --> preview",
    "```",
  ].join("\r\n"));

  const d2 = page.locator('.term-diagram[data-language="d2"]');
  await expect(d2).toBeVisible();
  const d2Point = await visibleDiagramPoint(d2);
  await page.mouse.click(d2Point.x, d2Point.y);

  const lightbox = page.locator('.diagram-lightbox[data-language="d2"]');
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByText("1/1", { exact: true })).toBeVisible();
  await lightbox.locator(".diagram-lightbox-debug summary").click();
  await expect(lightbox.locator(".diagram-lightbox-debug")).toContainText("terminal buffer");
  await expect(lightbox.locator(".diagram-lightbox-debug pre")).toContainText("node_0 -> node_1");
  await lightbox.getByTitle("Copy diagram source").click();
  await expect(lightbox.getByTitle("Copy diagram source")).toHaveText("Copied");
  await page.keyboard.press("Escape");

  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(mermaid).toBeVisible();
  await rightClickVisibleDiagram(page, mermaid);
  await page.locator(".ctx-item", { hasText: "Expand Mermaid diagram" }).click();
  const second = page.locator('.diagram-lightbox[data-language="mermaid"]');
  await expect(second.getByText("2/2", { exact: true })).toBeVisible();
  const mermaidSvg = second.locator(".diagram-vector-stage > svg");
  const mermaidViewBox = await mermaidSvg.getAttribute("viewBox");
  await second.getByTitle(/zoom in/i).click();
  await expect.poll(() => mermaidSvg.getAttribute("viewBox")).not.toBe(mermaidViewBox);
  await expect(second.locator(".panzoom-canvas")).toHaveCount(0);
  await second.getByTitle("Previous clicked diagram").click();
  await expect(page.locator('.diagram-lightbox[data-language="d2"]')).toBeVisible();
  await expect(page.locator(".diagram-lightbox-debug pre")).toContainText("node_27 -> node_28");
  await testInfo.attach("large-d2-retained-lightbox", {
    body: await page.locator(".diagram-lightbox").screenshot(),
    contentType: "image/png",
  });
});

test("does not infer D2 from Rust return types and arrow comments", async ({ page }) => {
  await openTerminal(page);
  await writeFixture(page, [
    "struct Pair(u64);                    // (u:u32)<<32 | v:u32",
    "impl Pair { fn new(u:u32,v:u32)->Self; fn u(&self)->u32; fn v(&self)->u32 }",
    "struct Loaded { edges:u64, index: FxHashMap<u32, Vec<u32>>, // y -> [z]",
    "derived: FxHashSet<Pair>, delta: Vec<Pair> }",
    "",
    "trait Operator { fn on_batch(&mut self, rows: &[Pair], out: &mut Vec<Pair>); }",
    "struct Node { op: Box<dyn Operator>, downstream: Vec<usize> }",
  ].join("\r\n"));

  await expect(page.locator(".term-diagram")).toHaveCount(0);
});

test("waits for slow Boop turns before rendering fence-stripped Mermaid", async ({ page }) => {
  await page.goto("/e2e-term.html?e2e=1");
  await page.evaluate(() => {
    const target = window as Window & {
      __instantE2eNativeResults?: Record<string, unknown>;
      __resolveBoopTurns?: () => void;
    };
    if (target.__instantE2eNativeResults) {
      let resolveTurns!: (turns: unknown[]) => void;
      const pending = new Promise<unknown[]>((resolve) => { resolveTurns = resolve; });
      target.__instantE2eNativeResults.boop_turns = () => pending;
      target.__resolveBoopTurns = () => resolveTurns([{
          session: "e2e-codex-1",
          harness: "codex",
          turn: 900,
          role: "assistant",
          ts: Date.now(),
          said: [
            "```mermaid",
            "flowchart TB",
            "  subgraph round[one round, repeated 2580 times]",
            "    delta --> join",
            "  end",
            "```",
          ].join("\n"),
        }]);
    }
  });
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible({ timeout: 10_000 });
  await writeFixture(page, [
    "mermaid",
    "flowchart TB",
    "  subgraph round[one round, repeated 2580 times]",
    "    delta --> join",
    "  end",
  ].join("\r\n"));

  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await page.waitForTimeout(500);
  await expect(mermaid).toHaveCount(0);
  await page.evaluate(() => {
    (window as Window & { __resolveBoopTurns?: () => void }).__resolveBoopTurns?.();
  });
  await expect(mermaid.locator("svg")).toBeVisible({ timeout: 4000 });
  await expect(mermaid).toContainText("one round, repeated 2580 times");
});

test("keeps later scrolled prose outside the Boop Mermaid source", async ({ page }) => {
  await openTerminal(page);
  await writeFixture(page, scrolledMermaidOutput);
  await settleScroll(page);

  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(mermaid).toContainText("PTY");
  await expect(mermaid).toContainText("Mermaid");
  await expect(mermaid).not.toContainText("This prose arrived later");
  await expect(mermaid).not.toHaveClass(/term-diagram-error/);
});

test("renders full Boop diagrams when the viewport contains only one source line", async ({ page }) => {
  await openTerminal(page);
  await writeFixture(page, "tmux -> xterm\r\nPTY --> tmux");
  await settleScroll(page);

  const d2 = page.locator('.term-diagram[data-language="d2"]');
  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(d2).toContainText("D2 renderer");
  await expect(mermaid).toContainText("Mermaid");
});

test("clips projected source rows when wrapped Boop lines reach the viewport bottom", async ({ page }) => {
  await openTerminal(page);
  await page.evaluate(() => window.__term!.resize(12, 24));
  await writeFixture(page, renderedCliOutput("Codex"));
  await settleScroll(page);

  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(mermaid).toContainText("Mermaid");
  await expect(mermaid).toHaveAttribute("data-source-rows", "2");
  await expect(mermaid).toHaveAttribute("data-diagram-locator", "boop:e2e-codex-1:53");
});

test("hides a committed diagram while new PTY text is arriving", async ({ page }) => {
  await openTerminal(page);
  await page.evaluate(() => window.__term!.resize(80, 12));
  await writeFixture(page, renderedCliOutput("Codex"));
  await settleScroll(page);

  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(mermaid).toContainText("Mermaid");
  const result = await page.evaluate(async () => {
    const hiddenSamples: boolean[] = [];
    const root = document.querySelector<HTMLElement>(".term-diagrams")!;
    let mutations = 0;
    const observer = new MutationObserver((records) => { mutations += records.length; });
    observer.observe(root, { childList: true, subtree: true });
    for (let index = 0; index < 20; index++) {
      window.__term!.write(`\rworking ${index}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      hiddenSamples.push(root.hidden);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    observer.disconnect();
    return { hiddenSamples, visibleAfterIdle: !root.hidden, mutations };
  });

  expect(result).toEqual({ hiddenSamples: Array(20).fill(true), visibleAfterIdle: true, mutations: 0 });

  await page.screenshot({ path: "artifacts/v2-overlay-before-scroll.png", fullPage: true });
  const tether = await page.evaluate(async () => {
    const before = document.querySelector<HTMLElement>('.term-diagram[data-language="mermaid"]')!;
    const beforeKey = before.dataset.diagramKey;
    const beforeTop = before.getBoundingClientRect().top;
    window.__term!.scroll(-2);
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const immediate = document.querySelector<HTMLElement>('.term-diagram[data-language="mermaid"]')!;
    const immediateTop = immediate.getBoundingClientRect().top;
    await new Promise((resolve) => setTimeout(resolve, 400));
    const visibleAfterScrollIdle = !document.querySelector<HTMLElement>(".term-diagrams")!.hidden;
    const afterScrollIdle = document.querySelector<HTMLElement>('.term-diagram[data-language="mermaid"]')!;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const afterDebounce = document.querySelector<HTMLElement>('.term-diagram[data-language="mermaid"]')!;
    return {
      movedImmediately: immediateTop !== beforeTop,
      keys: [beforeKey, immediate.dataset.diagramKey, afterScrollIdle.dataset.diagramKey, afterDebounce.dataset.diagramKey],
      sameAfterImmediateMove: immediate === before,
      visibleAfterScrollIdle,
      sameAfterScrollIdle: afterScrollIdle === before,
      sameAfterDebouncedScan: afterDebounce === before,
    };
  });
  await page.screenshot({ path: "artifacts/v2-overlay-after-scroll.png", fullPage: true });
  expect(new Set(tether.keys).size).toBe(1);
  expect(tether).toEqual({
    movedImmediately: true,
    keys: tether.keys,
    sameAfterImmediateMove: true,
    visibleAfterScrollIdle: true,
    sameAfterScrollIdle: true,
    sameAfterDebouncedScan: true,
  });
});

const escapedLabelFlowchart = [
  "```mermaid",
  "flowchart LR",
  '  parse["parse &lt; lex"] --> lower',
  '  lower --> emit["emit &lt; link"]',
  "  emit --> run",
  "  run --> report",
  "```",
].join("\r\n");

test("renders a flowchart whose quoted labels carry escaped angle brackets", async ({ page }) => {
  await openTerminal(page);
  await writeFixture(page, escapedLabelFlowchart);

  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(mermaid.locator("svg")).toBeVisible();
  await expect(mermaid).not.toHaveClass(/term-diagram-error/);
  await expect(mermaid).toContainText("parse < lex");
});

test("names the failing request when the Mermaid bundle cannot be fetched", async ({ page }) => {
  await page.route(/mermaid\.min/, async (route) => {
    // The module import that carries the bundle URL keeps its ?url suffix. Only
    // the lazy script element request is cut, which is what a dev server that
    // stopped after the page loaded does to the terminal overlay.
    if (route.request().url().includes("?url")) return route.continue();
    return route.abort("connectionrefused");
  });
  await openTerminal(page);
  await writeFixture(page, escapedLabelFlowchart);

  const failed = page.locator(".term-diagram-error");
  await expect(failed).toBeVisible();
  await expect(failed).toContainText("mermaid.min");
  await expect(failed).toContainText("did not load:");
  await expect(failed).not.toHaveText("Mermaid bundle failed to load");
});
