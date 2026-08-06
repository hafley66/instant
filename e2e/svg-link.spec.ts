import { expect, test } from "@playwright/test";

test("SVG links survive the pan overlay and stationary clicks open them", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/e2e-svg-link.html");
  const stage = page.locator(".svg-document-stage");
  await expect(stage).toBeVisible();

  await page.mouse.move(400, 250);
  await expect(stage).toHaveCSS("cursor", "pointer");
  await page.mouse.click(400, 250);
  await expect.poll(() => page.evaluate(() => window.__openedSvgHref)).toBe("file:///tmp/svg-link-target.ts#L144");
  expect(errors).toEqual([]);

  const receipt = testInfo.outputPath("svg-link-click.png");
  await page.screenshot({ path: receipt, fullPage: true });
  await testInfo.attach("svg-link-click", { path: receipt, contentType: "image/png" });
});
