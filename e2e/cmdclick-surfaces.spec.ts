import { test, expect, type Page } from "@playwright/test";

// Two contracts on one page (e2e/cmdclick.tsx): every surface routes a ⌘-click
// to the same token scanner, and the path ladder answers before ripgrep does.

type ResolveResult =
  | { kind: "hit"; ref: { path: string; line?: number; source: string } }
  | { kind: "choices"; paths: string[]; line?: number; via: "exact" | "fuzzy" }
  | { kind: "miss" };

declare global {
  interface Window {
    __cmdClickEvents?: Array<{ token: string; cwd: string; source: string; routeId: string | null }>;
    __resolveRef?: (token: string, cwd: string) => Promise<ResolveResult>;
    __cwd?: string;
  }
}

const HOME = "/tmp/ladder-home";
const REPO = `${HOME}/projects/instant`;

async function open(page: Page) {
  await page.goto("/e2e-cmdclick.html?e2e=1");
  await expect(page.getByTestId("surface-preview")).toBeVisible();
  await page.waitForFunction(() => !!window.__resolveRef);
}

const resolve = (page: Page, token: string) =>
  page.evaluate(([t]) => window.__resolveRef!(t, window.__cwd!), [token] as const);

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

test.describe("path ladder", () => {
  test("a file under the cwd wins before anything else runs", async ({ page }) => {
    await open(page);
    expect(await resolve(page, "main.ts")).toEqual({
      kind: "hit",
      ref: { path: `${REPO}/src/main.ts`, source: "cwd" },
    });
  });

  test("a repo-relative path resolves from the repo root", async ({ page }) => {
    await open(page);
    expect(await resolve(page, "e2e/MdPanel.tsx")).toMatchObject({
      kind: "hit",
      ref: { path: `${REPO}/e2e/MdPanel.tsx`, source: "repo" },
    });
  });

  test("the crawl reaches a sibling repo above the root", async ({ page }) => {
    await open(page);
    expect(await resolve(page, "instant-lanes/README.md")).toMatchObject({
      kind: "hit",
      ref: { path: `${HOME}/projects/instant-lanes/README.md`, source: "ancestor" },
    });
  });

  test("the crawl stops at $HOME and finds a file sitting there", async ({ page }) => {
    await open(page);
    expect(await resolve(page, "TODO.md")).toMatchObject({
      kind: "hit",
      ref: { path: `${HOME}/TODO.md`, source: "ancestor" },
    });
  });

  test("a line suffix survives the crawl", async ({ page }) => {
    await open(page);
    expect(await resolve(page, "main.ts:214")).toEqual({
      kind: "hit",
      ref: { path: `${REPO}/src/main.ts`, line: 214, source: "cwd" },
    });
  });

  test("an ambiguous filename offers the exact matches", async ({ page }) => {
    await open(page);
    expect(await resolve(page, "MdPanel.tsx")).toMatchObject({
      kind: "choices",
      via: "exact",
      paths: [`${REPO}/e2e/MdPanel.tsx`, `${REPO}/src/mdview/MdPanel.tsx`],
    });
  });

  test("a misspelled filename comes back from fzf instead of ripgrep", async ({ page }) => {
    await open(page);
    expect(await resolve(page, "prevew.ts")).toMatchObject({
      kind: "choices",
      via: "fuzzy",
      paths: [`${REPO}/src/preview.ts`],
    });
  });

  test("a bare word naming exactly one folder opens the folder", async ({ page }) => {
    await open(page);
    expect(await resolve(page, "patchset-diff")).toMatchObject({
      kind: "hit",
      ref: { path: `${REPO}/packages/patchset-diff`, source: "fuzzy" },
    });
  });

  test("a token that names nothing is left to ripgrep", async ({ page }) => {
    await open(page);
    expect(await resolve(page, "qqqzzz.ts")).toEqual({ kind: "miss" });
    expect(await resolve(page, "renderPathInto")).toEqual({ kind: "miss" });
  });
});
