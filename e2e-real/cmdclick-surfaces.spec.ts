// One contract per surface (src/clickrules.ts `CLICK_SURFACES`): a ⌘-click on
// free text anywhere in the app sends the token under the pointer through the
// same resolver a terminal ⌘-click uses. The receipt is what opens: the file
// preview naming the resolved path, or nothing at all for a plain click.
import { expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs";
import path from "node:path";
import { boot, cmdClickToken, killAllSessions, metaClick, openSessionTab, paneScreen, shot, typeLine } from "./0_real";

const dirs: string[] = [];

test.afterEach(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
});

test.afterAll(() => {
  if (!process.env.INSTANT_E2E_KEEP) killAllSessions();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/// The repo every case ⌘-clicks around: one file per surface, each naming a
/// path that exists, so a routed token has something to open. A preview that
/// replaced the terminal in its dock group leaves no terminal to click, and a
/// ⌘-click outside a terminal searches from the focused terminal's directory
/// (src/clickrules.ts `activeCwd`), so those surfaces name absolute paths. The
/// root is short on purpose: an absolute path under the system temp dir wraps
/// in a markdown paragraph and scrolls out of a Monaco line.
function surfacesRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "i")));
  const files: Record<string, string> = {
    "src/main.ts": "export const main = 1;\n",
    "src/preview.ts": "// renderer\n",
    "src/two words.ts": "// a path the word scanner alone cannot see\n",
    "flow.md": "```mermaid\nflowchart LR\n  A[\"src/main.ts\"] --> B[\"tmux\"]\n```\n",
    "README.md": "the missing qqqzzz.ts is mentioned once\n",
    "notes.txt": `edited ${dir}/src/main.ts today\n`,
    "doc.md": `# doc\n\nthe fix landed in src/preview.ts yesterday, and ${dir}/src/two words.ts holds the rest\n`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  dirs.push(dir);
  return dir;
}

/// The viewport points of the first, middle and last character of `needle`
/// inside the first visible `selector`. Read from real Ranges, so markdown
/// text, a Monaco line split across syntax spans, and an SVG label are all
/// addressed the same way.
async function pointsOf(page: Page, selector: string, needle: string) {
  const points = await page.evaluate(
    ([sel, want]) => {
      const hosts = [...document.querySelectorAll<HTMLElement>(sel)].filter((h) => h.getBoundingClientRect().width > 0);
      for (const host of hosts) {
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
        const nodes: { node: Text; at: number }[] = [];
        let text = "";
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          nodes.push({ node: node as Text, at: text.length });
          text += node.nodeValue ?? "";
        }
        const index = text.indexOf(want);
        if (index < 0) continue;
        const place = (offset: number) => {
          const hit = [...nodes].reverse().find((entry) => entry.at <= offset)!;
          const range = document.createRange();
          range.setStart(hit.node, offset - hit.at);
          range.setEnd(hit.node, Math.min(offset - hit.at + 1, hit.node.nodeValue?.length ?? 0));
          const box = range.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2, left: box.x, right: box.x + box.width };
        };
        return {
          start: place(index),
          mid: place(index + Math.floor(want.length / 2)),
          end: place(index + want.length - 1),
        };
      }
      return null;
    },
    [selector, needle] as const,
  );
  expect(points, `no text "${needle}" in ${selector}`).not.toBeNull();
  return points!;
}

/// ⌘-click the middle of `needle` where the surface shows it.
async function clickIn(page: Page, selector: string, needle: string): Promise<void> {
  const at = (await pointsOf(page, selector, needle)).mid;
  await metaClick(page, Math.round(at.x), Math.round(at.y));
}

/// The preview tab for `file`, identified by the full path its meta bar prints.
const preview = (page: Page, file: string) => page.locator(".fs-preview-meta", { hasText: file });

/// Open a path from the pane, the way each surface in this spec is reached.
async function openFromPane(page: Page, session: string, name: string): Promise<void> {
  await focusPane(page);
  typeLine(session, `clear; echo "  see ${name} for the rest"`);
  await page.waitForTimeout(1_200);
  await cmdClickToken(page, session, name);
}

/// A click in the pane, so the terminal is the app's idea of "where am I": a
/// ⌘-click outside a terminal searches from the focused terminal's directory
/// (src/clickrules.ts `activeCwd`), and nothing else names one.
async function focusPane(page: Page): Promise<void> {
  await page.locator(".term-host .xterm-screen").last().click();
  await page.waitForTimeout(300);
}

/// The markdown panel renders one collapsed section per heading; the heading
/// button opens the body a case needs to click inside.
async function expandSection(page: Page, name: RegExp): Promise<void> {
  await page.getByRole("button", { name }).first().click();
}

test("⌘-click in a file preview routes the token", async ({ page }) => {
  await boot(page);
  const dir = surfacesRepo();
  const session = await openSessionTab(page, dir);
  await openFromPane(page, session, "notes.txt");
  await expect(preview(page, `${dir}/notes.txt`)).toBeVisible({ timeout: 20_000 });
  // The meta bar paints before Monaco has lines; the click needs the text.
  await expect(page.locator(".fs-preview .view-lines")).toContainText(`${dir}/src/main.ts`, { timeout: 30_000 });

  await clickIn(page, ".fs-preview .view-lines", `${dir}/src/main.ts`);
  await expect(preview(page, `${dir}/src/main.ts`)).toBeVisible({ timeout: 20_000 });
  await shot(page, "surfaces-01-preview");
});

