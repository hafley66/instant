import { expect, test } from "@playwright/test";

// The session waterfall is the network view of the in-tab strip. "Show active"
// selects today's going-on rows versus history, while the network button swaps
// the table for the waterfall (brush overview on top, one bar per session, a
// tick per message) with the TreeTable below constrained to the brush's range. Fixtures: four
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

test("waterfall: network toggle renders the same active or history row set as the table", async ({ page }) => {
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

  // Network view is available while active-only remains checked and receives
  // the same one-row dataset as the table.
  await page.getByTestId("strip-network-toggle").click();
  let waterfall = page.getByTestId("waterfall");
  await expect(waterfall).toBeVisible();
  await expect(page.getByTestId("waterfall-count")).toHaveText("1 session");
  await page.getByTestId("strip-network-toggle").click();
  await expect(waterfall).toHaveCount(0);

  // Uncheck => history table. The scope holds in history too: related keeps
  // only the dispatch lane descending from this tab's session, and the tab's
  // own claude row (the TUI's own list) never appears.
  await page.getByText("Show active").click();
  await expect(page.locator(".waterfall")).toHaveCount(0);
  await page.getByTestId("strip-network-toggle").click();
  waterfall = page.getByTestId("waterfall");
  await expect(waterfall).toBeVisible();
  await expect(page.getByTestId("waterfall-count")).toHaveText("1 session");
  await expect(page.locator(".waterfall-plot text").filter({ hasText: "sess-live" })).toHaveCount(0);

  // Widening reaches the parentless history: every non-native session,
  // done/dead included.
  await page.getByTestId("strip-scope").click();
  await expect(page.getByTestId("waterfall-count")).toHaveText("3 sessions");
  await expect(page.locator(".waterfall-bar")).toHaveCount(3);
  for (const id of ["sess-lane", "sess-hist", "sess-dead"]) {
    await expect(page.locator(".waterfall-plot text").filter({ hasText: id })).toBeVisible();
  }
  // The brush rect painted the full domain selection.
  const sel = page.locator(".waterfall-overview .selection");
  await expect(sel).toBeVisible();
  expect(Number(await sel.getAttribute("width"))).toBeGreaterThan(0);

  // One tick per message of the drawn sessions, colored by type (user=blue,
  // assistant=green, tool=orange).
  await expect(page.locator(".waterfall-tick")).toHaveCount(5);
  await expect(page.locator('.waterfall-tick[fill="#3b82f6"]')).toHaveCount(2);
  await expect(page.locator('.waterfall-tick[fill="#22c55e"]')).toHaveCount(2);
  await expect(page.locator('.waterfall-tick[fill="#f59e0b"]')).toHaveCount(1);

  // The table below is constrained to the range (the whole domain): every
  // seeded session, including the done history row the default view hides.
  await expect(page.locator("tr").filter({ hasText: "sess-hist" })).toBeVisible();
  await expect(page.locator("tr").filter({ hasText: "sess-dead" })).toBeVisible();

  // DOM budget: the waterfall must stay linear in sessions+messages with a
  // small constant. The unvirtualized version blew past any such bound at
  // real history sizes (hundreds of sessions), which froze the webview.
  const domNodes = await waterfall.evaluate((el) => el.querySelectorAll("*").length);
  expect(domNodes).toBeLessThan(ROWS.length * 30 + MESSAGES.length * 3 + 100);

  await strip.screenshot({ path: "test-results/waterfall.png" });
  expect(pageErrors).toEqual([]);
});

