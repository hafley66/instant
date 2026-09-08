// ⌘-hover and ⌘-click over terminal tokens, end to end: the pane is a real
// tmux shell whose cwd is a scratch git repo, so every token names a file on
// disk. The card is the popover the app paints; the click receipt is the dock
// panel that opens (preview, browser tab, or the files tree).
import { expect, test, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { boot, cell, closeTabs, findRow, killAllSessions, openSessionTab, shot, typeLine } from "./0_real";

const LINE_UPDATE = "  Update(src/main.ts) then Read(src/preview.ts:214)";
const LINE_BARE = "  edited MdPanel.tsx just now";
const LINE_REPORT = "Playwright receipt: .worktrees/terminal-inline-diagrams/playwright-report/index.html";
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const SVG_TEXT = '<svg viewBox="0 0 20 20"><rect width="20" height="20" fill="lime"/></svg>';

const dirs: string[] = [];

// A scratch repo per test: cwd-relative tokens, repo-root tokens, a bare
// filename that exists twice, an HTML report, media, and a wrapped folder.
async function openRepoTerm(page: Page) {
  const dir = mkdtempSync(join(tmpdir(), "cmd-hover-"));
  dirs.push(dir);
  const put = (rel: string, body: string | Buffer) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  put("src/main.ts", "export const main = 1;\n");
  put("src/preview.ts", "export const preview = 2;\n");
  put("a/MdPanel.tsx", "export const A = 1;\n");
  put("b/MdPanel.tsx", "export const B = 2;\n");
  put(".worktrees/terminal-inline-diagrams/playwright-report/index.html", "<html><body>report</body></html>\n");
  put("artifacts/v2-terminal-context-queue.png", PNG_BYTES);
  put("artifacts/v2-terminal-context-graph.svg", SVG_TEXT);
  put("worktrees/terminal-context-queue-v2/README.md", "wrapped folder\n");
  execSync(`git init -q ${JSON.stringify(dir)}`);
  await boot(page);
  // A tmux session named once per test, opened from the sessions panel: the
  // backend keeps a dead pty wired to a name a later tab mints again, so no
  // two tests share one.
  const session = await openSessionTab(page, dir);
  return { dir, real: realpathSync(dir), session };
}

// Row 0 of the fixture tier is the first line after `clear`; the same rows are
// found by scanning the pane instead of assuming offsets.
async function showLines(session: string, dir: string, lines: string[], marker: string) {
  const file = join(dir, "pane-lines.txt");
  writeFileSync(file, `${lines.join("\n")}\n`);
  typeLine(session, `clear; cat ${file}`);
  await expect.poll(() => findRow(session, marker), { timeout: 10_000 }).toBeGreaterThanOrEqual(0);
}

// ⌘-hover: two moves, the first arms the card, the second is the one the
// handler reads.
async function cmdHover(page: Page, at: { x: number; y: number }) {
  await page.keyboard.down("Meta");
  await page.mouse.move(at.x, at.y);
  await page.mouse.move(at.x + 1, at.y);
}

async function cmdClick(page: Page, at: { x: number; y: number }) {
  await page.keyboard.down("Meta");
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up("Meta");
}

const card = (page: Page) => page.locator(".term-inspector");

test.afterEach(async ({ page }) => {
  await page.keyboard.up("Meta").catch(() => {});
  // ⌘W drops each tab's pty, and the pane it drove is killed after it: a pile
  // of live sessions makes the next ⌘T mint a name the backend already holds.
  await closeTabs(page);
  killAllSessions();
});

test.afterAll(() => {
  if (process.env.INSTANT_E2E_KEEP) return;
  killAllSessions();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test("⌘-hover on Update(src/main.ts) names the path, not the call envelope", async ({ page }) => {
  const { dir, real, session } = await openRepoTerm(page);
  await showLines(session, dir, [LINE_UPDATE, LINE_BARE], "Update(src/main.ts)");

  // Column 12 sits inside src/main.ts; the envelope never owns the card.
  await cmdHover(page, await cell(page, 0, 12));
  await expect(card(page).locator("strong")).toHaveText("src/main.ts");
  await expect(card(page).locator("small")).toHaveText(`${real}/src/main.ts`);
  await shot(page, "cmd-hover-01-card");
});

test("⌘-hover over the envelope itself offers nothing", async ({ page }) => {
  const { dir, session } = await openRepoTerm(page);
  await showLines(session, dir, [LINE_UPDATE], "Update(src/main.ts)");

  // Hovered before anything else: once a card is open, holding ⌘ keeps it up
  // so the pointer can travel into its buttons.
  await cmdHover(page, await cell(page, 0, 3));
  await expect(card(page)).toBeHidden();
  await cmdHover(page, await cell(page, 0, 20));
  await expect(card(page)).toBeHidden();

  await cmdHover(page, await cell(page, 0, 12));
  await expect(card(page).locator("strong")).toHaveText("src/main.ts");
  await shot(page, "cmd-hover-02-envelope");
});

test("⌘-hover keeps a line suffix and resolves it", async ({ page }) => {
  const { dir, real, session } = await openRepoTerm(page);
  await showLines(session, dir, [LINE_UPDATE], "Update(src/main.ts)");

  // Inside "Read(src/preview.ts:214)".
  await cmdHover(page, await cell(page, 0, 33));
  await expect(card(page).locator("strong")).toHaveText("src/preview.ts:214");
  await expect(card(page).locator("small")).toHaveText(`${real}/src/preview.ts`);
  await shot(page, "cmd-hover-03-suffix");
});

test("a bare filename that matches several files reports the ambiguity", async ({ page }) => {
  const { dir, session } = await openRepoTerm(page);
  await showLines(session, dir, [LINE_BARE], "MdPanel.tsx");

  // MdPanel.tsx exists in a/ and b/ and nowhere under the cwd, so the resolver
  // falls through to the filename search and reports both.
  await cmdHover(page, await cell(page, 0, 12));
  await expect(card(page).locator("strong")).toHaveText("MdPanel.tsx");
  await expect(card(page).locator("span")).toHaveText("2 files match");
  await shot(page, "cmd-hover-04-ambiguity");
});

test("⌘-click on a resolved file opens it in a preview tab", async ({ page }) => {
  const { dir, real, session } = await openRepoTerm(page);
  await showLines(session, dir, [LINE_UPDATE], "Update(src/main.ts)");

  await cmdClick(page, await cell(page, 0, 12));

  // The tab is keyed by the resolved path, so the envelope and the
  // repo-relative spelling both land on the same tab.
  await expect(page.locator(".dv-default-tab", { hasText: "main.ts" })).toBeVisible();
  await expect(page.locator(".fs-preview .fs-preview-meta")).toContainText(`${real}/src/main.ts`);
  await shot(page, "cmd-hover-05-preview");
});

test("⌘-click resolves an HTML report from the tmux cwd and opens Chromium", async ({ page }) => {
  const { dir, real, session } = await openRepoTerm(page);
  await showLines(session, dir, [LINE_REPORT], "Playwright receipt:");

  await cmdClick(page, await cell(page, 0, 24));

  const expected = `file://${real}/.worktrees/terminal-inline-diagrams/playwright-report/index.html`;
  await expect(page.locator(".dv-default-tab", { hasText: `web:${expected}` })).toBeVisible();
  await expect(page.locator(".term-host input").last()).toHaveValue(expected);
  await shot(page, "cmd-hover-06-report");
});

for (const image of [
  { extension: "PNG", tail: "context-queue.png", body: PNG_BYTES },
  { extension: "SVG", tail: "context-graph.svg", body: SVG_TEXT },
]) {
  test(`⌘-click reconstructs a manually wrapped ${image.extension} path`, async ({ page }) => {
    const { dir, real, session } = await openRepoTerm(page);
    await showLines(session, dir, [
      `${real}/artifacts/v2-terminal-`,
      `  ${image.tail}`,
    ], image.tail);

    // The click lands on the second row's fragment; only the joined path
    // exists on disk, so the panel that opens proves the reconstruction.
    await cmdClick(page, await cell(page, 1, 8));
    await expect(page.locator(".dv-default-tab", { hasText: image.tail })).toBeVisible();
    await expect(
      page.locator(image.extension === "PNG" ? ".fs-preview-img" : ".svg-document-viewer"),
    ).toBeVisible();
    await shot(page, `cmd-hover-07-wrapped-${image.extension.toLowerCase()}`);
  });
}

test("⌘-click reconstructs a manually wrapped absolute folder without repository search", async ({ page }) => {
  const { dir, real, session } = await openRepoTerm(page);
  const folder = `${real}/worktrees/terminal-context-queue-v2`;
  await showLines(session, dir, [
    `${real}/worktrees/terminal-`,
    "  context-queue-v2",
  ], "context-queue-v2");

  // Only the joined path exists, so the panel that opens names it: the click
  // rebuilt the folder across the wrap without a repository search. The leaf
  // carries no dot, and preview.ts:73 reads a dotless leaf as an extension, so
  // the folder lands in the preview panel rather than the files tree.
  await cmdClick(page, await cell(page, 1, 8));
  await expect(page.locator(".dv-default-tab", { hasText: "terminal-context-queue-v2" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".fs-preview .fs-preview-meta")).toContainText(folder);
  await shot(page, "cmd-hover-08-wrapped-folder");
});

test("hover card snapshot", async ({ page }) => {
  const { dir, real, session } = await openRepoTerm(page);
  await showLines(session, dir, [LINE_UPDATE], "Update(src/main.ts)");
  await cmdHover(page, await cell(page, 0, 12));
  await expect(card(page).locator("small")).toHaveText(`${real}/src/main.ts`);
  // The fixture tier diffed pixels against a baseline; the real tier's receipt
  // is the committed PNG of the settled card.
  await shot(page, "cmd-hover-09-snapshot");
});
