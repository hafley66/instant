// ⌘+/-/0 over the active markdown preview zoom its reading pane (src/panelZoom.ts
// "md:" kind, applied by MdPanel as a CSS zoom on .mdview-content). The flow that
// matters is the one the app opens previews in: ⌘-click a path in a terminal, the
// preview opens beside it, and the terminal never loses DOM focus, so the zoom
// gesture must follow the ACTIVE panel rather than the terminal that holds focus.
import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import { boot, cmdClickToken, killAllSessions, mkRepo, openSessionTab, serveLog, shot, typeLine } from "./0_real";

const DOC = `---
title: Frontmatter must stay metadata
labels:
  - markdown
wide: abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz
---

# Zoom target

A paragraph with an [external link](https://example.com/research) under the heading.

\`\`\`http
POST /arrivals  { batch: [ add tree, add fruit, del leaf ] }
\`\`\`

\`\`\`mermaid
flowchart LR
  PTY --> tmux
  tmux --> xterm
  xterm --> Markdown
\`\`\`
`;

const dirs: string[] = [];

test.afterEach(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
});

test.afterAll(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const contentZoom = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector<HTMLElement>(".mdview-content");
    return el ? getComputedStyle(el).zoom : null;
  });

const codeScrollerCount = (page: Page) =>
  page.locator('[data-streamdown="code-block-body"]').evaluate((body) =>
    [body, ...body.querySelectorAll("*")].filter((element) => {
      const html = element as HTMLElement;
      const overflow = getComputedStyle(html).overflowX;
      return html.scrollWidth > html.clientWidth && (overflow === "auto" || overflow === "scroll");
    }).length,
  );

/// xterm sizes its rows from the font, and the char-measure span is 32 columns
/// wide, so its width is the terminal font size a user can see.
const termCellWidth = (page: Page) =>
  page.evaluate(() => {
    const host = [...document.querySelectorAll<HTMLElement>(".term-host")].find((h) => h.getBoundingClientRect().width > 0);
    const measure = host?.querySelector(".xterm-char-measure-element");
    return measure ? measure.getBoundingClientRect().width : 0;
  });

/// Whether keyboard focus sits inside a terminal, the state the zoom resolver
/// weighs against the dock's active panel.
const termHasFocus = (page: Page) =>
  page.evaluate(() => !!document.activeElement?.closest(".term-host"));

/// The markdown panel renders one collapsed section per heading; its heading
/// button opens the body, which is where the fence, the link and the code block
/// live.
const expandDoc = (page: Page) => page.getByRole("button", { name: /Zoom target/ }).first().click();

/// A tab in a temp dir holding zoom.md, plus the preview opened the way the app
/// opens previews: a ⌘-click on the path printed in the pane. The click leaves
/// keyboard focus in the terminal and makes the markdown panel active.
async function openDocFromPane(page: Page): Promise<string> {
  const dir = mkRepo({ "zoom.md": DOC });
  dirs.push(dir);
  const session = await openSessionTab(page, dir);
  await page.locator(".term-host .xterm-screen").last().click();
  await expect.poll(() => termHasFocus(page), { timeout: 10_000 }).toBe(true);
  typeLine(session, 'clear; echo "  see zoom.md for the plan"');
  await page.waitForTimeout(1_200);
  await cmdClickToken(page, session, "zoom.md");
  await expect(page.locator(".mdview-content")).toBeVisible({ timeout: 20_000 });
  return session;
}

test("YAML frontmatter stays out of the rendered document and cannot widen it", async ({ page }) => {
  await boot(page);
  await openDocFromPane(page);
  const content = page.locator(".mdview-content");
  await expect(content).toContainText("Zoom target");
  await expandDoc(page);
  await expect(content).toContainText("A paragraph with an");
  await expect(content).not.toContainText("Frontmatter must stay metadata");
  await expect(content).not.toContainText("abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz");
  expect(await content.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await shot(page, "mdzoom-01-frontmatter");
});

test("renderer tier lazily loads Markdown and renders a Mermaid fence", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await boot(page);
  await openDocFromPane(page);

  await expandDoc(page);
  const diagram = page.locator(".mdview-mermaid");
  await expect(diagram.locator("svg")).toBeVisible({ timeout: 30_000 });
  await expect(diagram).toContainText("PTY");
  await expect(diagram).toContainText("Markdown");
  expect(pageErrors).toEqual([]);
  await shot(page, "mdzoom-02-mermaid");
});

