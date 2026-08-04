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

async function openTerminal(page: Page) {
  await page.goto("/e2e-term.html?e2e=1");
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
    await expect(page.locator('.term-diagram[data-language="d2"]')).toContainText("PTY");
    await expect(page.locator('.term-diagram[data-language="d2"]')).toContainText("xterm");
    const inlineBoxes = await page.locator(".term-diagram > svg").evaluateAll((svgs) => svgs.map((svg) => {
      const box = svg.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height) };
    }));
    expect(inlineBoxes).toHaveLength(2);
    expect(inlineBoxes.every(({ width, height }) => width > 500 && height > 40)).toBe(true);

    await page.locator('.term-diagram[data-language="d2"]').click();
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
    const beforeTop = before.getBoundingClientRect().top;
    let forwardedWheelCount = 0;
    document.querySelector<HTMLElement>(".xterm")!.addEventListener("wheel", () => forwardedWheelCount++, { once: true });
    before.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      deltaY: -100,
    }));
    const hiddenOnWheel = document.querySelector<HTMLElement>(".term-diagrams")!.hidden;
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
      forwardedWheelCount,
      hiddenOnWheel,
      movedImmediately: immediateTop !== beforeTop,
      sameAfterImmediateMove: immediate === before,
      visibleAfterScrollIdle,
      sameAfterScrollIdle: afterScrollIdle === before,
      sameAfterDebouncedScan: afterDebounce === before,
    };
  });
  expect(tether).toEqual({
    forwardedWheelCount: 1,
    hiddenOnWheel: true,
    movedImmediately: true,
    sameAfterImmediateMove: true,
    visibleAfterScrollIdle: true,
    sameAfterScrollIdle: true,
    sameAfterDebouncedScan: true,
  });
});
