import { expect, test } from "@playwright/test";

test("records text renderer mount and scroll measurements", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/e2e-text-render-bench.html");
  await page.locator("html[data-done='true']").waitFor();
  const report = JSON.parse(await page.locator("#results").innerText());

  await testInfo.attach("text-render-benchmark.json", {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: "application/json",
  });
  const receipt = testInfo.outputPath("text-render-benchmark.png");
  await page.screenshot({ path: receipt, fullPage: true });
  await testInfo.attach("text-render-benchmark", { path: receipt, contentType: "image/png" });
  console.log(JSON.stringify(report.summary, null, 2));

  expect(errors).toEqual([]);
  expect(report.samples).toEqual([
    { bytes: 4116, lines: 49, name: "4 KiB" },
    { bytes: 262164, lines: 3121, name: "256 KiB" },
    { bytes: 1048656, lines: 12484, name: "1 MiB" },
  ]);
  expect(report.summary).toHaveLength(9);
});