test("⌘-click in a results panel routes the token", async ({ page }) => {
  await boot(page);
  const dir = surfacesRepo();
  const session = await openSessionTab(page, dir);
  // A token with no file on disk falls to the configured rule, and its panel
  // prints the token in the head. The file arrives after the panel does, so the
  // second ⌘-click has a path to resolve that the first one lacked.
  typeLine(session, 'clear; echo "  qqqzzz.ts never existed"');
  await page.waitForTimeout(1_200);
  await cmdClickToken(page, session, "qqqzzz.ts");
  await expect(page.locator(".rg-panel .rg-head")).toContainText("qqqzzz.ts", { timeout: 20_000 });

  typeLine(session, "printf 'export const q = 1;\\n' > qqqzzz.ts");
  await expect.poll(() => fs.existsSync(path.join(dir, "qqqzzz.ts")), { timeout: 10_000 }).toBe(true);
  // The renderer answers the same token from a 1s cache (src/refResolve.ts:17),
  // so the second click waits past it and asks the resolver again.
  await page.waitForTimeout(2_000);
  await focusPane(page);
  await clickIn(page, ".rg-panel .rg-head", "qqqzzz.ts");
  await shot(page, "surfaces-02-results");
  await expect(preview(page, `${dir}/qqqzzz.ts`)).toBeVisible({ timeout: 20_000 });
});

test("⌘-click in a markdown preview routes the token", async ({ page }) => {
  await boot(page);
  const dir = surfacesRepo();
  const session = await openSessionTab(page, dir);
  await openFromPane(page, session, "doc.md");
  await expandSection(page, /1\. doc/);
  await expect(page.locator(".mdview-content")).toContainText("the fix landed", { timeout: 20_000 });

  await focusPane(page);
  await clickIn(page, ".mdview-content", "src/preview.ts");
  await expect(preview(page, `${dir}/src/preview.ts`)).toBeVisible({ timeout: 20_000 });
  await shot(page, "surfaces-03-markdown");
});

test("⌘-click in a terminal diagram routes the token", async ({ page }) => {
  await boot(page);
  const dir = surfacesRepo();
  const session = await openSessionTab(page, dir);
  // A mermaid fence printed by the pane renders over the terminal grid; its
  // labels are the app's own DOM, so a ⌘-click on one is a surface click.
  typeLine(session, "clear; cat flow.md");
  await expect.poll(() => paneScreen(session).some((line) => line.includes("flowchart")), { timeout: 15_000 }).toBe(true);
  const diagram = page.locator('.term-diagram[data-language="mermaid"] svg');
  await expect(diagram).toBeVisible({ timeout: 30_000 });

  await clickIn(page, '.term-diagram[data-language="mermaid"]', "src/main.ts");
  await expect(preview(page, `${dir}/src/main.ts`)).toBeVisible({ timeout: 20_000 });
  await shot(page, "surfaces-04-diagram");
});

test("a plain click routes nothing", async ({ page }) => {
  await boot(page);
  const dir = surfacesRepo();
  const session = await openSessionTab(page, dir);
  await openFromPane(page, session, "doc.md");
  await expandSection(page, /1\. doc/);
  await expect(page.locator(".mdview-content")).toContainText("the fix landed", { timeout: 20_000 });

  const at = (await pointsOf(page, ".mdview-content", "src/preview.ts")).mid;
  await page.mouse.click(Math.round(at.x), Math.round(at.y));
  await page.waitForTimeout(3_000);
  await expect(preview(page, `${dir}/src/preview.ts`)).toHaveCount(0);
  await shot(page, "surfaces-05-plain-click");
});

test("a ⌘-click on a selection routes the whole selection", async ({ page }) => {
  await boot(page);
  const dir = surfacesRepo();
  const session = await openSessionTab(page, dir);
  await openFromPane(page, session, "doc.md");
  await expandSection(page, /1\. doc/);
  await expect(page.locator(".mdview-content")).toContainText("the fix landed", { timeout: 20_000 });

  // The path holds a space, so the word under the pointer stops at "two".
  // Dragging over the whole path is what makes the file openable.
  const span = await pointsOf(page, ".mdview-content", `${dir}/src/two words.ts`);
  await page.mouse.move(Math.round(span.start.left) + 1, Math.round(span.start.y));
  await page.mouse.down();
  await page.mouse.move(Math.round(span.end.right) - 1, Math.round(span.end.y), { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ""), { timeout: 10_000 })
    .toContain("src/two words.ts");

  await metaClick(page, Math.round(span.mid.x), Math.round(span.mid.y));
  await expect(preview(page, `${dir}/src/two words.ts`)).toBeVisible({ timeout: 20_000 });
  await shot(page, "surfaces-06-selection");
});
