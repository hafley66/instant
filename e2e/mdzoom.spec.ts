import { expect, test, type Page } from "@playwright/test";

// ⌘+/-/0 over the active markdown preview zoom its reading pane (src/panelZoom.ts
// "md:" kind, applied by MdPanel as a CSS zoom on .mdview-content).
// The flow that matters is the one the app opens previews in: ⌘-click a path in
// a terminal, the preview opens beside it, and the terminal never loses DOM
// focus — so the zoom gesture must follow the ACTIVE panel, not the terminal
// that still holds focus.

type ZoomWindow = Window & {
  __mdzoom?: {
    doc: string;
    mdPid: string;
    termPid: string;
    factors: () => Record<string, number>;
    focusedTerm: () => string | null;
    activePanel: () => string | null;
    openedHrefs: () => { href: string; sourcePath: string }[];
  };
};

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

const state = (page: Page) =>
  page.evaluate(() => {
    const w = (window as ZoomWindow).__mdzoom!;
    const f = w.factors();
    return {
      md: f[w.mdPid] ?? 1,
      term: f[w.termPid] ?? 1,
      focusedTerm: w.focusedTerm(),
      activePanel: w.activePanel(),
    };
  });

// A real click inside the terminal: it takes DOM focus AND makes the terminal
// dockview's active panel, which is the state a user types in.
async function useTerminal(page: Page) {
  await page.locator(".xterm-screen").first().click();
  await expect.poll(async () => (await state(page)).focusedTerm).not.toBeNull();
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-08-03T12:00:00Z"));
  await page.goto("/e2e-mdzoom.html?e2e=1");
  await page.getByTestId("open-term").click();
  await expect(page.locator(".xterm-screen").first()).toBeVisible();
});

test("YAML frontmatter stays out of the rendered document and cannot widen it", async ({ page }) => {
  await page.getByTestId("open-md").click();
  const content = page.locator(".mdview-content");
  await expect(content).toBeVisible();
  await expect(content).not.toContainText("Frontmatter must stay metadata");
  await expect(content).not.toContainText("abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz");
  expect(await content.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))).toMatchObject({
    clientWidth: expect.any(Number),
    scrollWidth: expect.any(Number),
  });
  expect(await content.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("cmd+/-/0 zoom the markdown preview opened from a focused terminal", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await useTerminal(page);
  // Open the preview from the keyboard, exactly as a ⌘-click in the terminal
  // does: the terminal keeps focus while the new panel becomes active.
  await page.keyboard.press("Meta+Shift+m");
  await expect(page.locator(".mdview-content")).toBeVisible();
  const opened = await state(page);
  expect(opened.focusedTerm).not.toBeNull(); // the terminal still holds DOM focus
  expect(opened.activePanel).toBe(await page.evaluate(() => (window as ZoomWindow).__mdzoom!.mdPid));
  expect(await contentZoom(page)).toBe("1");

  await page.keyboard.press("Meta+Equal");
  await page.keyboard.press("Meta+Equal");
  await expect.poll(async () => (await state(page)).md).toBeCloseTo(1.2, 5);
  expect((await state(page)).term).toBe(1); // the terminal font is untouched
  expect(Number(await contentZoom(page))).toBeCloseTo(1.2, 5);
  await page.getByRole("button", { name: /Zoom target/ }).click();
  expect(await codeScrollerCount(page)).toBe(1);
  await expect(page.getByTitle("content zoom — reset (⌘0)")).toHaveText("120%");
  await page.screenshot({ path: "test-results/mdzoom-120.png" });

  await page.keyboard.press("Meta+Minus");
  await expect.poll(async () => Number(await contentZoom(page))).toBeCloseTo(1.1, 5);

  await page.keyboard.press("Meta+Digit0");
  await expect.poll(() => contentZoom(page)).toBe("1");
  await expect(page.getByTitle("content zoom — reset (⌘0)")).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test("a terminal the user is typing in still zooms its own font", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.getByTestId("open-md").click();
  await expect(page.locator(".mdview-content")).toBeVisible();
  await useTerminal(page);
  const termPid = await page.evaluate(() => (window as ZoomWindow).__mdzoom!.termPid);
  await expect.poll(async () => (await state(page)).activePanel).toBe(termPid);

  await page.keyboard.press("Meta+Equal");
  await expect.poll(async () => (await state(page)).term).toBeGreaterThan(1);
  expect((await state(page)).md).toBe(1);
  expect(await contentZoom(page)).toBe("1");
  await page.screenshot({ path: "test-results/mdzoom-term-regression.png" });

  // Back into the preview: the gesture follows the user, both ways.
  await page.locator(".mdview-content").click({ position: { x: 40, y: 30 } });
  await page.keyboard.press("Meta+Equal");
  await expect.poll(async () => (await state(page)).md).toBeCloseTo(1.1, 5);

  expect(pageErrors).toEqual([]);
});

test("rendered markdown links route through the host", async ({ page }) => {
  await page.getByTestId("open-md").click();
  await page.getByRole("button", { name: /Zoom target/ }).click();
  const link = page.getByRole("link", { name: "external link" });
  await expect(link).toBeVisible();
  await link.click();

  expect(await page.evaluate(() => (window as ZoomWindow).__mdzoom!.openedHrefs())).toEqual([
    { href: "https://example.com/research", sourcePath: "/tmp/mdzoom-e2e/zoom.md" },
  ]);
});

test("Super XP does not style markdown source snippets", async ({ page }) => {
  await page.evaluate(() => document.body.classList.add("xp-pixel"));
  await page.getByTestId("open-md").click();
  await page.getByRole("button", { name: /Zoom target/ }).click();
  const code = page.locator(".mdview-streamdown code");
  const scroller = page.locator('.mdview-streamdown [data-streamdown="code-block-body"]');
  await expect(code).toContainText("POST /arrivals");

  const styles = {
    font: await code.evaluate((element) => getComputedStyle(element).font),
    descendantFonts: await scroller.evaluate((element) =>
      [...element.querySelectorAll("pre, code, span")]
        .map((child) => getComputedStyle(child).fontFamily)
        .filter((font, index, fonts) => fonts.indexOf(font) === index),
    ),
    nestedOverflow: await scroller.locator("pre").evaluate((element) => getComputedStyle(element).overflowX),
    horizontalScrollbar: await scroller.evaluate((element) => getComputedStyle(element, "::-webkit-scrollbar").height),
    scrollbarButton: await scroller.evaluate((element) => getComputedStyle(element, "::-webkit-scrollbar-button").display),
  };
  expect(styles).toEqual({
    font: '12px / 17.4px "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Monaco, Consolas, monospace',
    descendantFonts: ['"SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Monaco, Consolas, monospace'],
    nestedOverflow: "visible",
    horizontalScrollbar: "8px",
    scrollbarButton: "none",
  });
  expect(await codeScrollerCount(page)).toBe(1);
  await page.screenshot({ path: "test-results/mdview-super-xp-snippets.png" });
});
