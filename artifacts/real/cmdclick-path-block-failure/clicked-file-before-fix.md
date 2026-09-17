# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: cmdclick-path-block.spec.ts >> ⌘-click in a block of absolute paths opens the clicked path
- Location: e2e-real/cmdclick-path-block.spec.ts:55:1

# Error details

```
Error: expect(locator).toHaveText(expected) failed

Locator:  locator('.fs-preview').locator('.fs-preview-name')
Expected: "02-beta.txt"
Received: "04-delta.txt"
Timeout:  15000ms

Call log:
  - Expect "toHaveText" with timeout 15000ms
  - waiting for locator('.fs-preview').locator('.fs-preview-name')
    34 × locator resolved to <span class="fs-preview-name">04-delta.txt</span>
       - unexpected value "04-delta.txt"

```

```yaml
- text: 04-delta.txt
```

# Test source

```ts
  1  | // A pane holding a block of absolute paths, one per line: what an agent TUI
  2  | // prints in a fenced block. The soft-join repair (termWrapJoin) exists to
  3  | // rejoin a path a TUI wrapped itself, and its shape test -- a row ending in a
  4  | // token, the next row one token, no whitespace in the concatenation -- is also
  5  | // satisfied by a run of COMPLETE paths. ⌘-clicking the second path must open
  6  | // that file: the joined run is nothing on disk, the resolver must not call it a
  7  | // hit, and the click falls back to the path actually under the pointer.
  8  | import { expect, test, type Page } from "@playwright/test";
  9  | import * as fs from "node:fs";
  10 | import os from "node:os";
  11 | import path from "node:path";
  12 | import {
  13 |   boot,
  14 |   closeTabs,
  15 |   cmdClickToken,
  16 |   killAllSessions,
  17 |   openSessionTab,
  18 |   paneScreen,
  19 |   shot,
  20 |   typeLine,
  21 | } from "./0_real";
  22 | 
  23 | const dirs: string[] = [];
  24 | 
  25 | /// A short temp dir: the paths stay one pane row each, which is the shape the
  26 | /// soft join attempts to chain (a hard wrap would take the isWrapped path).
  27 | function blockDir(): string {
  28 |   const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "isj-")));
  29 |   dirs.push(dir);
  30 |   return dir;
  31 | }
  32 | 
  33 | /// Print one absolute path per line and wait for the pane to hold them all.
  34 | async function printBlock(page: Page, session: string, paths: string[]): Promise<void> {
  35 |   typeLine(session, `clear; printf '%s\\n' ${paths.join(" ")}`);
  36 |   await expect
  37 |     .poll(() => paneScreen(session).filter((line) => line.startsWith("/")).length, {
  38 |       timeout: 15_000,
  39 |       message: `pane never painted the path block; screen: ${paneScreen(session).filter(Boolean).join(" | ")}`,
  40 |     })
  41 |     .toBe(paths.length);
  42 |   await page.waitForTimeout(500);
  43 | }
  44 | 
  45 | test.afterEach(async ({ page }) => {
  46 |   await closeTabs(page).catch(() => {});
  47 |   if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
  48 | });
  49 | 
  50 | test.afterAll(() => {
  51 |   if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
  52 |   for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  53 | });
  54 | 
  55 | test("⌘-click in a block of absolute paths opens the clicked path", async ({ page }) => {
  56 |   await boot(page);
  57 |   const dir = blockDir();
  58 |   const names = ["01-alpha.txt", "02-beta.txt", "03-gamma.txt", "04-delta.txt"];
  59 |   const paths = names.map((name, index) => {
  60 |     fs.writeFileSync(path.join(dir, name), `${name} body ${index}\n`);
  61 |     return path.join(dir, name);
  62 |   });
  63 |   const session = await openSessionTab(page, dir);
  64 |   await printBlock(page, session, paths);
  65 | 
  66 |   await cmdClickToken(page, session, paths[1]);
  67 | 
  68 |   const preview = page.locator(".fs-preview");
> 69 |   await expect(preview.locator(".fs-preview-name")).toHaveText("02-beta.txt", { timeout: 15_000 });
     |                                                     ^ Error: expect(locator).toHaveText(expected) failed
  70 |   await expect(preview).toContainText(paths[1]);
  71 |   await expect(preview).toContainText("02-beta.txt body 1");
  72 |   // The stitched run is not on disk: the panel must not be its error.
  73 |   await expect(preview).not.toContainText("No such file");
  74 |   await shot(page, "cmdclick-path-block-01-clicked");
  75 | });
  76 | 
  77 | test("⌘-click on a path nothing backs opens the search panel, not a preview", async ({ page }) => {
  78 |   await boot(page);
  79 |   const dir = blockDir();
  80 |   const missing = path.join(dir, "ghost-report.txt");
  81 |   const session = await openSessionTab(page, dir);
  82 |   await printBlock(page, session, [missing]);
  83 | 
  84 |   await cmdClickToken(page, session, "ghost-report.txt");
  85 | 
  86 |   await expect(page.locator(".rg-panel")).toContainText("ghost-report.txt", { timeout: 15_000 });
  87 |   await expect(page.locator(".fs-preview")).toHaveCount(0);
  88 |   await shot(page, "cmdclick-path-block-02-absent");
  89 | });
  90 | 
```