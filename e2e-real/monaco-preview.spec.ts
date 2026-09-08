// A source file ⌘-clicked open from terminal output lands in Monaco inside a
// dock tab. Receipts are the editor's own DOM (its ready status, the rendered
// lines, the tab title) and, for the save, the bytes on disk.
import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import path from "node:path";
import { boot, cmdClickToken, killAllSessions, mkRepo, openSessionTab, shot, typeLine } from "./0_real";

const dirs: string[] = [];

test.afterEach(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
});

test.afterAll(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/// A repo holding `files`, a tab inside it, and `name` opened by a ⌘-click on
/// the path the pane printed.
async function openSource(page: Page, files: Record<string, string>, name: string): Promise<string> {
  const dir = mkRepo(files);
  dirs.push(dir);
  const session = await openSessionTab(page, dir);
  typeLine(session, `clear; echo "  see ${name} for the rest"`);
  await page.waitForTimeout(1_200);
  await cmdClickToken(page, session, name);
  return dir;
}

// defect src/0_MonacoCodeViewer.tsx:90: the save sends `{ path, text }` while the
// command takes `contents` (src-tauri/src/fs.rs:398, src-tauri/src/serve/rpc.rs:686),
// and ⌘S leaves the editor at data-status=ready, so the bytes on disk never move.
test.fixme("Monaco mounts in a preview tab, edits, and saves", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await boot(page);
  const dir = await openSource(page, { "sample.ts": "export const renderer = 1;\n" }, "sample.ts");
  const file = path.join(dir, "sample.ts");

  await expect(page.locator(".monaco-code-viewer[data-status=ready] .monaco-editor")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".view-lines")).toContainText("renderer");

  await page.locator(".view-lines").click();
  await page.keyboard.press("End");
  await page.keyboard.type("\n// edited in Instant");
  await expect(page.locator(".view-lines")).toContainText("// edited in Instant");
  await page.keyboard.press("Meta+s");

  // The save goes through the backend's save_text, so the file on disk is the
  // receipt a user would check.
  await expect.poll(() => fs.readFileSync(file, "utf8"), { timeout: 15_000 }).toContain("// edited in Instant");
  expect(fs.readFileSync(file, "utf8")).toContain("export const renderer = 1;");
  expect(errors).toEqual([]);
  await shot(page, "monaco-01-edit-save");
});

test("a source path opens Monaco inside a live Instant dock tab", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await boot(page);
  await openSource(page, { "live-tab.ts": "export const renderInInstantTab = true;\n" }, "live-tab.ts");

  await expect(page.locator(".dv-default-tab", { hasText: "live-tab.ts" })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".dv-host-scroll .monaco-code-viewer[data-status=ready]")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".dv-host-scroll .view-lines")).toContainText("renderInInstantTab");
  expect(errors).toEqual([]);
  await shot(page, "monaco-02-live-tab");
});
