import { expect, test } from "@playwright/test";

// The session waterfall is history mode of the in-tab strip: unchecking
// "Show active" swaps today's going-on table for the devtools-network-style
// waterfall (brush overview on top, one bar per session, a tick per message)
// with the TreeTable below constrained to the brush's range. Fixtures: four
// sessions across the harnesses (one live claude, one idle opencode lane, one
// done codex history, one dead kimi), each with a handful of seeded messages.
const MAIL_DIR = "~/.agent/mail";
const T = (h: number, m: number) => Date.parse(`2026-08-03T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);

const ROWS = [
  { id: "sess-live", harness: "claude", sessionId: "sess-live", parentId: null, parentKind: null, ts: "2026-08-03T10:00:00Z", lastActivity: "2026-08-03T11:30:00Z", status: "live", cwd: "~/projects/demo" },
  { id: "sess-lane", harness: "opencode", sessionId: "sess-lane", parentId: "sess-live", parentKind: "dispatch", ts: "2026-08-03T10:20:00Z", lastActivity: "2026-08-03T10:50:00Z", status: "idle", cwd: "~/projects/demo" },
  { id: "sess-hist", harness: "codex", sessionId: "sess-hist", parentId: null, parentKind: null, ts: "2026-08-03T08:00:00Z", lastActivity: "2026-08-03T08:30:00Z", status: "done", cwd: "~/projects/demo" },
  { id: "sess-dead", harness: "kimi", sessionId: "sess-dead", parentId: null, parentKind: null, ts: "2026-08-03T09:00:00Z", lastActivity: "2026-08-03T09:10:00Z", status: "dead", cwd: "~/projects/demo" },
];

// One AiMessage per tick; proto has editor/session_id/id/seq/role/subtype/ts.
const MESSAGES = [
  { editor: "claude", session_id: "sess-live", id: "lv1", seq: 1, role: "user", subtype: undefined, ts: T(10, 30), preview: "do the grid", text: "", locator: "" },
  { editor: "claude", session_id: "sess-live", id: "lv2", seq: 2, role: "assistant", subtype: undefined, ts: T(10, 40), preview: "ok", text: "", locator: "" },
  { editor: "claude", session_id: "sess-live", id: "lv3", seq: 3, role: "assistant", subtype: "tool_use", ts: T(11, 0), preview: "📁 write", text: "", locator: "" },
  { editor: "opencode", session_id: "sess-lane", id: "ln1", seq: 1, role: "assistant", subtype: "Tool", ts: T(10, 25), preview: "read", text: "", locator: "" },
  { editor: "opencode", session_id: "sess-lane", id: "ln2", seq: 2, role: "assistant", subtype: undefined, ts: T(10, 45), preview: "done", text: "", locator: "" },
  { editor: "codex", session_id: "sess-hist", id: "hs1", seq: 1, role: "user", subtype: undefined, ts: T(8, 10), preview: "scan", text: "", locator: "" },
  { editor: "codex", session_id: "sess-hist", id: "hs2", seq: 2, role: "assistant", subtype: undefined, ts: T(8, 20), preview: "rows", text: "", locator: "" },
  { editor: "kimi", session_id: "sess-dead", id: "dd1", seq: 1, role: "user", subtype: undefined, ts: T(9, 5), preview: "hi", text: "", locator: "" },
];

async function seed(page: import("@playwright/test").Page) {
  await page.clock.setFixedTime(new Date("2026-08-03T12:00:00Z"));
  await page.addInitScript(({ mailDir, rows, messages }) => {
    const w = window as Window & { __instantE2eNativeResults?: Record<string, unknown> };
    w.__instantE2eNativeResults = {
      harness_trace_rows: rows,
      list_dir: () => ({ entries: [] }),
      read_ai_messages: (args?: Record<string, unknown>) =>
        messages.filter((m: { session_id: string }) => m.session_id === args?.sessionId),
    };
  }, { mailDir: MAIL_DIR, rows: ROWS, messages: MESSAGES });
}

test("waterfall: default is today's going-on table; unchecking draws the history waterfall", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await seed(page);
  await page.goto("/e2e-waterfall.html?e2e=1");

  const strip = page.getByTestId("in-tab-strip");
  const active = page.getByTestId("strip-showactive");
  await expect(strip).toBeVisible();

  // Default (checked): today's going-on table, no waterfall. The done/dead
  // history rows are absent and the going-on opencode lane is present.
  await expect(active).toBeChecked();
  await expect(page.locator(".waterfall")).toHaveCount(0);
  await expect(page.locator("tr").filter({ hasText: "sess-lane" })).toBeVisible();
  await expect(page.locator("tr").filter({ hasText: "sess-hist" })).toHaveCount(0);
  await expect(page.locator("tr").filter({ hasText: "sess-dead" })).toHaveCount(0);

  // Uncheck => history waterfall: brush overview + one bar per session + ticks.
  await page.getByText("Show active").click();
  const waterfall = page.getByTestId("waterfall");
  await expect(waterfall).toBeVisible();
  await expect(page.getByTestId("waterfall-count")).toHaveText("4 sessions");
  await expect(page.locator(".waterfall-bar")).toHaveCount(4);
  for (const id of ["sess-live", "sess-lane", "sess-hist", "sess-dead"]) {
    await expect(page.locator(".waterfall-plot text").filter({ hasText: id })).toBeVisible();
  }
  // The brush rect painted the full domain selection.
  const sel = page.locator(".waterfall-overview .selection");
  await expect(sel).toBeVisible();
  expect(Number(await sel.getAttribute("width"))).toBeGreaterThan(0);

  // One tick per seeded message, colored by type (user=blue, assistant=green,
  // tool=orange).
  await expect(page.locator(".waterfall-tick")).toHaveCount(MESSAGES.length);
  await expect(page.locator('.waterfall-tick[fill="#3b82f6"]')).toHaveCount(3);
  await expect(page.locator('.waterfall-tick[fill="#22c55e"]')).toHaveCount(3);
  await expect(page.locator('.waterfall-tick[fill="#f59e0b"]')).toHaveCount(2);

  // The table below is constrained to the range (the whole domain): every
  // seeded session, including the done history row the default view hides.
  await expect(page.locator("tr").filter({ hasText: "sess-hist" })).toBeVisible();
  await expect(page.locator("tr").filter({ hasText: "sess-dead" })).toBeVisible();

  await strip.screenshot({ path: "test-results/waterfall.png" });
  expect(pageErrors).toEqual([]);
});

test("waterfall: dragging the brush narrows the visible sessions and ticks", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await seed(page);
  await page.goto("/e2e-waterfall.html?e2e=1");

  // Show the history waterfall first.
  await page.getByText("Show active").click();
  const waterfall = page.getByTestId("waterfall");
  await expect(waterfall).toBeVisible();
  await expect(page.getByTestId("waterfall-count")).toHaveText("4 sessions");
  await expect(page.locator(".waterfall-tick")).toHaveCount(MESSAGES.length);

  // Drag the brush's right edge to ~15% of the plot: that range covers only the
  // early history session (sess-hist, 08:00-08:30), so the other three sessions
  // and their ticks fall out of range.
  const sel = page.locator(".waterfall-overview .selection");
  const selBox = await sel.boundingBox();
  const y0 = selBox!.y + selBox!.height / 2;
  const x0 = selBox!.x + selBox!.width - 2;
  const x1 = selBox!.x + selBox!.width * 0.15;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y0, { steps: 10 });
  await page.mouse.up();

  // The brush selection shrank from the full plot.
  expect(Number(await sel.getAttribute("width"))).toBeLessThan(selBox!.width * 0.5);

  // Only the early session remains: one bar, one table row, two ticks.
  await expect(page.getByTestId("waterfall-count")).toHaveText("1 session");
  await expect(page.locator(".waterfall-bar")).toHaveCount(1);
  await expect(page.locator("tr").filter({ hasText: "sess-hist" })).toBeVisible();
  await expect(page.locator("tr").filter({ hasText: "sess-live" })).toHaveCount(0);
  await expect(page.locator("tr").filter({ hasText: "sess-lane" })).toHaveCount(0);
  await expect(page.locator("tr").filter({ hasText: "sess-dead" })).toHaveCount(0);
  await expect(page.locator(".waterfall-tick")).toHaveCount(2);

  await waterfall.screenshot({ path: "test-results/waterfall-brushed.png" });
  expect(pageErrors).toEqual([]);
});
