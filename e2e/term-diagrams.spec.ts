import { test, expect, type Page } from "@playwright/test";

type TermHooks = {
  write: (data: string) => void;
  point: (row: number, col: number) => { x: number; y: number } | null;
  resize: (cols: number, rows: number) => void;
  dims: () => { cols: number; rows: number } | null;
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

for (const harness of ["Codex", "Claude Code"] as const) {
  test(`renders plain fenced Mermaid and D2 output from ${harness}`, async ({ page }, testInfo) => {
    await openTerminal(page);
    await page.evaluate((text) => window.__term!.write(`\x1b[2J\x1b[H${text}`), output(harness));

    const diagrams = page.locator(".term-diagram");
    await expect(diagrams).toHaveCount(2);
    await expect(page.locator('.term-diagram[data-language="mermaid"] svg')).toBeVisible();
    await expect(page.locator('.term-diagram[data-language="d2"] > svg')).toBeVisible();
    await expect(page.locator('.term-diagram[data-language="mermaid"]')).toContainText("PTY");
    await expect(page.locator('.term-diagram[data-language="mermaid"]')).toContainText("xterm");
    await expect(page.locator('.term-diagram[data-language="d2"]')).toContainText("PTY");
    await expect(page.locator('.term-diagram[data-language="d2"]')).toContainText("xterm");

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
    await page.evaluate((text) => window.__term!.write(`\x1b[2J\x1b[H${text}`), renderedCliOutput(harness));

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
  await page.evaluate((text) => window.__term!.write(`\x1b[2J\x1b[H${text}`), scrolledMermaidOutput);

  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(mermaid).toContainText("PTY");
  await expect(mermaid).toContainText("Mermaid");
  await expect(mermaid).not.toContainText("This prose arrived later");
  await expect(mermaid).not.toHaveClass(/term-diagram-error/);
});

test("renders full ledger diagrams when the viewport contains only one source line", async ({ page }) => {
  await openTerminal(page);
  await page.evaluate(() => window.__term!.write("\x1b[2J\x1b[Htmux -> xterm\r\nPTY --> tmux"));

  await page.waitForTimeout(500);
  await expect(page.locator(".term-diagram")).toHaveCount(0);

  const d2 = page.locator('.term-diagram[data-language="d2"]');
  const mermaid = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(d2).toContainText("D2 renderer");
  await expect(mermaid).toContainText("Mermaid");
});
