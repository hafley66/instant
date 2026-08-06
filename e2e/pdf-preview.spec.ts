import { expect, test } from "@playwright/test";

test("PDF.js renders a canvas and selectable text", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/e2e-pdf.html");

  await expect(page.locator(".pdfViewer .page")).toHaveCount(1);
  await expect(page.locator(".pdfViewer canvas")).toBeVisible();
  await expect(page.locator(".pdfViewer .textLayer")).toContainText("Instant PDF receipt");
  await expect(page.getByText("1 pages", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);

  const receipt = testInfo.outputPath("pdfjs-preview.png");
  await page.screenshot({ path: receipt, fullPage: true });
  await testInfo.attach("pdfjs-preview", { path: receipt, contentType: "image/png" });
});