test("waterfall: dragging the brush narrows the visible sessions and ticks", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await seed(page);
  await page.goto("/e2e-waterfall.html?e2e=1");

  // Show the history network at the widest scope first.
  await page.getByText("Show active").click();
  await page.getByTestId("strip-network-toggle").click();
  const waterfall = page.getByTestId("waterfall");
  await expect(waterfall).toBeVisible();
  await page.getByTestId("strip-scope").click();
  await expect(page.getByTestId("waterfall-count")).toHaveText("3 sessions");
  await expect(page.locator(".waterfall-tick")).toHaveCount(5);

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

// ---------------------------------------------------------------------------
// Stress: the size that froze the webview. 300 sessions x 50 messages = 15,000
// events. Unwindowed that is ~30,600 nodes (a bar and a label per session, a
// circle and a title per message) and 300 concurrent reads. Every assertion
// below is a constant, so a regression that reintroduces any history-sized term
// fails rather than merely slowing down.
// ---------------------------------------------------------------------------
const STRESS_SESSIONS = 300;
const STRESS_MESSAGES = 50;
const STRESS_BASE = Date.parse("2026-08-01T00:00:00Z");
const STRESS_STEP_MS = 10 * 60 * 1000; // one session started every 10 minutes
const STRESS_SPAN_MS = 8 * 60 * 1000; // each runs for 8 of those minutes
// 0_waterfall.ts DEFAULT_SESSION_LIMIT: what the opening range is allowed to cover.
const OPENING_LIMIT = 40;

async function seedStress(page: import("@playwright/test").Page) {
  await page.clock.setFixedTime(new Date(STRESS_BASE + STRESS_SESSIONS * STRESS_STEP_MS));
  await page.addInitScript(
    ({ sessions, messages, base, step, span }) => {
      const w = window as Window & { __instantE2eNativeResults?: Record<string, unknown> };
      const startOf = (i: number) => base + i * step;
      // External harnesses only: a claude session joined to this tmux is what
      // the tab's own agent list already shows, so StripPolicy drops it and the
      // strip would never appear.
      const harnesses = ["opencode", "codex", "kimi"];
      const rows = Array.from({ length: sessions }, (_, i) => ({
        id: `sess-${i}`,
        harness: harnesses[i % harnesses.length],
        sessionId: `sess-${i}`,
        parentId: null,
        parentKind: null,
        ts: new Date(startOf(i)).toISOString(),
        lastActivity: new Date(startOf(i) + span).toISOString(),
        status: "idle",
        cwd: "~/projects/demo",
      }));
      w.__instantE2eNativeResults = {
        harness_trace_rows: rows,
        list_dir: () => ({ entries: [] }),
        // Built per call so the 15,000 messages never cross addInitScript.
        read_ai_messages: (args?: Record<string, unknown>) => {
          const id = String(args?.sessionId ?? "");
          const i = Number(id.replace("sess-", ""));
          if (!Number.isFinite(i)) return [];
          return Array.from({ length: messages }, (_, j) => ({
            editor: String(args?.editor ?? "opencode"),
            session_id: id,
            id: `${id}-m${j}`,
            seq: j + 1,
            role: j % 2 === 0 ? "user" : "assistant",
            subtype: undefined,
            ts: startOf(i) + Math.round((j * span) / messages),
            preview: `m${j}`,
            text: "",
            locator: "",
          }));
        },
      };
    },
    { sessions: STRESS_SESSIONS, messages: STRESS_MESSAGES, base: STRESS_BASE, step: STRESS_STEP_MS, span: STRESS_SPAN_MS },
  );
}

test("waterfall stress: 300 sessions x 50 messages stays inside the node and IPC budget", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await seedStress(page);
  await page.goto("/e2e-waterfall.html?e2e=1");

  // 300 pane-less sessions leave the going-on bar empty (one going session
  // per pane), so the strip needs the summon hotkey; history draws them all.
  await expect(page.getByTestId("term-stub")).toBeVisible();
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+Period`);
  await expect(page.getByTestId("in-tab-strip")).toBeVisible();
  await page.getByText("Show active").click();
  await page.getByTestId("strip-network-toggle").click();
  const waterfall = page.getByTestId("waterfall");
  await expect(waterfall).toBeVisible();

  // 1. The opening range covers the newest OPENING_LIMIT sessions, not all 300.
  await expect(page.getByTestId("waterfall-count")).toHaveText(`${OPENING_LIMIT} sessions`);

  // 2. Lanes are windowed: the scroller shows 6, so bars stay near that even
  //    though 40 sessions are in range and 300 exist.
  const bars = await page.locator(".waterfall-bar").count();
  expect(bars).toBeGreaterThan(0);
  expect(bars).toBeLessThanOrEqual(14); // measured 9

  // 3. Ticks are capped per lane by pixel column, so 15,000 events cannot
  //    reach the DOM even when their sessions are all in range.
  const ticks = await page.locator(".waterfall-tick").count();
  expect(ticks).toBeLessThan(150); // measured 63

  // 4. The budget itself. Unwindowed this render was ~30,600 nodes.
  const domNodes = await waterfall.evaluate((el) => el.querySelectorAll("*").length);
  expect(domNodes).toBeLessThan(700); // measured 547

  // 5. IPC reads follow the lane window, not history: 300 sessions must never
  //    mean 300 concurrent read_ai_messages calls.
  const reads = await page.evaluate(
    () =>
      ((window as Window & { __instantE2eNativeCalls?: string[] }).__instantE2eNativeCalls ?? []).filter(
        (c) => c === "read_ai_messages",
      ).length,
  );
  expect(reads).toBeGreaterThan(0);
  expect(reads).toBeLessThanOrEqual(20); // measured 9

  await waterfall.screenshot({ path: "test-results/waterfall-stress.png" });
  expect(pageErrors).toEqual([]);
});