test("cmd+/-/0 zoom the markdown preview opened from a focused terminal", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await boot(page);
  await openDocFromPane(page);

  expect(await termHasFocus(page)).toBe(true); // the terminal still holds DOM focus
  expect(await contentZoom(page)).toBe("1");
  const termWidth = await termCellWidth(page);

  await page.keyboard.press("Meta+Equal");
  await page.keyboard.press("Meta+Equal");
  await expect.poll(async () => Number(await contentZoom(page)), { timeout: 10_000 }).toBeCloseTo(1.2, 5);
  expect(await termCellWidth(page)).toBe(termWidth); // the terminal font is untouched
  await expect(page.getByTitle("content zoom — reset (⌘0)")).toHaveText("120%");
  await expandDoc(page);
  expect(await codeScrollerCount(page)).toBe(1);
  await shot(page, "mdzoom-03-120");

  await page.keyboard.press("Meta+Minus");
  await expect.poll(async () => Number(await contentZoom(page)), { timeout: 10_000 }).toBeCloseTo(1.1, 5);

  await page.keyboard.press("Meta+Digit0");
  await expect.poll(() => contentZoom(page), { timeout: 10_000 }).toBe("1");
  await expect(page.getByTitle("content zoom — reset (⌘0)")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("a terminal the user is typing in still zooms its own font", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await boot(page);
  await openDocFromPane(page);

  // Opening the preview leaves xterm's textarea focused while Dockview makes
  // Markdown active. A following byte refreshes terminal recency without
  // reactivating its Dockview tab, so the gesture goes back to the terminal.
  await page.keyboard.type("x");
  await expect.poll(() => termHasFocus(page), { timeout: 10_000 }).toBe(true);
  const termWidth = await termCellWidth(page);

  await page.keyboard.press("Meta+Equal");
  await expect.poll(() => termCellWidth(page), { timeout: 10_000 }).toBeGreaterThan(termWidth);
  expect(await contentZoom(page)).toBe("1");
  await shot(page, "mdzoom-04-term-font");

  // Back into the preview: the gesture follows the user, both ways.
  await page.locator(".mdview-content").click({ position: { x: 40, y: 30 } });
  await page.keyboard.press("Meta+Equal");
  await expect.poll(async () => Number(await contentZoom(page)), { timeout: 10_000 }).toBeCloseTo(1.1, 5);
  expect(pageErrors).toEqual([]);
});

test("rendered markdown links route through the host", async ({ page }) => {
  await boot(page);
  await openDocFromPane(page);

  await expandDoc(page);
  const link = page.getByRole("link", { name: "external link" });
  await expect(link).toBeVisible();
  await link.click();

  // A browser build has no opener, so the host records the url it was handed.
  await expect.poll(() => serveLog(), { timeout: 15_000 })
    .toContain('ports: openUrl "https://example.com/research" ignored outside tauri');
  await shot(page, "mdzoom-05-link");
});

test("Super XP does not style markdown source snippets", async ({ page }) => {
  await boot(page);
  await openDocFromPane(page);
  // Super XP is a palette command (⌘⇧P), the way a user turns the skin on.
  await page.keyboard.press("Meta+Shift+p");
  const palette = page.locator(".cmdp-input");
  await expect(palette).toBeVisible();
  await palette.fill("Super XP");
  await palette.press("Enter");
  await expect.poll(() => page.evaluate(() => document.body.classList.contains("xp-pixel")), { timeout: 10_000 }).toBe(true);

  await expandDoc(page);
  const code = page.locator(".mdview-streamdown code");
  const scroller = page.locator('.mdview-streamdown [data-streamdown="code-block-body"]');
  await expect(code.first()).toContainText("POST /arrivals");

  const styles = {
    font: await code.first().evaluate((element) => getComputedStyle(element).font),
    descendantFonts: await scroller.first().evaluate((element) =>
      [...element.querySelectorAll("pre, code, span")]
        .map((child) => getComputedStyle(child).fontFamily)
        .filter((font, index, fonts) => fonts.indexOf(font) === index),
    ),
    nestedOverflow: await scroller.first().locator("pre").evaluate((element) => getComputedStyle(element).overflowX),
    horizontalScrollbar: await scroller.first().evaluate((element) => getComputedStyle(element, "::-webkit-scrollbar").height),
    scrollbarButton: await scroller.first().evaluate((element) => getComputedStyle(element, "::-webkit-scrollbar-button").display),
  };
  expect(styles).toEqual({
    font: '12px / 17.4px "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Monaco, Consolas, monospace',
    descendantFonts: ['"SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Monaco, Consolas, monospace'],
    nestedOverflow: "visible",
    horizontalScrollbar: "8px",
    scrollbarButton: "none",
  });
  expect(await codeScrollerCount(page)).toBe(1);
  await shot(page, "mdzoom-06-super-xp");
});
