import { test, expect, type Page } from "@playwright/test";

// One contract per surface (e2e/cmdclick.tsx): a ⌘-click anywhere in the app
// reaches the router with the token under the pointer. The ladder that resolves
// that token is Rust, and is tested in src-tauri/src/refresolve.rs.

declare global {
  interface Window {
    __cmdClickEvents?: Array<{ token: string; cwd: string; source: string; routeId: string | null }>;
    __cwd?: string;
  }
}

const HOME = "/tmp/ladder-home";
const REPO = `${HOME}/projects/instant`;

async function open(page: Page) {
  await page.goto("/e2e-cmdclick.html?e2e=1");
  await expect(page.getByTestId("surface-preview")).toBeVisible();
}

// The viewport point of `needle` inside a surface, taken from a real Range so
// SVG <text> and HTML text are addressed the same way.
async function pointOf(page: Page, testid: string, needle: string) {
  const point = await page.evaluate(
    ([id, want]) => {
      const host = document.querySelector(`[data-testid="${id}"]`);
      if (!host) return null;
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = (node.nodeValue ?? "").indexOf(want);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index + 1);
        range.setEnd(node, index + 2);
        const rect = range.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }
      return null;
    },
    [testid, needle] as const,
  );
  expect(point, `no text "${needle}" in ${testid}`).not.toBeNull();
  return point!;
}

async function cmdClick(page: Page, testid: string, needle: string) {
  const point = await pointOf(page, testid, needle);
  await page.keyboard.down("Meta");
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up("Meta");
}

const lastEvent = (page: Page) => page.evaluate(() => window.__cmdClickEvents?.at(-1));

test.describe("surfaces", () => {
  const surfaces = [
    { testid: "surface-preview", needle: "src/main.ts", token: "src/main.ts", source: "preview" },
    { testid: "surface-results", needle: "MdPanel.tsx", token: `${REPO}/e2e/MdPanel.tsx`, source: "results" },
    { testid: "surface-markdown", needle: "src/preview.ts", token: "src/preview.ts", source: "markdown" },
    { testid: "surface-diagram", needle: "src/main.ts", token: "src/main.ts", source: "diagram" },
  ];

  for (const surface of surfaces) {
    test(`⌘-click in ${surface.testid} routes the token`, async ({ page }) => {
      await open(page);
      await cmdClick(page, surface.testid, surface.needle);
      await expect.poll(() => lastEvent(page)).toMatchObject({
        token: surface.token,
        source: surface.source,
        routeId: "e2e-record",
      });
    });
  }

  test("a plain click routes nothing", async ({ page }) => {
    await open(page);
    const point = await pointOf(page, "surface-markdown", "src/preview.ts");
    await page.mouse.click(point.x, point.y);
    await expect.poll(() => page.evaluate(() => window.__cmdClickEvents?.length ?? 0)).toBe(0);
  });

  test("a ⌘-click on a selection routes the whole selection", async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const node = document.querySelector('[data-testid="surface-markdown"] p')!.firstChild as Text;
      const text = node.nodeValue ?? "";
      const start = text.indexOf("src/preview.ts");
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + "src/preview.ts".length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await cmdClick(page, "surface-markdown", "src/preview.ts");
    await expect.poll(() => lastEvent(page)).toMatchObject({ token: "src/preview.ts", source: "markdown" });
  });
});
