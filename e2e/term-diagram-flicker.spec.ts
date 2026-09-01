import { test, expect, type Page } from "@playwright/test";

// Fix assertion for the terminal diagram overlay flicker lane. This test now
// asserts the fixed behavior: streaming text never hides the overlay root and
// the mermaid element keeps a stable data-diagram-key (and is never re-placed)
// when its buffer rows move. The plan names the guard for each.
//
// Written repro steps (run with `pnpm test:e2e` against the dev page):
//   1. openTerminal: boot /e2e-term.html with projection enabled.
//   2. writeFixture: paint a fenced mermaid diagram.
//   3. Expect the diagram to render (sanity).
//   4. Instrument ".term-diagrams": sample root.hidden after every streaming
//      write and record every childList mutation and every re-minted
//      data-diagram-key.
//   5. Stream "working N" writes while sampling.
//   6. Assert the flicker is gone: zero hidden root samples, zero re-keys, and
//      a stable before/after data-diagram-key.

type TermHooks = {
  write: (data: string) => void;
  point: (row: number, col: number) => { x: number; y: number } | null;
  dims: () => { cols: number; rows: number } | null;
};

declare global {
  interface Window {
    __term?: TermHooks;
  }
}

const diagramOutput = [
  "Codex response:",
  "```mermaid",
  "flowchart LR",
  "  PTY --> tmux",
  "  tmux --> xterm",
  "  xterm --> Mermaid",
  "```",
  "",
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

test("keeps the root visible and the element stable while streaming text arrives", async ({ page }, testInfo) => {
  await openTerminal(page);
  await writeFixture(page, diagramOutput);

  const diagram = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(diagram.locator("svg")).toBeVisible({ timeout: 10_000 });

  const result = await page.evaluate(async () => {
    const root = document.querySelector<HTMLElement>(".term-diagrams")!;
    const diagram = document.querySelector<HTMLElement>('.term-diagram[data-language="mermaid"]')!;
    const samples: boolean[] = [];
    let replaces = 0;
    let reKeys = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "childList") {
          replaces += record.addedNodes.length + record.removedNodes.length;
          for (const node of Array.from(record.addedNodes)) {
            if (node instanceof HTMLElement && node.dataset?.diagramKey) {
              reKeys += Number(node.dataset.diagramKey !== diagram.dataset.diagramKey);
            }
          }
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    const beforeKey = diagram.dataset.diagramKey;
    for (let index = 0; index < 30; index++) {
      window.__term!.write(`\rworking ${index}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      samples.push(root.hidden);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    observer.disconnect();
    const afterKey = document.querySelector<HTMLElement>('.term-diagram[data-language="mermaid"]')!.dataset.diagramKey;
    return { hiddenSamples: samples, replaces, reKeys, beforeKey, afterKey };
  });

  await testInfo.attach("flicker-repro-stream", {
    body: await page.locator(".term-host").screenshot(),
    contentType: "image/png",
  });

  expect(result.hiddenSamples.filter(Boolean)).toHaveLength(0);
  expect(result.replaces).toBe(0);
  expect(result.reKeys).toBe(0);
  expect(result.beforeKey).toBe(result.afterKey);
});