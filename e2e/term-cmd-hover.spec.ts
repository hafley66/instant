import { test, expect, type Page } from "@playwright/test";

// ⌘-hover over a terminal token. The headless run has no PTY, so the harness
// writes fixture lines into the emulator and hands back the viewport point of a
// cell (see e2e/term.tsx). Agent transcripts are the source of the shapes here:
// `Update(src/main.ts)` must resolve to the path, never to the call envelope.

type TermHooks = {
  write: (data: string) => void;
  point: (row: number, col: number) => { x: number; y: number } | null;
};
declare global {
  interface Window {
    __term?: TermHooks;
  }
}

const LINE_UPDATE = "  Update(src/main.ts) then Read(src/preview.ts:214)";
const LINE_BARE = "  edited MdPanel.tsx just now";
const LINE_REPORT = "Playwright receipt: .worktrees/terminal-inline-diagrams/playwright-report/index.html";

async function openTerm(page: Page) {
  await page.goto("/e2e-term.html?e2e=1");
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => !!window.__term?.point(0, 0));
}

async function writeLines(page: Page, lines: string[]) {
  await page.evaluate((rows) => {
    window.__term!.write(`[2J[H${rows.join("\r\n")}`);
  }, lines);
}

// ⌘-hover the cell at (row, col) and wait for the card to name a token.
async function cmdHover(page: Page, row: number, col: number) {
  const point = await page.evaluate(
    ([r, c]) => window.__term!.point(r, c),
    [row, col] as const,
  );
  await page.keyboard.down("Meta");
  // Two moves: the first arms the card, the second is the one the handler reads
  // (a single move can land while the terminal is still measuring its cells).
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.move(point!.x + 1, point!.y);
}

const card = (page: Page) => page.locator(".term-inspector");

test.afterEach(async ({ page }) => {
  await page.keyboard.up("Meta").catch(() => {});
});

test("⌘-hover on Update(src/main.ts) names the path, not the call envelope", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, [LINE_UPDATE, LINE_BARE]);

  // Column 9 is the "s" of src/main.ts inside "  Update(".
  await cmdHover(page, 0, 12);
  await expect(card(page).locator("strong")).toHaveText("src/main.ts");

  // The resolver walks cwd then repo root, so the card reports the real file.
  await expect(card(page).locator("small")).toHaveText("/tmp/term-e2e/src/main.ts");
});

test("⌘-hover over the envelope itself offers nothing", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, [LINE_UPDATE]);

  // Column 3 sits inside "Update", column 20 is its closing paren. Neither
  // belongs to the token, so no card opens for them. (Hovered before anything
  // else: once a card is open, holding ⌘ deliberately keeps it up so the
  // pointer can travel into its buttons.)
  await cmdHover(page, 0, 3);
  await expect(card(page)).toBeHidden();
  await cmdHover(page, 0, 20);
  await expect(card(page)).toBeHidden();

  // The path in the same run does open one.
  await cmdHover(page, 0, 12);
  await expect(card(page).locator("strong")).toHaveText("src/main.ts");
});

test("⌘-hover keeps a line suffix and resolves it", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, [LINE_UPDATE]);

  // Inside "Read(src/preview.ts:214)".
  await cmdHover(page, 0, 33);
  await expect(card(page).locator("strong")).toHaveText("src/preview.ts:214");
  await expect(card(page).locator("small")).toHaveText("/tmp/term-e2e/src/preview.ts");
});

test("a bare filename that matches several files reports the ambiguity", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, [LINE_BARE]);

  // "MdPanel.tsx" exists twice in the fixture tree and nowhere under the cwd,
  // so the resolver falls through to the filename search.
  await cmdHover(page, 0, 12);
  await expect(card(page).locator("strong")).toHaveText("MdPanel.tsx");
  await expect(card(page).locator("span")).toHaveText("2 files match");
});

test("⌘-click on a resolved file opens it in a preview tab", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, [LINE_UPDATE]);

  const point = await page.evaluate(() => window.__term!.point(0, 12));
  await page.keyboard.down("Meta");
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.click(point!.x, point!.y);

  // The tab is keyed by the resolved path, so the token's envelope and its
  // repo-relative form both land on the same tab.
  await expect(page.locator(".dv-default-tab", { hasText: "main.ts" })).toBeVisible();
  await expect(page.locator(".fs-preview .fs-preview-meta")).toContainText("/tmp/term-e2e/src/main.ts");
});

test("⌘-click resolves an HTML report from the tmux cwd and opens Chromium", async ({ page }, testInfo) => {
  await openTerm(page);
  await writeLines(page, [LINE_REPORT]);

  const point = await page.evaluate(() => window.__term!.point(0, 24));
  await page.keyboard.down("Meta");
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.click(point!.x, point!.y);

  const expected = "file:///tmp/term-e2e/.worktrees/terminal-inline-diagrams/playwright-report/index.html";
  await expect(page.locator(".dv-default-tab", { hasText: `web:${expected}` })).toBeVisible();
  await expect(page.locator('.term-host input').last()).toHaveValue(expected);
  await testInfo.attach("cwd-resolved-html-in-chromium", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("hover card snapshot", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, [LINE_UPDATE]);
  await cmdHover(page, 0, 12);
  await expect(card(page).locator("small")).toHaveText("/tmp/term-e2e/src/main.ts");
  await expect(card(page)).toHaveScreenshot("cmd-hover-card.png", { maxDiffPixelRatio: 0.02 });
});
