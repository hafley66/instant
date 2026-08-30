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

// Ask queues for the NEXT MESSAGE panel now; the panel's own button does the
// send. Nothing is written to the pty at queue time.
test("Ask about this queues the selection instead of writing to the pty", async ({ page }) => {
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
  await clickCell(page, 0, 8, 3); // whole line
  await expect.poll(() => page.evaluate(() => window.__term!.pinned())).toBe(LINE);
  await page.evaluate(() => window.__term!.ask());

  // The queue panel is showing the line, with its textarea to annotate in.
  await expect(page.locator(".term-context-queue")).toBeVisible();
  await expect(page.locator(".term-context-queue header")).toContainText("NEXT MESSAGE · 1");
  await expect(page.locator(".term-context-queue-quote")).toHaveText(LINE);
  await expect(page.locator(".term-context-queue textarea")).toHaveValue("");
  // The slice says which turn it came out of, or that it came off the terminal.
  await expect(page.locator(".term-context-queue-turn")).toHaveCount(1);

  // Only the forwarded mouse reports reached the pty; no prompt body yet.
  const writes = await page.evaluate(() =>
    (window as unknown as { __ptyWrites: string[] }).__ptyWrites,
  );
  expect(writes.some((write) => write.includes("200~"))).toBe(false);
});

// A bare \n written to a pty is Enter and tmux squashes \r/\n alike, so the
// panel's send has to bracket its multi-line body or it submits per line.
test("the queue's own button sends one bracketed-paste body", async ({ page }) => {
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
  await clickCell(page, 0, 8, 3);
  await page.evaluate(() => window.__term!.ask());
  await expect(page.locator(".term-context-queue")).toBeVisible();
  await page.locator(".term-context-queue header button").click();

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
  expect(body).toContain(LINE);
  expect(body.includes("\r"), "a bare CR would submit the prompt").toBe(false);
});
