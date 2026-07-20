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
