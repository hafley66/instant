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
const row = (page: Page, text: string) =>
  page.locator(".rg-panel .dtable-row").filter({ hasText: text });

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
  await expect(row(page, "src")).toBeVisible();
  await expect(row(page, "preview.ts")).toBeVisible();
  expect(await page.evaluate(() => window.__runClickArgs)).toBeUndefined();
});

test("a candidate row from the fzf picker opens the file", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, ["  see src/prevew.ts for the fix"]);
  await cmdClick(page, 0, 10);

  await row(page, "preview.ts").click();
  await expect(page.locator(".dv-default-tab", { hasText: "preview.ts" })).toBeVisible();
});

test("a token naming several files opens a directory tree of the candidates", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, ["  edited MdPanel.tsx just now"]);
  await cmdClick(page, 0, 12);

  await expect.poll(() => lastEvent(page)).toMatchObject({ token: "MdPanel.tsx", routeId: "file" });
  await expect(panel(page).locator(".rg-sub code")).toHaveText("resolve MdPanel.tsx (2 candidates)");
  // One row per candidate directory, relative to the deepest shared ancestor,
  // each already holding its ranked hit.
  await expect(row(page, "src/mdview")).toBeVisible();
  await expect(row(page, "e2e")).toBeVisible();
  await expect(panel(page).locator(".dtable-row.rc-hit")).toHaveCount(2);
  await expect(panel(page).locator(".dtable-row.rc-hit").first().locator(".rc-rank")).toHaveText("#1");
});

test("a directory row in the picker expands to the rest of its listing", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, ["  edited MdPanel.tsx just now"]);
  await cmdClick(page, 0, 12);

  // The candidate directory lists itself, so a folder holding no hit is still
  // there to open: the picker browses rather than freezing into a list.
  await row(page, "fixtures").locator(".tt-twisty").click();
  await expect(row(page, "tree.json")).toBeVisible();
});

test("a file row in the candidate tree opens that file", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, ["  edited MdPanel.tsx just now"]);
  await cmdClick(page, 0, 12);

  // The picker's own tab is titled with the token, so the preview is named by
  // the path it loaded rather than by its tab.
  await row(page, "MdPanel.tsx").first().click();
  await expect(page.locator(".fs-preview .fs-preview-meta")).toContainText(
    "/tmp/term-e2e/src/mdview/MdPanel.tsx",
  );
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
});

test("a bare word that names exactly one folder resolves to it", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, ["  edited mdview last night"]);
  await cmdClick(page, 0, 10);

  await expect.poll(() => lastEvent(page)).toMatchObject({ token: "mdview", routeId: "file" });
});

test("a path only git holds opens its blob, naming the revision", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, ["  see plans/bench/STUDY.md on origin/main"]);
  await cmdClick(page, 0, 12);

  await expect.poll(() => lastEvent(page)).toMatchObject({
    token: "plans/bench/STUDY.md",
    routeId: "file",
  });
  await expect(panel(page).locator(".rg-sub code")).toContainText("git show aa95c0ef3:plans/bench/STUDY.md");
  await expect(panel(page).locator(".rg-sub code")).toContainText("not in /tmp/sprefa");
  await expect(panel(page).locator(".rg-hit").first()).toContainText("# plans/bench/STUDY.md");
  expect(await page.evaluate(() => window.__runClickArgs)).toBeUndefined();
});

test("a token that matches nothing still opens a panel saying so", async ({ page }) => {
  await openTerm(page);
  await writeLines(page, ["  qqqzzz.ts never existed"]);
  await cmdClick(page, 0, 4);

  await expect.poll(() => lastEvent(page)).toMatchObject({
    token: "qqqzzz.ts",
    routeId: "configured-rule",
  });
  await expect(panel(page).locator(".rg-body")).toContainText(
    "no match, and no file named qqqzzz.ts on disk or in git",
  );
});
