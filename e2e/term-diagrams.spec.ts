import { test, expect, type Page } from "@playwright/test";

type TermHooks = {
  write: (data: string) => void;
  point: (row: number, col: number) => { x: number; y: number } | null;
  resize: (cols: number, rows: number) => void;
  dims: () => { cols: number; rows: number } | null;
  scroll: (lines: number) => void;
};

declare global {
  interface Window {
    __term?: TermHooks;
  }
}

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
    await expect(expanded.getByTitle("Zoom in")).toBeVisible();
    await expect(expanded.getByTitle("Reset zoom and pan")).toBeVisible();
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

  test(`matches ${harness} viewport lines to ledger Mermaid and D2`, async ({ page }) => {
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
});

test("renders explicit terminal fences while the AI ledger has no matching visible message", async ({ page }) => {
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
  await expect(page.locator(".diagram-lightbox")).toHaveCount(0);
  await rightClickVisibleDiagram(page, d2);
  await page.locator(".ctx-item", { hasText: "Expand D2 diagram" }).click();

  const lightbox = page.locator('.diagram-lightbox[data-language="d2"]');
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator(".diagram-lightbox-count")).toHaveText("1/1");
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
  await expect(second.locator(".diagram-lightbox-count")).toHaveText("2/2");
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

test("waits for a slow AI ledger before rendering fence-stripped Mermaid", async ({ page }) => {
  await page.goto("/e2e-term.html?e2e=1");
  await page.evaluate(() => {
    const target = window as Window & {
      __instantE2eNativeResults?: Record<string, unknown>;
      __resolveDiagramLedger?: () => void;
    };
    if (target.__instantE2eNativeResults) {
      let resolveLedger!: (messages: unknown[]) => void;
      const pending = new Promise<unknown[]>((resolve) => { resolveLedger = resolve; });
      target.__instantE2eNativeResults.read_ai_messages = () => pending;
      target.__resolveDiagramLedger = () => resolveLedger([{
          editor: "codex",
          session_id: "e2e-codex-1",
          id: "slow-ledger-diagram",
          seq: 1,
          role: "assistant",
          ts: Date.now(),
          preview: "one round, repeated 2580 times",
          text: [
            "```mermaid",
            "flowchart TB",
            "  subgraph round[one round, repeated 2580 times]",
            "    delta --> join",
            "  end",
            "```",
          ].join("\n"),
          locator: "codex:/tmp/slow-ledger.jsonl#L1",
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
    (window as Window & { __resolveDiagramLedger?: () => void }).__resolveDiagramLedger?.();
  });
  await expect(mermaid.locator("svg")).toBeVisible({ timeout: 4000 });
  await expect(mermaid).toContainText("one round, repeated 2580 times");
});

test("keeps later scrolled prose outside the ledger Mermaid source", async ({ page }) => {
  await openTerminal(page);
  await writeFixture(page, scrolledMermaidOutput);
  await settleScroll(page);

  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(mermaid).toContainText("PTY");
  await expect(mermaid).toContainText("Mermaid");
  await expect(mermaid).not.toContainText("This prose arrived later");
  await expect(mermaid).not.toHaveClass(/term-diagram-error/);
});

test("renders full ledger diagrams when the viewport contains only one source line", async ({ page }) => {
  await openTerminal(page);
  await writeFixture(page, "tmux -> xterm\r\nPTY --> tmux");
  await settleScroll(page);

  await page.waitForTimeout(500);
  expect(await page.locator(".term-diagram").count()).toBe(0);

  const d2 = page.locator('.term-diagram[data-language="d2"]');
  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(d2).toContainText("D2 renderer");
  await expect(mermaid).toContainText("Mermaid");
});

test("covers physical terminal rows used by wrapped ledger source lines", async ({ page }) => {
  await openTerminal(page);
  await page.evaluate(() => window.__term!.resize(12, 24));
  await writeFixture(page, renderedCliOutput("Codex"));
  await settleScroll(page);

  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(mermaid).toContainText("Mermaid");
  await expect(mermaid).toHaveAttribute("data-source-rows", "8");
});

test("does not repaint the committed diagram during PTY writes", async ({ page }) => {
  await openTerminal(page);
  await page.evaluate(() => window.__term!.resize(80, 12));
  await writeFixture(page, renderedCliOutput("Codex"));
  await settleScroll(page);

  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(mermaid).toContainText("Mermaid");
  const result = await page.evaluate(async () => {
    const samples: boolean[] = [];
    const root = document.querySelector<HTMLElement>(".term-diagrams")!;
    let mutations = 0;
    const observer = new MutationObserver((records) => { mutations += records.length; });
    observer.observe(root, { childList: true, subtree: true });
    for (let index = 0; index < 30; index++) {
      window.__term!.write(`\rworking ${index}`);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const diagram = root?.querySelector<HTMLElement>('.term-diagram[data-language="mermaid"]');
      const svg = diagram?.querySelector<SVGElement>("svg");
      const box = svg?.getBoundingClientRect();
      samples.push(Boolean(root && !root.hidden && diagram?.textContent?.includes("Mermaid") && box?.width && box.height));
    }
    observer.disconnect();
    return { samples, mutations };
  });

  expect(result).toEqual({ samples: Array(30).fill(true), mutations: 0 });

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
