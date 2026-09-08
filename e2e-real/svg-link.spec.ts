// An SVG document opened from a terminal ⌘-click: the pan overlay sits over the
// picture, and a stationary click on a linked shape still follows the link. A
// `vscode://file/...` href names a file, so the app opens it in a preview tab
// (src/0_documentHref.ts) rather than handing it to the OS.
import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import { boot, cmdClickToken, killAllSessions, mkRepo, openSessionTab, shot, typeLine } from "./0_real";

const dirs: string[] = [];

test.afterEach(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
});

test.afterAll(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const svgSource = (href: string) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 800 500">
  <svg class="d2-svg" width="800" height="500" viewBox="0 0 800 500">
    <rect width="800" height="500" fill="#101827"/>
    <a href="${href}" xlink:href="${href}">
      <g class="linked-node">
        <path d="M 220 170 L 580 170 L 550 310 L 190 310 Z" fill="#dbeafe" stroke="#2563eb" stroke-width="5"/>
        <text x="400" y="250" text-anchor="middle" font-family="sans-serif" font-size="32" fill="#111827">Clickable file:line link</text>
      </g>
    </a>
    <path d="M 400 310 L 400 430 L 470 390 M 400 430 L 330 390" fill="none" stroke="#60a5fa" stroke-width="8"/>
  </svg>
</svg>`;

/// A temp dir holding the linked target and a diagram that points at it, plus
/// the diagram opened by a ⌘-click on its path in the pane.
async function openDiagram(page: Page): Promise<{ dir: string; href: string }> {
  const dir = mkRepo({ "target.ts": "// line one\n".repeat(20) });
  dirs.push(dir);
  const href = `vscode://file${dir}/target.ts:14`;
  fs.writeFileSync(`${dir}/diagram.svg`, svgSource(href));
  const session = await openSessionTab(page, dir);
  typeLine(session, 'clear; echo "  see diagram.svg for the shape"');
  await page.waitForTimeout(1_200);
  await cmdClickToken(page, session, "diagram.svg");
  const object = page.locator(".svg-document-stage object");
  await expect(object).toHaveCount(1, { timeout: 20_000 });
  await expect
    .poll(() => object.evaluate((node: HTMLObjectElement) => node.contentDocument?.readyState), { timeout: 20_000 })
    .toBe("complete");
  return { dir, href };
}

test("SVG links survive the pan overlay and stationary clicks open them", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await boot(page);
  const { dir, href } = await openDiagram(page);
  const stage = page.locator(".svg-document-stage");
  const object = page.locator(".svg-document-stage object");

  const linkedGeometry = await object.evaluate((node: HTMLObjectElement) => ({
    anchors: node.contentDocument?.querySelectorAll("a").length,
    paths: Array.from(node.contentDocument?.querySelectorAll("path") ?? [], (path) => path.getAttribute("d")),
    href: node.contentDocument?.querySelector("a")?.getAttribute("href"),
  }));
  expect(linkedGeometry).toEqual({
    anchors: 1,
    href,
    paths: [
      "M 220 170 L 580 170 L 550 310 L 190 310 Z",
      "M 400 310 L 400 430 L 470 390 M 400 430 L 330 390",
    ],
  });

  // The point the linked shape occupies on screen, read from the picture itself
  // so the click lands on the anchor whatever size the dock gave the panel.
  const point = await object.evaluate((node: HTMLObjectElement) => {
    const anchor = node.contentDocument!.querySelector("a")!;
    const inner = (anchor as unknown as SVGGraphicsElement).getBoundingClientRect();
    const outer = node.getBoundingClientRect();
    return { x: outer.left + inner.left + inner.width / 2, y: outer.top + inner.top + inner.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await expect(stage).toHaveCSS("cursor", "pointer");
  await page.mouse.click(point.x, point.y);

  // The href names a file with a line, so the link opens inside Instant.
  await expect(page.locator(".fs-preview-meta", { hasText: `${dir}/target.ts:14` })).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
  await shot(page, "svglink-01-click");
});

test("SVG media preview shows the live render probe", async ({ page }) => {
  await boot(page);
  await openDiagram(page);

  const probe = page.getByRole("region", { name: "live render probe" });
  await expect(probe).toBeVisible();
  await expect(probe.getByTestId("live-probe-dom-count")).toHaveText(/^DOM [1-9]\d*$/);
  await expect(probe.getByTestId("live-probe-renders")).toContainText("FileImageViewer 1");
  await expect(probe.getByTestId("live-probe-renders")).toContainText(/SvgDocumentViewer [1-9]\d*/);
  await expect(probe.getByTestId("live-probe-events")).toContainText(/render:SvgDocumentViewer/);
  await shot(page, "svglink-02-probe");
});
