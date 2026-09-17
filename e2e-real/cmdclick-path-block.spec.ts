// A pane holding a block of absolute paths, one per line: what an agent TUI
// prints in a fenced block. The soft-join repair (termWrapJoin) exists to
// rejoin a path a TUI wrapped itself, and its shape test -- a row ending in a
// token, the next row one token, no whitespace in the concatenation -- is also
// satisfied by a run of COMPLETE paths. ⌘-clicking the second path must open
// that file: the joined run is nothing on disk, the resolver must not call it a
// hit, and the click falls back to the path actually under the pointer.
import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  boot,
  closeTabs,
  cmdClickToken,
  killAllSessions,
  openSessionTab,
  paneScreen,
  shot,
  typeLine,
} from "./0_real";

const dirs: string[] = [];

/// A short temp dir: the paths stay one pane row each, which is the shape the
/// soft join attempts to chain (a hard wrap would take the isWrapped path).
function blockDir(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "isj-")));
  dirs.push(dir);
  return dir;
}

/// Print one absolute path per line and wait for the pane to hold them all.
async function printBlock(page: Page, session: string, paths: string[]): Promise<void> {
  typeLine(session, `clear; printf '%s\\n' ${paths.join(" ")}`);
  await expect
    .poll(() => paneScreen(session).filter((line) => line.startsWith("/")).length, {
      timeout: 15_000,
      message: `pane never painted the path block; screen: ${paneScreen(session).filter(Boolean).join(" | ")}`,
    })
    .toBe(paths.length);
  await page.waitForTimeout(500);
}

test.afterEach(async ({ page }) => {
  await closeTabs(page).catch(() => {});
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
});

test.afterAll(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("⌘-click in a block of absolute paths opens the clicked path", async ({ page }) => {
  await boot(page);
  const dir = blockDir();
  const names = ["01-alpha.txt", "02-beta.txt", "03-gamma.txt", "04-delta.txt"];
  const paths = names.map((name, index) => {
    fs.writeFileSync(path.join(dir, name), `${name} body ${index}\n`);
    return path.join(dir, name);
  });
  const session = await openSessionTab(page, dir);
  await printBlock(page, session, paths);

  await cmdClickToken(page, session, paths[1]);

  const preview = page.locator(".fs-preview");
  await expect(preview.locator(".fs-preview-name")).toHaveText("02-beta.txt", { timeout: 15_000 });
  await expect(preview).toContainText(paths[1]);
  await expect(preview).toContainText("02-beta.txt body 1");
  // The stitched run is not on disk: the panel must not be its error.
  await expect(preview).not.toContainText("No such file");
  await shot(page, "cmdclick-path-block-01-clicked");
});

test("⌘-click on a path nothing backs opens the search panel, not a preview", async ({ page }) => {
  await boot(page);
  const dir = blockDir();
  const missing = path.join(dir, "ghost-report.txt");
  const session = await openSessionTab(page, dir);
  await printBlock(page, session, [missing]);

  await cmdClickToken(page, session, "ghost-report.txt");

  await expect(page.locator(".rg-panel")).toContainText("ghost-report.txt", { timeout: 15_000 });
  await expect(page.locator(".fs-preview")).toHaveCount(0);
  await shot(page, "cmdclick-path-block-02-absent");
});
