import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

test("queues a complete Boop table and a terminal selection for the next prompt", async ({ page }) => {
  await page.goto("/e2e-term.html?e2e=1&structured=1");
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible();
  await page.evaluate(() => {
    const target = window as Window & { __instantE2eNativeResults?: Record<string, unknown>; __writes?: Array<{ data: string }> };
    target.__writes = [];
    target.__instantE2eNativeResults!.write_pty = (args: unknown) => target.__writes!.push(args as { data: string });
    window.__term!.write(`\x1b[2J\x1b[H${"\r\n".repeat(6)}${[
      "STRUCTURED TURN START",
      "| Item | Visibility |",
      "| --- | --- |",
      "| alpha | visible |",
      "| beta | hidden |",
      "- first visible item",
      "- second visible item",
      "STRUCTURED TURN END",
    ].join("\r\n")}`);
  });

  const tableCheck = page.locator(".term-context-table-check");
  await expect(tableCheck).toHaveCount(1);
  const wall = await page.evaluate(() => window.__term!.point(7, 0));
  const box = await tableCheck.boundingBox();
  expect(box!.x).toBeLessThan(wall!.x);
  await tableCheck.check();
  await expect(page.locator('.term-context-queue textarea')).toHaveValue([
    "| Item | Visibility |",
    "| --- | --- |",
    "| alpha | visible |",
    "| beta | hidden |",
  ].join("\n"));

  const start = await page.evaluate(() => window.__term!.point(11, 2));
  const end = await page.evaluate(() => window.__term!.point(11, 20));
  await page.mouse.move(start!.x, start!.y);
  await page.mouse.down();
  await page.mouse.move(end!.x, end!.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".term-context-selection-add")).toBeVisible();
  await page.locator(".term-context-selection-add").click();
  await expect(page.locator('.term-context-queue textarea')).toHaveCount(2);
  await page.screenshot({ path: resolve("artifacts/v2-terminal-context-queue.png"), fullPage: true });

  await page.getByRole("button", { name: "Paste into prompt" }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { __writes?: Array<{ data: string }> }).__writes?.at(-1)?.data))
    .toContain("[turn e2e-codex-1:301]");
  await expect(page.locator(".term-context-queue")).toBeHidden();
  await page.screenshot({ path: resolve("artifacts/v2-terminal-context-pasted.png"), fullPage: true });
});

test("keeps the existing diagram mounted while scroll repaint is debounced", async ({ page }) => {
  await page.goto("/e2e-term.html?e2e=1");
  await page.getByTestId("open-term").click();
  await page.evaluate(() => window.__term!.write(`\x1b[2J\x1b[H${[
    "```mermaid", "flowchart LR", "PTY --> tmux", "tmux --> xterm", "```",
  ].join("\r\n")}`));
  const diagram = page.locator(".term-diagram");
  await expect(diagram).toHaveCount(1);
  await page.evaluate(() => window.__term!.scroll(-2));
  await expect(page.locator(".term-diagrams")).toBeVisible();
  await expect(diagram).toHaveCount(1);
  await page.screenshot({ path: resolve("artifacts/v2-diagram-debounced-scroll.png"), fullPage: true });
});
