import { test, expect } from "@playwright/test";

test("Paint layers revive after save, Cmd+W, and Cmd+Shift+T", async ({ page }) => {
  await page.goto("/e2e-paint.html?e2e=1");
  await expect(page.locator(".dv-default-tab-content", { hasText: "Sessions" })).toBeVisible();

  await page.getByTestId("open-first").click();
  const firstTab = page.locator(".dv-default-tab").filter({ hasText: "paint-first.png" });
  await expect(firstTab).toHaveCount(1);

  const paintFrame = page.frames().find((frame) => frame.url().includes("/vendor/miniPaint/index.html"));
  expect(paintFrame).toBeTruthy();
  await expect
    .poll(() =>
      paintFrame!.evaluate(() => {
        const layers = (window as Window & { Layers?: { get_layers?: () => unknown[] } }).Layers;
        return layers?.get_layers?.().length ?? -1;
      }),
    )
    .toBeGreaterThan(0);
  const layerCountBeforeClose = await paintFrame!.evaluate(() => {
    const layers = (window as Window & { Layers?: { get_layers?: () => unknown[] } }).Layers;
    return layers?.get_layers?.().length ?? -1;
  });
  expect(layerCountBeforeClose).toBeGreaterThan(0);

  const insertLayer = paintFrame!.locator("#insert_layer");
  await expect(insertLayer).toBeVisible();
  await insertLayer.click();
  await insertLayer.click();
  await expect
    .poll(() =>
      paintFrame!.evaluate(() => {
        const layers = (window as Window & { Layers?: { get_layers?: () => unknown[] } }).Layers;
        return layers?.get_layers?.().length ?? -1;
      }),
    )
    .toBe(3);
  const savedLayerCount = 3;

  await page.getByRole("button", { name: "save", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __instantE2eNativeCalls?: string[] }).__instantE2eNativeCalls ?? []))
    .toContain("save_meme");

  await page.keyboard.press("Meta+W");
  await expect(page.locator(".dv-default-tab").filter({ hasText: "paint-first.png" })).toHaveCount(0);

  await page.keyboard.press("Meta+Shift+T");
  await expect(page.locator(".dv-default-tab").filter({ hasText: "paint-first.png" })).toHaveCount(1);
  await expect.poll(() => page.frames().some((frame) => frame.url().includes("/vendor/miniPaint/index.html"))).toBe(true);
  const revivedFrame = page.frames().filter((frame) => frame.url().includes("/vendor/miniPaint/index.html")).at(-1);
  expect(revivedFrame).toBeTruthy();
  await expect
    .poll(() =>
      revivedFrame!.evaluate(() => {
        const layers = (window as Window & { Layers?: { get_layers?: () => unknown[] } }).Layers;
        return layers?.get_layers?.().length ?? -1;
      }),
    )
    .toBe(savedLayerCount);

  const revivedInsertLayer = revivedFrame!.locator("#insert_layer");
  await revivedInsertLayer.click();
  await page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("select.paint-recent").selectOption("/tmp/paint-second.png");
  await expect
    .poll(() =>
      revivedFrame!.evaluate(() => {
        const layers = (window as Window & { Layers?: { get_layers?: () => unknown[] } }).Layers;
        return layers?.get_layers?.().length ?? -1;
      }),
    )
    .toBe(1);
});

test("Paint caption panel creates top and bottom meme text layers", async ({ page }) => {
  await page.goto("/e2e-paint.html?e2e=1");
  await page.getByTestId("open-first").click();
  const panel = page.getByTestId("meme-captions");
  await expect(panel).toBeVisible();
  await panel.getByLabel("top text").fill("TOP TEXT");
  await panel.getByLabel("bottom text").fill("BOTTOM TEXT");
  await panel.getByLabel("top font size").fill("72");
  await panel.getByLabel("top fill color").fill("#ff0000");
  await panel.locator("fieldset").nth(0).getByRole("checkbox", { name: "bold" }).check();
  await panel.getByRole("button", { name: "add caption layers" }).click();

  const paintFrame = page.frames().find((frame) => frame.url().includes("/vendor/miniPaint/index.html"));
  await expect.poll(() => paintFrame!.evaluate(() => {
    const layers = (window as Window & { Layers?: { get_layers?: () => Array<{ name: string; data?: Array<Array<{ text: string }>> }> } }).Layers;
    return (layers?.get_layers?.() ?? []).map((layer) => [layer.name, layer.data?.[0]?.[0]?.text, layer.data?.[0]?.[0]?.meta]);
  })).toContainEqual(["Meme top caption", "TOP TEXT", expect.objectContaining({ size: 72, fill_color: "#ff0000", bold: true })]);
  await expect.poll(() => paintFrame!.evaluate(() => {
    const layers = (window as Window & { Layers?: { get_layers?: () => Array<{ name: string; data?: Array<Array<{ text: string }>> }> } }).Layers;
    return (layers?.get_layers?.() ?? []).map((layer) => [layer.name, layer.data?.[0]?.[0]?.text]);
  })).toContainEqual(["Meme bottom caption", "BOTTOM TEXT"]);
  await panel.screenshot({ path: "test-results/paint-meme-captions.png" });
});

test("Rules opens with Metrics as secondary navigation", async ({ page }) => {
  await page.goto("/e2e-paint.html?e2e=1");
  const rulesButton = page.locator("#rules-toggle");
  await expect(rulesButton).toBeVisible();

  await rulesButton.click();
  await expect(page.locator(".rules-panel")).toBeVisible();

  await expect(rulesButton.locator(".actbar-exp")).toHaveCount(1);
  await rulesButton.locator(".actbar-exp").click();
  await expect(page.locator("#rules-metrics-child")).toBeVisible();
  await expect(page.locator("#rules-table")).toBeVisible();
});

test("rail context menu hides and restores navigation items", async ({ page }) => {
  await page.goto("/e2e-paint.html?e2e=1");
  const rulesButton = page.locator("#rules-toggle");
  await rulesButton.click({ button: "right" });

  const hideRules = page.locator(".ctx-item", { hasText: "✓ Rules" });
  await expect(hideRules).toBeVisible();
  await hideRules.click();
  await expect(rulesButton).toHaveCount(0);

  await page.locator("#sessions-toggle").dispatchEvent("contextmenu", {
    bubbles: true,
    button: 2,
    clientX: 16,
    clientY: 16,
  });
  const restoreRules = page.locator(".ctx-item", { hasText: "Rules" });
  await expect(restoreRules).toBeVisible();
  await restoreRules.click();
  await expect(page.locator("#rules-toggle")).toBeVisible();
});
