import { expect, test } from "@playwright/test";

// tmux with mouse on: DECSET 1000/1002/1006. xterm answers by disabling its own
// SelectionService, which is why double-click had nothing to select here.
const TMUX_PANE = "\x1b[?1049h\x1b[?1006h\x1b[?1000h\x1b[?1002h";
const LINE = "const shift = spans.map((s) => s.row);";

async function openPane(page: import("@playwright/test").Page) {
  await page.goto("/e2e-term.html?e2e=1&noHarness=1");
  await page.getByTestId("open-term").click();
  await expect(page.locator(".term-host")).toBeVisible();
  await page.evaluate(([prelude, line]) => {
    window.__term!.write(`${prelude}\x1b[2J\x1b[H${line}\r\nsecond line here`);
  }, [TMUX_PANE, LINE]);
  await expect.poll(() => page.evaluate(() => window.__term!.mouseMode())).toBe("drag");
}

async function clickCell(page: import("@playwright/test").Page, row: number, col: number, count: number) {
  const point = (await page.evaluate(([r, c]) => window.__term!.point(r, c), [row, col]))!;
  await page.mouse.click(point.x, point.y, { clickCount: count });
}

test("double-click takes the word under the pointer on a pane the app owns", async ({ page }) => {
  await openPane(page);
  await clickCell(page, 0, 8, 2); // inside "shift"
  await expect.poll(() => page.evaluate(() => window.__term!.pinned())).toBe("shift");
  await expect.poll(() => page.evaluate(() => window.__term!.pinnedRects())).toBe(1);
});

test("double-click stops at a bracket, matching xterm's own separators", async ({ page }) => {
  await openPane(page);
  await clickCell(page, 0, 16, 2); // inside "spans.map", bounded by " " and "("
  await expect.poll(() => page.evaluate(() => window.__term!.pinned())).toBe("spans.map");
});

test("triple-click takes the row without its trailing blanks", async ({ page }) => {
  await openPane(page);
  await clickCell(page, 0, 8, 3);
  await expect.poll(() => page.evaluate(() => window.__term!.pinned())).toBe(LINE);
});

// The payload has to reach the input bar as one editable block. A bare \n is
// Enter and tmux squashes \r/\n alike, so an unwrapped write would submit the
// quote one line at a time instead of filling the prompt.
test("Ask about this writes a bracketed-paste quote and submits nothing", async ({ page }) => {
  await openPane(page);
  await page.evaluate(() => {
    const w = window as unknown as {
      __ptyWrites: string[];
      __instantE2eNativeResults: Record<string, unknown>;
    };
    w.__ptyWrites = [];
    w.__instantE2eNativeResults.write_pty = (args: { data: string }) => {
      w.__ptyWrites.push(args.data);
    };
  });
  await clickCell(page, 0, 8, 3); // whole line, so the quote has real content
  await expect.poll(() => page.evaluate(() => window.__term!.pinned())).toBe(LINE);
  await page.evaluate(() => window.__term!.ask());

  // The clicks themselves are forwarded to the app as SGR mouse reports first,
  // because this pane's app owns the mouse. The ask payload is the last write.
  await expect.poll(() =>
    page.evaluate(() =>
      (window as unknown as { __ptyWrites: string[] }).__ptyWrites.some((w) => w.includes("200~")),
    ),
  ).toBe(true);
  const written = await page.evaluate(() => {
    const writes = (window as unknown as { __ptyWrites: string[] }).__ptyWrites;
    return writes[writes.length - 1];
  });

  expect(written.startsWith("\x1b[200~"), "opens bracketed paste").toBe(true);
  expect(written.endsWith("\x1b[201~"), "closes bracketed paste").toBe(true);
  const body = written.slice("\x1b[200~".length, -"\x1b[201~".length);
  expect(body).toBe(`> ${LINE}\n\n`);
  // No bare \r anywhere: that is the byte that would submit the prompt.
  expect(body.includes("\r")).toBe(false);
});
