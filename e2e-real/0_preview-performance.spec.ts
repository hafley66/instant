import { expect, test } from "@playwright/test";
import { writeFileSync, rmSync } from "node:fs";
import { boot, cmdClickToken, killAllSessions, mkRepo, openSessionTab, typeLine } from "./0_real";

const dirs: string[] = [];
test.afterEach(() => killAllSessions());
test.afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

test("large SVG opens and pans with bounded frame work", async ({ page }, testInfo) => {
  const nodes = Array.from({ length: 6000 }, (_, i) => {
    const x = i % 30 * 180, y = Math.floor(i / 30) * 70;
    return `<g><rect x="${x}" y="${y}" width="160" height="50" fill="#223344"/><text x="${x + 8}" y="${y + 30}" fill="white">node ${i}</text></g>`;
  }).join("");
  const dir = mkRepo({ "large.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5400 14000">${nodes}</svg>` });
  dirs.push(dir);
  await boot(page);
  const session = await openSessionTab(page, dir);
  typeLine(session, 'clear; echo "large.svg"');
  await page.waitForTimeout(1200);
  const opened = Date.now();
  await cmdClickToken(page, session, "large.svg");
  const object = page.locator(".svg-document-stage object");
  await expect.poll(() => object.evaluate((el: HTMLObjectElement) => el.contentDocument?.querySelectorAll("text").length).catch(() => 0)).toBe(6000);
  const openMs = Date.now() - opened;
  const result = await page.locator(".svg-document-stage").evaluate(async (stage: HTMLElement) => {
    const root = stage.querySelector("object")!.contentDocument!.documentElement;
    let viewBoxWrites = 0;
    const observer = new MutationObserver((records) => { viewBoxWrites += records.length; });
    observer.observe(root, { attributes: true, attributeFilter: ["viewBox"] });
    const timings: number[] = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      for (let n = 0; n < 8; n++) stage.dispatchEvent(new WheelEvent("wheel", { deltaY: 3, bubbles: true, cancelable: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      timings.push(performance.now() - start);
    }
    observer.disconnect();
    return { viewBoxWrites, frames: timings.length, p50Ms: timings.sort((a,b) => a-b)[15], maxMs: Math.max(...timings) };
  });
  const receipt = { nodes: 6000, svgElements: 18001, openMs, ...result };
  console.log(JSON.stringify(receipt));
  await testInfo.attach("large-svg-performance", { body: JSON.stringify(receipt, null, 2), contentType: "application/json" });
  if (!process.env.INSTANT_PREVIEW_BASELINE) expect(result.viewBoxWrites).toBeLessThanOrEqual(1);
});

const compiledFixtures = [
  {
    name: "D2",
    file: "large.d2",
    edges: 700,
    source: ["direction: right", ...Array.from({ length: 700 }, (_, index) => `n${index} -> n${index + 1}`)].join("\n"),
  },
  {
    name: "Mermaid",
    file: "large.mmd",
    edges: 700,
    source: ["flowchart LR", ...Array.from({ length: 700 }, (_, index) => `  n${index} --> n${index + 1}`)].join("\n"),
  },
] as const;

for (const fixture of compiledFixtures) {
  test(`large ${fixture.name} source compiles into a bounded interactive SVG`, async ({ page }, testInfo) => {
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") {
        const location = message.location();
        browserErrors.push(`console: ${message.text()} (${location.url}:${location.lineNumber})`);
      }
    });
    const dir = mkRepo({ [fixture.file]: fixture.source });
    dirs.push(dir);
    await boot(page);
    const session = await openSessionTab(page, dir);
    typeLine(session, `clear; echo "${fixture.file}"`);
    await page.waitForTimeout(1200);
    const opened = Date.now();
    await cmdClickToken(page, session, fixture.file);
    const object = page.locator(".svg-document-stage object");
    await expect.poll(async () => {
      const errors = (await page.locator(".fs-preview-empty").allTextContents())
        .filter((text) => text && text !== "loading…");
      if (errors.length) throw new Error(`${fixture.name} preview failed: ${errors.join(" | ")}`);
      return object.count();
    }, { timeout: 90_000 }).toBe(1).catch((error) => {
      const diagnostics = browserErrors.length ? `\nBrowser errors: ${browserErrors.join(" | ")}` : "";
      throw new Error(`${String(error)}${diagnostics}`);
    });
    const mounted = Date.now();
    await expect.poll(() => object.evaluate((el: HTMLObjectElement) =>
      el.contentDocument?.documentElement.querySelectorAll("g, path, rect, text").length ?? 0,
    ).catch(() => 0), { timeout: 90_000 }).toBeGreaterThan(fixture.edges);
    const loaded = Date.now();
    const result = await page.locator(".svg-document-stage").evaluate(async (stage: HTMLElement) => {
      const root = stage.querySelector("object")!.contentDocument!.documentElement;
      let viewBoxWrites = 0;
      const observer = new MutationObserver((records) => { viewBoxWrites += records.length; });
      observer.observe(root, { attributes: true, attributeFilter: ["viewBox"] });
      for (let frame = 0; frame < 20; frame++) {
        for (let event = 0; event < 8; event++) {
          stage.dispatchEvent(new WheelEvent("wheel", { deltaY: 3, bubbles: true, cancelable: true }));
        }
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      }
      observer.disconnect();
      return { viewBoxWrites, svgElements: root.querySelectorAll("*").length };
    });
    const receipt = { language: fixture.name, sourceLines: fixture.edges + 1,
      compileAndMountMs: mounted - opened, objectLoadMs: loaded - mounted, ...result };
    console.log(JSON.stringify(receipt));
    await testInfo.attach(`large-${fixture.name.toLowerCase()}-performance`, {
      body: JSON.stringify(receipt, null, 2), contentType: "application/json",
    });
    expect(result.viewBoxWrites).toBeLessThanOrEqual(1);
  });
}
