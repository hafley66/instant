import { expect, test } from "@playwright/test";

test("SVG links survive the pan overlay and stationary clicks open them", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/e2e-svg-link.html");
  const stage = page.locator(".svg-document-stage");
  await expect(stage).toBeVisible();
  const object = page.locator(".svg-document-stage object");
  await expect.poll(() => object.evaluate((node: HTMLObjectElement) => node.contentDocument?.readyState)).toBe("complete");
  const linkedGeometry = await object.evaluate((node: HTMLObjectElement) => ({
    anchors: node.contentDocument?.querySelectorAll("a").length,
    paths: Array.from(node.contentDocument?.querySelectorAll("path") ?? [], (path) => path.getAttribute("d")),
    href: node.contentDocument?.querySelector("a")?.getAttribute("href"),
  }));
  expect(linkedGeometry).toEqual({
    anchors: 1,
    href: "vscode://file/tmp/svg-link-target.ts:144",
    paths: [
      "M 220 170 L 580 170 L 550 310 L 190 310 Z",
      "M 400 310 L 400 430 L 470 390 M 400 430 L 330 390",
    ],
  });

  await page.mouse.move(400, 250);
  await expect(stage).toHaveCSS("cursor", "pointer");
  await page.mouse.click(400, 250);
  await expect.poll(() => page.evaluate(() => window.__openedSvgHref)).toBe("vscode://file/tmp/svg-link-target.ts:144");
  expect(errors).toEqual([]);

  const receipt = testInfo.outputPath("svg-link-click.png");
  await page.screenshot({ path: receipt, fullPage: true });
  await testInfo.attach("svg-link-click", { path: receipt, contentType: "image/png" });
});

test("SVG media preview shows the live render probe", async ({ page }) => {
  await page.goto("/e2e-svg-link.html");
  await expect(page.locator(".svg-document-stage object")).toHaveCount(1);
  await expect.poll(() => page.locator(".svg-document-stage object").evaluate((node: HTMLObjectElement) => node.contentDocument?.readyState)).toBe("complete");

  const probe = page.getByRole("region", { name: "live render probe" });
  await expect(probe).toBeVisible();
  await expect(probe.getByTestId("live-probe-dom-count")).toHaveText(/^DOM [1-9]\d*$/);
  await expect(probe.getByTestId("live-probe-renders")).toContainText("FileImageViewer 1");
  await expect(probe.getByTestId("live-probe-renders")).toContainText(/SvgDocumentViewer [1-9]\d*/);
  await expect(probe.getByTestId("live-probe-events")).toContainText(/render:SvgDocumentViewer/);
  await expect(page).toHaveScreenshot("svg-link-probe.png", { animations: "disabled" });
});
