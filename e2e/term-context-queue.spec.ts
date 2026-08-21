import { expect, test } from "@playwright/test";
import { resolve } from "node:path";

test("an empty terminal context queue has no visible shell", async ({ page }) => {
  await page.goto("/e2e-term.html?e2e=1&structured=1");
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-context-root")).toBeAttached();
  await expect(page.locator(".term-context-queue")).toBeHidden();
});

test("queues individual Boop table rows and list items for the next prompt", async ({ page }) => {
  await page.goto("/e2e-term.html?e2e=1&structured=1");
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible();
  await expect(page.locator(".term-context-queue")).toBeHidden();
  await page.evaluate(() => {
    const target = window as Window & { __instantE2eNativeResults?: Record<string, unknown>; __writes?: Array<{ data: string }> };
    target.__writes = [];
    target.__instantE2eNativeResults!.write_pty = (args: unknown) => target.__writes!.push(args as { data: string });
    window.__term!.write(`\x1b[2J\x1b[H${"scrollback fixture\r\n".repeat(100)}${[
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

  await expect(page.locator(".xterm-rows")).toContainText("STRUCTURED TURN START");
  const tableCheck = page.locator(".term-context-structured-check");
  await expect(tableCheck).toHaveCount(5);
  expect(await page.evaluate(async () => {
    const gutter = document.querySelector(".term-context-gutter")!;
    let childMutations = 0;
    const observer = new MutationObserver((records) => {
      childMutations += records.filter((record) => record.type === "childList").length;
    });
    observer.observe(gutter, { childList: true });
    window.__term!.write("\rtyping in the prompt");
    await new Promise((resolve) => setTimeout(resolve, 160));
    observer.disconnect();
    return childMutations;
  })).toBe(0);
  expect(await page.evaluate(() => new Promise<boolean>((resolve) => {
    const gutter = document.querySelector<HTMLElement>(".term-context-gutter")!;
    const observer = new MutationObserver(() => {
      if (!gutter.hidden) return;
      observer.disconnect();
      resolve(gutter.hidden);
    });
    observer.observe(gutter, { attributes: true, attributeFilter: ["hidden"] });
    window.__term!.write("\r\nterminal output appended");
  }))).toBe(true);
  await expect(page.locator(".term-context-gutter")).toBeVisible();
  await expect(tableCheck).toHaveCount(5);
  const wall = await page.evaluate(() => window.__term!.point(7, 0));
  const box = await tableCheck.first().boundingBox();
  expect(box!.x).toBeLessThan(wall!.x);
  await tableCheck.nth(1).check();
  await tableCheck.nth(3).check();
  await expect(page.locator('.term-context-queue textarea')).toHaveCount(2);
  await expect(page.locator('.term-context-queue textarea').nth(0)).toHaveValue("| alpha | visible |");
  await expect(page.locator('.term-context-queue textarea').nth(1)).toHaveValue("- first visible item");
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
