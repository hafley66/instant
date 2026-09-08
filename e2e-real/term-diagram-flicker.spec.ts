// The diagram overlay must survive a talking pane. A real tmux pane paints one
// fenced mermaid block and then streams "working N" writes under it, the way a
// harness prints progress. Receipts: the overlay root is never hidden across
// the whole stream, the mermaid element keeps its identity and its
// data-diagram-key, and the root gains no child mutations.
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, closeTabs, killAllSessions, shot, silentSessionPane, typeLine } from "./0_real";

// Filler above the fence keeps the opener off row 0: tmux paints its copy-mode
// position indicator there, and a fence opener sharing that row stops reading
// as one (src/0_terminalDiagrams.ts:127).
const BODY = [
  "Codex response:",
  "",
  "```mermaid",
  "flowchart LR",
  "  PTY --> tmux",
  "  tmux --> xterm",
  "  xterm --> Mermaid",
  "```",
  "",
].join("\n");

const dirs: string[] = [];

test.afterEach(async ({ page }) => {
  await closeTabs(page);
  killAllSessions();
});

test.afterAll(() => {
  killAllSessions();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("keeps the root visible and the element stable while streaming text arrives", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "diagram-flicker-"));
  dirs.push(dir);
  await boot(page);
  const session = await silentSessionPane(page, dir, BODY, "flowchart LR");

  const diagram = page.locator('.term-diagram[data-language="mermaid"]');
  await expect(diagram.locator("svg")).toBeVisible({ timeout: 30_000 });
  // The first paint settles before the stream starts, so a mutation counted
  // afterwards belongs to the stream.
  await page.waitForTimeout(1_500);
  await shot(page, "diagram-flicker-01-before-stream");

  // The pane prints 30 progress writes 60 ms apart, each one a carriage return
  // and a fresh "working N" on the row under the diagram.
  const watch = page.evaluate(() => new Promise<{
    hiddenSamples: number; replaces: number; reKeys: number; beforeKey: string; sameElement: boolean; connected: boolean;
  }>((resolve) => {
    const host = [...document.querySelectorAll<HTMLElement>(".term-host")]
      .find((candidate) => candidate.getBoundingClientRect().width > 0)!;
    const root = host.querySelector<HTMLElement>(".term-diagrams")!;
    const before = host.querySelector<HTMLElement>('.term-diagram[data-language="mermaid"]')!;
    const beforeKey = before.dataset.diagramKey ?? "";
    let hiddenSamples = 0;
    let replaces = 0;
    let reKeys = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type !== "childList") continue;
        replaces += record.addedNodes.length + record.removedNodes.length;
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.dataset?.diagramKey && node.dataset.diagramKey !== beforeKey) reKeys += 1;
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    const tick = setInterval(() => { if (root.hidden) hiddenSamples += 1; }, 50);
    setTimeout(() => {
      clearInterval(tick);
      observer.disconnect();
      const after = host.querySelector<HTMLElement>('.term-diagram[data-language="mermaid"]');
      resolve({
        hiddenSamples,
        replaces,
        reKeys,
        beforeKey,
        sameElement: after === before,
        connected: before.isConnected,
      });
    }, 4_000);
  }));
  typeLine(session, "for i in $(seq 0 29); do printf '\\rworking %d' \"$i\"; sleep 0.06; done");
  const result = await watch;

  await expect(page.locator(".xterm-rows")).toContainText("working 29");
  await shot(page, "diagram-flicker-02-after-stream");
  expect(result.hiddenSamples).toBe(0);
  expect(result.replaces).toBe(0);
  expect(result.reKeys).toBe(0);
  expect(result.sameElement).toBe(true);
  expect(result.connected).toBe(true);
  const afterKey = await diagram.getAttribute("data-diagram-key");
  expect(afterKey).toBe(result.beforeKey);
});
