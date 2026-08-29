import { test, expect, type Page } from "@playwright/test";

// The ladder driven the way a user drives it: ⌘-click a token printed in a
// terminal, and watch which rung answers — an ancestor directory above the repo,
// fzf over the repo index, or ripgrep when the token names no path at all.

type TermHooks = {
  write: (data: string) => void;
  point: (row: number, col: number) => { x: number; y: number } | null;
};

declare global {
  interface Window {
    __term?: TermHooks;
    __cmdClickEvents?: Array<{ token: string; cwd: string; source: string; routeId: string | null }>;
    __runClickArgs?: { command?: string; cwd?: string };
  }
}

async function openTerm(page: Page) {
  await page.goto("/e2e-term.html?e2e=1");
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible({ timeout: 10_000 });
  await page.waitForFunction(() => !!window.__term?.point(0, 0));
}

async function writeLines(page: Page, lines: string[]) {
  await page.evaluate((rows) => {
    window.__term!.write(`\x1b[2J\x1b[H${rows.join("\r\n")}`);
  }, lines);
}

async function cmdClick(page: Page, row: number, col: number) {
  const point = await page.evaluate(([r, c]) => window.__term!.point(r, c), [row, col] as const);
  await page.keyboard.down("Meta");
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.click(point!.x, point!.y);
  await page.keyboard.up("Meta");
}

const lastEvent = (page: Page) => page.evaluate(() => window.__cmdClickEvents?.at(-1));
const panel = (page: Page) => page.locator(".rg-panel");

test("the crawl finds a file that lives above the repo root", async ({ page }) => {
  await openTerm(page);
  // Nothing named notes/ exists under /tmp/term-e2e; /tmp/notes/plan.md does,
  // and /tmp is the harness $HOME, so the ancestor rung is the one that answers.
  await writeLines(page, ["  wrote notes/plan.md"]);
  await cmdClick(page, 0, 10);

  await expect.poll(() => lastEvent(page)).toMatchObject({ token: "notes/plan.md", routeId: "file" });
  await expect(page.locator(".dv-default-tab", { hasText: "plan.md" })).toBeVisible();
});

test("a misspelled filename is answered by fzf, not ripgrep", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, ["  see src/prevew.ts for the fix"]);
  await cmdClick(page, 0, 10);

  await expect.poll(() => lastEvent(page)).toMatchObject({ token: "src/prevew.ts", routeId: "file" });
  await expect(panel(page).locator(".rg-head")).toContainText("src/prevew.ts");
  await expect(panel(page).locator(".rg-sub code")).toHaveText("fzf src/prevew.ts (1 candidate)");
  await expect(panel(page).locator(".rg-file")).toHaveText("/tmp/term-e2e/src/preview.ts");
  expect(await page.evaluate(() => window.__runClickArgs)).toBeUndefined();
});

test("a candidate row from the fzf picker opens the file", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, ["  see src/prevew.ts for the fix"]);
  await cmdClick(page, 0, 10);

  await panel(page).locator(".rg-hit").first().click();
  await expect(page.locator(".dv-default-tab", { hasText: "preview.ts" })).toBeVisible();
});

test("`grep it` in the picker runs the configured rule for the same token", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, ["  see src/prevew.ts for the fix"]);
  await cmdClick(page, 0, 10);

  await panel(page).locator(".rg-grep").click();
  await expect.poll(() => page.evaluate(() => window.__runClickArgs)).toMatchObject({
    command: expect.stringContaining("rg -nF -e 'src/prevew.ts'"),
    cwd: "/tmp/term-e2e",
  });
  await expect(panel(page).locator(".rg-sub code")).toContainText("rg -nF");
});

test("a token that names no path falls through to ripgrep", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, ["  qqqzzz.ts never existed"]);
  await cmdClick(page, 0, 4);

  await expect.poll(() => lastEvent(page)).toMatchObject({
    token: "qqqzzz.ts",
    routeId: "configured-rule",
  });
  await expect.poll(() => page.evaluate(() => window.__runClickArgs?.command)).toContain("qqqzzz.ts");
  await expect(panel(page).locator(".rg-hit")).toHaveCount(1);
});

test("a bare word that names exactly one folder resolves to it", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, ["  edited mdview last night"]);
  await cmdClick(page, 0, 10);

  await expect.poll(() => lastEvent(page)).toMatchObject({ token: "mdview", routeId: "file" });
});
