import { expect, test } from "@playwright/test";

test("Monaco mounts in isolation, exposes signal state, edits, and saves", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/e2e-monaco-preview.html?e2e=1");
  await expect(page.locator(".monaco-code-viewer[data-status=ready] .monaco-editor")).toBeVisible();
  await expect(page.locator(".view-lines")).toContainText("renderer");
  await page.locator(".view-lines").click();
  await page.keyboard.press("Meta+End");
  await page.keyboard.type("\n// edited in Instant");
  await page.keyboard.press("Control+S");
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __instantE2eNativeCalls?: string[] }).__instantE2eNativeCalls ?? [],
  )).toContain("save_text");
  const state = await page.evaluate(() =>
    (window as Window & { __monacoState?: () => unknown }).__monacoState?.(),
  );
  expect(state).toEqual({
    "/tmp/instant-monaco/sample.ts": {
      path: "/tmp/instant-monaco/sample.ts",
      status: "ready",
      version: 21,
      savedVersion: 21,
    },
  });
  expect(errors).toEqual([]);
  const receipt = testInfo.outputPath("monaco-isolated.png");
  await page.screenshot({ path: receipt, fullPage: true });
  await testInfo.attach("monaco-isolated", { path: receipt, contentType: "image/png" });
});

test("a source path opens Monaco inside a live Instant dock tab", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/e2e-monaco-tab.html?e2e=1");
  const openSource = page.getByTestId("open-source");
  await openSource.click();
  await openSource.evaluate((element) => element.remove());
  await expect(page.locator(".dv-default-tab", { hasText: "live-tab.ts" })).toBeVisible();
  await expect(page.locator(".dv-host-scroll .monaco-code-viewer[data-status=ready]")).toBeVisible();
  await expect(page.locator(".dv-host-scroll .view-lines")).toContainText("renderInInstantTab");
  expect(errors).toEqual([]);
  const receipt = testInfo.outputPath("monaco-live-tab.png");
  await page.screenshot({ path: receipt, fullPage: true });
  await testInfo.attach("monaco-live-tab", { path: receipt, contentType: "image/png" });
});
