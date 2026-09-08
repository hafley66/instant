// The resolver ladder driven the way a user drives it: ⌘-click a token in real
// terminal output and watch which rung answers. Receipts are the panels the
// app opens (the picker, a preview tab, the Files tree) or the pane itself.
import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import path from "node:path";
import {
  boot,
  clickToken,
  gitIn,
  killAllSessions,
  mkRepo,
  openSessionTab,
  paneScreen,
  shot,
} from "./0_real";

const dirs: string[] = [];

function paneHas(session: string, pattern: RegExp): boolean {
  return paneScreen(session).some((line) => pattern.test(line));
}

// A test's panes outlive its page: the store restores them into the next boot,
// and the fifth minted tab stops appearing. One test, one clean socket.
test.afterEach(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
});

test.afterAll(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/// A tab whose pane starts inside `cwd`, ready for a ⌘-click.
const ladderTab = (page: Page, cwd: string): Promise<string> => openSessionTab(page, cwd);

const panel = (page: Page) => page.locator(".rg-panel");
const row = (page: Page, text: string) =>
  page.locator(".rg-panel .dtable-row").filter({ hasText: text });

test("the crawl finds a file that lives above the repo root", async ({ page }) => {
  await boot(page);
  const dir = mkRepo({ "projects/instant/README.md": "repo\n", "notes/plan.md": "# Plan\n" });
  dirs.push(dir);
  const session = await ladderTab(page, path.join(dir, "projects", "instant"));
  await clickToken(page, session, "  wrote notes/plan.md", "notes/plan.md");

  await expect(page.locator(".dv-default-tab", { hasText: "plan.md" })).toBeVisible({ timeout: 15_000 });
  await shot(page, "ladder-01-ancestor");
});

test("a misspelled filename is answered by fzf, not ripgrep", async ({ page }) => {
  await boot(page);
  const dir = mkRepo({ "src/preview.ts": "// renderer\n", "src/main.ts": "// entry\n" }, "seed");
  dirs.push(dir);
  const session = await ladderTab(page, dir);
  await clickToken(page, session, "  see src/prevew.ts for the fix", "src/prevew.ts");

  await expect(panel(page).locator(".rg-head")).toContainText("src/prevew.ts");
  await expect(panel(page).locator(".rg-sub code")).toHaveText("fzf src/prevew.ts (1 candidate)");
  await expect(row(page, "src")).toBeVisible();
  await expect(row(page, "preview.ts")).toBeVisible();
  // ripgrep never ran in the pane: the screen holds the echo, no match lines.
  expect(paneHas(session, /preview\.ts:\d+/)).toBe(false);
  await shot(page, "ladder-02-fzf");
});

test("a candidate row from the fzf picker opens the file", async ({ page }) => {
  await boot(page);
  const dir = mkRepo({ "src/preview.ts": "// renderer\n", "src/main.ts": "// entry\n" }, "seed");
  dirs.push(dir);
  const session = await ladderTab(page, dir);
  await clickToken(page, session, "  see src/prevew.ts for the fix", "src/prevew.ts");

  await row(page, "preview.ts").click();
  await expect(page.locator(".dv-default-tab", { hasText: "preview.ts" })).toBeVisible({ timeout: 15_000 });
  await shot(page, "ladder-03-row-opens");
});

test("a token naming several files opens a directory tree of the candidates", async ({ page }) => {
  await boot(page);
  const dir = mkRepo({
    "src/mdview/MdPanel.tsx": "export {}\n",
    "e2e/MdPanel.tsx": "export {}\n",
    "e2e/fixtures/tree.json": "{}\n",
    "README.md": "seed\n",
  }, "seed");
  dirs.push(dir);
  const session = await ladderTab(page, dir);
  await clickToken(page, session, "  edited MdPanel.tsx just now", "MdPanel.tsx");

  await expect(panel(page).locator(".rg-sub code")).toHaveText("resolve MdPanel.tsx (2 candidates)");
  await expect(row(page, "src/mdview")).toBeVisible();
  await expect(row(page, "e2e")).toBeVisible();
  await expect(panel(page).locator(".dtable-row.rc-hit")).toHaveCount(2);
  await expect(panel(page).locator(".dtable-row.rc-hit .rc-rank").first()).toHaveText("#1");
  await shot(page, "ladder-04-choices");
});

test("a directory row in the picker expands to the rest of its listing", async ({ page }) => {
  await boot(page);
  const dir = mkRepo({
    "src/mdview/MdPanel.tsx": "export {}\n",
    "e2e/MdPanel.tsx": "export {}\n",
    "e2e/fixtures/tree.json": "{}\n",
    "README.md": "seed\n",
  }, "seed");
  dirs.push(dir);
  const session = await ladderTab(page, dir);
  await clickToken(page, session, "  edited MdPanel.tsx just now", "MdPanel.tsx");

  await expect(row(page, "fixtures")).toBeVisible();
  await row(page, "fixtures").locator(".tt-twisty").click();
  await expect(row(page, "tree.json")).toBeVisible();
  await shot(page, "ladder-05-expand");
});

test("a file row in the candidate tree opens that file", async ({ page }) => {
  await boot(page);
  const dir = mkRepo({
    "src/mdview/MdPanel.tsx": "export {}\n",
    "e2e/MdPanel.tsx": "export {}\n",
    "e2e/fixtures/tree.json": "{}\n",
    "README.md": "seed\n",
  }, "seed");
  dirs.push(dir);
  const session = await ladderTab(page, dir);
  await clickToken(page, session, "  edited MdPanel.tsx just now", "MdPanel.tsx");

  await expect(row(page, "MdPanel.tsx").first()).toBeVisible();
  const target = page.locator('.rg-panel .dtable-row[title$="/MdPanel.tsx"]').first();
  const want = await target.getAttribute("title");
  await target.click();
  const meta = page.locator(".fs-preview .fs-preview-meta");
  await expect(meta).toBeVisible({ timeout: 15_000 });
  await expect(meta).toContainText(want ?? "");
  await shot(page, "ladder-06-file-row");
});

test("`grep it` in the picker runs the configured rule for the same token", async ({ page }) => {
  await boot(page);
  const dir = mkRepo({
    "src/preview.ts": "// renderer\n",
    "README.md": "the misspelled mention src/prevew.ts lives here\n",
  }, "seed");
  dirs.push(dir);
  const session = await ladderTab(page, dir);
  await clickToken(page, session, "  see src/prevew.ts for the fix", "src/prevew.ts");

  await panel(page).locator(".rg-grep").click();
  await expect(panel(page).locator(".rg-sub code")).toContainText("rg -nF");
  // The hit names README.md, a path relative to the pane cwd: rg ran there.
  await expect(panel(page).locator(".rg-file")).toContainText("README.md");
  await expect(panel(page).locator(".rg-tx").first()).toContainText("src/prevew.ts");
  await shot(page, "ladder-07-grep");
});

test("a token that names no path falls through to ripgrep", async ({ page }) => {
  await boot(page);
  const dir = mkRepo({ "README.md": "seed\n" }, "seed");
  dirs.push(dir);
  const session = await ladderTab(page, dir);
  await clickToken(page, session, "  qqqzzz.ts never existed", "qqqzzz.ts");

  await expect(panel(page).locator(".rg-head")).toContainText("qqqzzz.ts");
  await expect(panel(page).locator(".rg-sub code")).toContainText("rg -nF");
  await shot(page, "ladder-08-ripgrep");
});

// defect src/preview.ts:73: a directory name carries no dot, so `split(".").pop()`
// hands back the name itself as the extension and the folder opens as a file
// preview reading "Is a directory (os error 21)". The Files tree never opens.
test.fixme("a bare word that names exactly one folder resolves to it", async ({ page }) => {
  await boot(page);
  const dir = mkRepo({ "src/mdview/MdPanel.tsx": "export {}\n", "README.md": "seed\n" }, "seed");
  dirs.push(dir);
  const session = await ladderTab(page, dir);
  await clickToken(page, session, "  edited mdview last night", "mdview");

  await expect(page.locator(".dv-default-tab", { hasText: "Files" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("MdPanel.tsx").first()).toBeVisible();
  await shot(page, "ladder-09-folder");
});

test("a path only git holds opens its blob, naming the revision", async ({ page }) => {
  await boot(page);
  const dir = mkRepo({ "plans/bench/STUDY.md": "# plans/bench/STUDY.md\nbody\n", "README.md": "seed\n" }, "seed the study");
  fs.rmSync(path.join(dir, "plans", "bench", "STUDY.md"));
  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "-qm", "drop the study"]);
  dirs.push(dir);
  const session = await ladderTab(page, dir);
  await clickToken(page, session, "  see plans/bench/STUDY.md on the mainline", "plans/bench/STUDY.md");

  const code = panel(page).locator(".rg-sub code");
  await expect(code).toContainText("git show ");
  await expect(code).toContainText(":plans/bench/STUDY.md");
  await expect(code).toContainText(`not in ${dir}`);
  await expect(panel(page).locator(".rg-hit .rg-tx").first()).toContainText("# plans/bench/STUDY.md");
  await shot(page, "ladder-10-git-blob");
});

// defect src-tauri/src/lib.rs:714 with src/clickrules.ts:99: ripgrep exits 1 when
// it finds nothing, run_click turns any nonzero exit into an error, and the
// caller prints that error, so the panel reads "Error: exit 1:" and the empty
// result line at src/clickrules.ts:103 is unreachable.
test.fixme("a token that matches nothing still opens a panel saying so", async ({ page }) => {
  await boot(page);
  const dir = mkRepo({ "README.md": "seed\n" }, "seed");
  dirs.push(dir);
  const session = await ladderTab(page, dir);
  await clickToken(page, session, "  qqqzzz.ts never existed", "qqqzzz.ts");

  await expect(panel(page).locator(".rg-body")).toContainText(
    "no match, and no file named qqqzzz.ts on disk or in git",
  );
  await shot(page, "ladder-11-no-match");
});
