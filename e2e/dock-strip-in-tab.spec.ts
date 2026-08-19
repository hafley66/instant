import { expect, test } from "@playwright/test";

// The in-tab strip is the bottom bar for EXTERNAL agent shells: claude code's
// own TUI already lists this tab's claude session and its native subagents, so
// the strip shows only what that list cannot. Fixtures: tree 1 = claude parent
// (joins tmux s1) + its claude subagent + the opencode lane it dispatched
// (joins s1) + that lane's own subagent; tree 2 = another claude parent and a
// codex lane in the s2 cwd. The terminal's sid is "s1".
const MAIL_DIR = "~/.agent/mail";
const ENVELOPES = [
  JSON.stringify({ id: "m1", from: "coordinator", to: "lane-oc", from_timestamp: "2026-08-03T10:20:00Z", to_timestamp: "2026-08-03T10:21:00Z", kind: "request", body: "take the strip lane", reply_to: null, ref: null }),
  JSON.stringify({ id: "m2", from: "lane-oc", to: "coordinator", from_timestamp: "2026-08-03T10:40:00Z", to_timestamp: null, kind: "result", body: "strip lane green", reply_to: "m1", ref: null }),
].join("\n");
const REGISTRY = JSON.stringify({
  version: 1,
  "lane-oc": { sessionId: "oc-lane", harness: "opencode", tmux: "s1" },
});
const ROWS = [
  { id: "parent-s1", harness: "claude", sessionId: "parent-s1", parentId: null, parentKind: null, ts: "2026-08-03T10:00:00Z", lastActivity: "2026-08-03T11:00:00Z", status: "live", cwd: "~/projects/demo" },
  { id: "child-s1", harness: "claude", sessionId: "child-s1", parentId: "parent-s1", parentKind: "subagent", ts: "2026-08-03T10:10:00Z", lastActivity: "2026-08-03T10:50:00Z", status: "live", cwd: "~/projects/demo" },
  { id: "oc-lane", harness: "opencode", sessionId: "oc-lane", parentId: "parent-s1", parentKind: "dispatch", ts: "2026-08-03T10:20:00Z", lastActivity: "2026-08-03T10:55:00Z", status: "live", cwd: "~/projects/demo" },
  { id: "oc-sub", harness: "opencode", sessionId: "oc-sub", parentId: "oc-lane", parentKind: "subagent", ts: "2026-08-03T10:30:00Z", lastActivity: "2026-08-03T10:45:00Z", status: "idle", cwd: "~/projects/demo" },
  { id: "parent-other", harness: "claude", sessionId: "parent-other", parentId: null, parentKind: null, ts: "2026-08-03T09:00:00Z", lastActivity: "2026-08-03T09:30:00Z", status: "live", cwd: "~/projects/other" },
  { id: "codex-other", harness: "codex", sessionId: "codex-other", parentId: "parent-other", parentKind: "dispatch", ts: "2026-08-03T09:05:00Z", lastActivity: "2026-08-03T09:20:00Z", status: "live", cwd: "~/projects/other" },
  // A finished lane: the strip must not count it on any scope (the bar answers
  // "going on", the trace page keeps history).
  { id: "oc-finished", harness: "opencode", sessionId: "oc-finished", parentId: "parent-s1", parentKind: "dispatch", ts: "2026-08-03T08:00:00Z", lastActivity: "2026-08-03T08:30:00Z", status: "done", cwd: "~/projects/demo" },
];
const FAMILY_GRAPH = {
  schema_version: 1,
  sessions: [
    { session: { harness: "claude", id: "parent-s1" }, cwd: "/Users/e2e/projects/demo", tmux: "s1", state: "live", started_ts: 1_754_240_000_000, last_activity_ts: 1_754_243_600_000 },
    { session: { harness: "claude", id: "child-s1" }, cwd: "/Users/e2e/projects/demo", tmux: "s1", state: "live", started_ts: 1_754_240_600_000, last_activity_ts: 1_754_243_000_000 },
    { session: { harness: "opencode", id: "oc-finished" }, cwd: "/Users/e2e/projects/demo", tmux: null, state: "dead", started_ts: 1_754_233_000_000, finished_ts: 1_754_234_800_000 },
  ],
  edges: [
    { parent: { harness: "claude", id: "parent-s1" }, child: { harness: "claude", id: "child-s1" }, kind: "subagent", first_ts: 1_754_240_600_000, last_ts: 1_754_240_600_000 },
    { parent: { harness: "claude", id: "parent-s1" }, child: { harness: "opencode", id: "oc-finished" }, kind: "dispatch", first_ts: 1_754_233_000_000, last_ts: 1_754_234_800_000 },
  ],
  shells: [
    { lane: "oc-lane", parent_lane: "parent-s1", harness: "opencode", session_id: null, cwd: "/Users/e2e/projects/demo", tmux: "s1", tmux_session: "s1", tmux_pane: null, state: "live", started_ts: 1_754_241_200_000 },
    { lane: "oc-sub", parent_lane: "oc-lane", harness: "opencode", session_id: null, cwd: "/Users/e2e/projects/demo", tmux: null, tmux_session: null, tmux_pane: "%9", state: "done", started_ts: 1_754_241_800_000 },
  ],
};

async function seed(page: import("@playwright/test").Page) {
  // relTime cells render against Date.now(); freeze it so the PNGs are
  // date-independent.
  await page.clock.setFixedTime(new Date("2026-08-03T12:00:00Z"));
  await page.addInitScript(({ mailDir, envelopes, registry, rows, graph }) => {
    const w = window as Window & { __instantE2eNativeResults?: Record<string, unknown> };
    w.__instantE2eNativeResults = {
      harness_trace_rows: rows,
      boop_agent_graph: (args?: Record<string, unknown>) => {
        (w as Window & { __boopGraphRequests?: Record<string, unknown>[] }).__boopGraphRequests ??= [];
        (w as Window & { __boopGraphRequests: Record<string, unknown>[] }).__boopGraphRequests.push(args ?? {});
        return JSON.stringify(graph);
      },
      list_dir: (args?: Record<string, unknown>) => {
        if (args?.path === mailDir) {
          return { entries: [
            { name: "workers.ndjson", path: `${mailDir}/workers.ndjson`, is_dir: false },
            { name: "registry.json", path: `${mailDir}/registry.json`, is_dir: false },
          ] };
        }
        throw new Error("no such dir");
      },
      read_text: (args?: Record<string, unknown>) => {
        if (args?.path === `${mailDir}/workers.ndjson`) return envelopes;
        if (args?.path === `${mailDir}/registry.json`) return registry;
        throw new Error("no such file");
      },
      // The row X button's only effect, recorded by name.
      kill_session: (args?: Record<string, unknown>) => {
        (w as Window & { __killedSession?: string }).__killedSession = String(args?.name);
        return null;
      },
    };
  }, { mailDir: MAIL_DIR, envelopes: ENVELOPES, registry: REGISTRY, rows: ROWS, graph: FAMILY_GRAPH });
}

test("in-tab strip: external-only lazy tree under the term, mail preview, back", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await seed(page);
  await page.goto("/e2e-dock-strip-in-tab.html?e2e=1");

  const strip = page.getByTestId("in-tab-strip");
  const termStub = page.getByTestId("term-stub");
  const opened = () => page.evaluate(() => (window as Window & { __dockStripOpened?: string }).__dockStripOpened ?? null);

  // The strip mounts under the term area, capped at 240px tall.
  await expect(strip).toBeVisible();
  const termBox = await termStub.boundingBox();
  const stripBox = await strip.boundingBox();
  expect(stripBox!.y).toBeGreaterThanOrEqual(termBox!.y);
  expect(stripBox!.height).toBeLessThanOrEqual(240);

  // The ruling: the tab's own claude session and its native subagent are NOT
  // duplicated here, and neither is the other terminal's tree. Subagent threads
  // run inside their parent's pane, so they are not shells either (b50346c).
  // What remains is the dispatched opencode lane, counted in the bar label.
  await expect(page.locator("tr").filter({ hasText: "parent-s1" })).toHaveCount(0);
  await expect(page.locator("tr").filter({ hasText: "child-s1" })).toHaveCount(0);
  await expect(page.locator("tr").filter({ hasText: "parent-other" })).toHaveCount(0);
  await expect(page.locator("tr").filter({ hasText: "oc-sub" })).toHaveCount(0);
  await expect(page.getByTestId("strip-count")).toHaveText("1 external shells");
  const laneRow = page.locator("tr").filter({ hasText: "oc-lane" });
  await expect(laneRow).toBeVisible();
  // The dispatch link the mail ledger resolved rides the row.
  await expect(laneRow).toContainText("dispatch");
  await strip.screenshot({ path: "test-results/strip-tree.png" });

  // A single row click does nothing: no view push, no join. Only a leaf
  // double-click opens. Twisty rows expand instead.
  await page.evaluate(() => ((window as Window & { __dockStripOpened?: string }).__dockStripOpened = undefined));
  await laneRow.locator(".s-name").click();
  await expect(page.getByText("viewing: oc-lane")).toHaveCount(0);
  expect(await opened()).toBeNull();
  // Row dblclick on a leaf = join the tmux session + push the agent-session view.
  await laneRow.locator(".s-name").dblclick();
  await expect(page.getByText("viewing: oc-lane")).toBeVisible();
  await expect.poll(opened).toBe("s1");
  await page.locator(".term-strip .strip-back").click();
  await expect(page.getByText("viewing: oc-lane")).toHaveCount(0);

  // The mail action re-anchors the queue preview INSIDE the strip: it replaces
  // the table while it is the router's top, and back pops to the tree.
  await page.getByTestId("strip-mail-oc-lane").click();
  const preview = page.getByTestId("mail-preview");
  await expect(preview).toBeVisible();
  await expect(page.getByTestId("mail-count")).toHaveText("2 messages · 1 unacked");
  await expect(preview).toContainText("take the strip lane");
  await expect(preview).toContainText("strip lane green");
  await expect(page.locator("tr").filter({ hasText: "oc-lane" })).toHaveCount(0);
  await strip.screenshot({ path: "test-results/strip-mail.png" });

  await page.locator(".term-strip .strip-back").click();
  await expect(preview).toHaveCount(0);
  await expect(page.locator("tr").filter({ hasText: "oc-lane" })).toBeVisible();

  // Widening the scope reaches the lanes this terminal's cwd join missed. The
  // other terminal's tree arrives collapsed, so its codex lane costs a twisty.
  await page.getByTestId("strip-scope").click();
  const otherRow = page.locator("tr").filter({ hasText: "parent-other" });
  await expect(otherRow).toBeVisible();
  await expect(page.getByTestId("strip-count")).toHaveText("3 external shells");
  await otherRow.locator(".tt-twisty").click();
  await expect(page.locator("tr").filter({ hasText: "codex-other" })).toBeVisible();
  // This tab's own claude rows stay out at every scope.
  await expect(page.locator("tr").filter({ hasText: "child-s1" })).toHaveCount(0);
  // Finished lanes stay out at every scope too.
  await expect(page.locator("tr").filter({ hasText: "oc-finished" })).toHaveCount(0);

  // The row X is the one sanctioned kill from the UI: it ends that row's tmux
  // session by name and nothing else — no view push, no join.
  await page.evaluate(() => ((window as Window & { __dockStripOpened?: string }).__dockStripOpened = undefined));
  await page.getByTestId("strip-kill-oc-lane").click();
  await expect
    .poll(() => page.evaluate(() => (window as Window & { __killedSession?: string }).__killedSession ?? null))
    .toBe("s1");
  expect(await opened()).toBeNull();

  expect(pageErrors).toEqual([]);
});

test("period summons the focused session family tree in the terminal strip", async ({ page }) => {
  await seed(page);
  await page.goto("/e2e-dock-strip-in-tab.html?e2e=1");
  await page.keyboard.press(`${MOD}+Shift+Period`);

  const strip = page.getByTestId("in-tab-strip");
  await expect(strip).toBeVisible();
  await expect(page.getByTestId("strip-count")).toHaveText("5 family sessions");
  const familyGraph = page.getByTestId("boop-family-graph");
  await expect(familyGraph).toHaveAttribute("data-node-count", "5");
  await expect(familyGraph).toHaveAttribute("data-edge-count", "4");
  await expect(familyGraph).toHaveAttribute("data-truncated-count", "0");
  await expect(page.getByTestId("boop-family-grapht")).toHaveCount(1);
  const familyRenderCount = Number(await familyGraph.getAttribute("data-render-count"));
  expect(familyRenderCount).toBeGreaterThan(0);
  await expect(page.getByTestId("strip-scope")).toHaveCount(0);
  await expect(page.getByTestId("strip-showactive")).toHaveCount(0);

  const root = page.locator("tr").filter({ hasText: "parent-s1" });
  await expect(root).toBeVisible();
  // Focused families open with their persisted descendants visible.
  await expect(page.locator("tr").filter({ hasText: "child-s1" })).toBeVisible();
  await expect(page.locator("tr").filter({ hasText: "oc-lane" })).toBeVisible();
  await expect(page.locator("tr").filter({ hasText: "oc-finished" })).toBeVisible();
  await page.locator("tr").filter({ hasText: "child-s1" }).hover();
  await expect(page.locator("tr").filter({ hasText: "child-s1" })).toHaveClass(/boop-family-linked/);
  await expect(page.locator("tr").filter({ hasText: "parent-other" })).toHaveCount(0);
  const requests = await page.evaluate(() => (window as Window & { __boopGraphRequests?: Record<string, unknown>[] }).__boopGraphRequests ?? []);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toEqual({
    query: expect.objectContaining({ include_history: true, tmux: "s1" }),
  });
  expect(requests[0]).not.toHaveProperty("include_history");
  const requestQuery = requests[0].query as Record<string, unknown>;
  expect(requestQuery).not.toHaveProperty("cwd");
  expect(typeof requestQuery.history_since_ts).toBe("number");
  await page.getByRole("button", { name: "refresh" }).click();
  await expect.poll(async () => (await page.evaluate(() => (window as Window & { __boopGraphRequests?: Record<string, unknown>[] }).__boopGraphRequests ?? [])).length).toBe(2);
  await expect.poll(() => familyGraph.getAttribute("data-render-count"), { timeout: 1_500 }).toBe(String(familyRenderCount));

  // Closing and reopening the panel keeps the tmux-scoped family result. The
  // moving seven-day cutoff must not manufacture a new cache identity or drop
  // the populated table while another Boop sync runs.
  await page.keyboard.press(`${MOD}+Shift+Period`);
  await expect(strip).toBeHidden();
  await page.keyboard.press(`${MOD}+Shift+Period`);
  await expect(page.getByTestId("strip-count")).toHaveText("5 family sessions");
  await expect(page.locator("tr").filter({ hasText: "child-s1" })).toBeVisible();
  await page.waitForTimeout(250);
  const reopenedRequests = await page.evaluate(() => (window as Window & { __boopGraphRequests?: Record<string, unknown>[] }).__boopGraphRequests ?? []);
  expect(reopenedRequests).toHaveLength(2);
  await strip.screenshot({ path: "test-results/strip-family-tree.png" });
});

test("focused family strip saves a vertical drag layout and refits after each committed change", async ({ page }) => {
  await seed(page);
  await page.goto("/e2e-dock-strip-in-tab.html?e2e=1");
  const refits = () => page.evaluate(() => (window as Window & { __termRefits?: number }).__termRefits ?? 0);
  const layoutHeights = () => page.evaluate(() => (window as Window & { __termLayoutHeights?: number[] }).__termLayoutHeights ?? []);

  const beforeOpen = await refits();
  await page.keyboard.press(`${MOD}+Shift+Period`);
  const handle = page.getByTestId("focused-family-resize");
  await expect(handle).toBeVisible();
  await expect.poll(refits).toBeGreaterThan(beforeOpen);

  const beforeDrag = await refits();
  const beforeDragHeights = await layoutHeights();
  const handleBox = await handle.boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y - 60, { steps: 4 });
  await page.mouse.up();
  await expect.poll(refits).toBeGreaterThan(beforeDrag);
  await expect.poll(async () => {
    const heights = await layoutHeights();
    return heights.at(-1);
  }).not.toBe(beforeDragHeights.at(-1));
  // The public store is not exposed in production; localStorage is the durable
  // pluginState mirror and is the persistence receipt this page can inspect.
  const layout = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("pluginState") ?? "{}");
    return state.harnessTrace.familyStripLayouts.s1 as [number, number];
  });
  expect(layout).toHaveLength(2);
  expect(layout[1]).toBeGreaterThan(30);

  const beforeClose = await refits();
  await page.keyboard.press(`${MOD}+Shift+Period`);
  await expect(handle).toHaveCount(0);
  await expect.poll(refits).toBeGreaterThan(beforeClose);

  const beforeRestore = await refits();
  await page.keyboard.press(`${MOD}+Shift+Period`);
  await expect(handle).toBeVisible();
  await expect.poll(refits).toBeGreaterThan(beforeRestore);
  const restoredStrip = await page.getByTestId("in-tab-strip").boundingBox();
  const restoredSplit = await page.getByTestId("focused-family-split").boundingBox();
  expect(restoredStrip!.height / restoredSplit!.height).toBeCloseTo(layout[1] / 100, 1);
});

test("wheel grows the focused family dock while pinch remains owned by its timeline", async ({ page }, testInfo) => {
  await seed(page);
  await page.goto("/e2e-dock-strip-in-tab.html?e2e=1");
  await page.keyboard.press(`${MOD}+Shift+Period`);

  const split = page.getByTestId("focused-family-split");
  const strip = page.getByTestId("in-tab-strip");
  const surface = page.getByTestId("focused-family-wheel-surface");
  const initial = await strip.boundingBox();
  expect(initial).not.toBeNull();
  await strip.screenshot({ path: testInfo.outputPath("family-dock-initial.png") });

  await surface.dispatchEvent("wheel", { deltaY: -600, deltaX: 0, ctrlKey: false });
  await expect.poll(async () => (await strip.boundingBox())?.height ?? 0).toBeGreaterThan(initial!.height + 40);
  const grown = await strip.boundingBox();
  await strip.screenshot({ path: testInfo.outputPath("family-dock-grown.png") });

  await surface.dispatchEvent("wheel", { deltaY: -2_000, deltaX: 0, ctrlKey: false });
  const clamped = await strip.boundingBox();
  const splitBox = await split.boundingBox();
  expect(clamped!.height / splitBox!.height).toBeCloseTo(0.75, 1);
  await strip.screenshot({ path: testInfo.outputPath("family-dock-maximum.png") });

  await surface.dispatchEvent("wheel", { deltaY: 300, deltaX: 0, ctrlKey: true });
  const afterPinch = await strip.boundingBox();
  expect(afterPinch!.height).toBeCloseTo(clamped!.height, 0);

  await surface.dispatchEvent("wheel", { deltaY: 2_000, deltaX: 0, ctrlKey: false });
  const minimum = await strip.boundingBox();
  expect(minimum!.height / splitBox!.height).toBeCloseTo(0.15, 1);
  await strip.screenshot({ path: testInfo.outputPath("family-dock-minimum.png") });
});

test("focused family graph and table save an independent vertical layout", async ({ page }) => {
  await seed(page);
  await page.goto("/e2e-dock-strip-in-tab.html?e2e=1");
  await page.keyboard.press(`${MOD}+Shift+Period`);

  const split = page.getByTestId("focused-family-content-split");
  const graph = page.getByTestId("boop-family-graph");
  const table = page.locator(".focused-family-table");
  const handle = page.getByTestId("focused-family-content-resize");
  await expect(split).toBeVisible();
  await expect(handle).toBeVisible();

  const beforeGraph = await graph.boundingBox();
  const handleBox = await handle.boundingBox();
  expect(beforeGraph).not.toBeNull();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + 40, { steps: 4 });
  await page.mouse.up();

  const afterGraph = await graph.boundingBox();
  expect(afterGraph!.height).toBeGreaterThan(beforeGraph!.height + 20);
  await expect(table.locator(".tt-scroll")).toHaveCSS("max-height", "none");
  const layout = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("pluginState") ?? "{}");
    return state.harnessTrace.familyContentLayouts.s1 as [number, number];
  });
  expect(layout).toHaveLength(2);
  expect(layout[0]).toBeGreaterThan(38);
});

test("family bridge renders empty and error states from a Claude identity fixture", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-08-03T12:00:00Z"));
  await page.addInitScript(() => {
    const w = window as Window & { __instantE2eNativeResults?: Record<string, unknown> };
    const claudeGraph = {
      schema_version: 1,
      sessions: [{ session: { harness: "claude", id: "4bf4853d-claude-root" }, tmux: "s1", state: "idle" }],
      edges: [],
      shells: [],
    };
    let calls = 0;
    w.__instantE2eNativeResults = {
      harness_trace_rows: [],
      boop_agent_graph: () => {
        calls += 1;
        if (calls === 1) return JSON.stringify({ ...claudeGraph, sessions: [] });
        throw new Error("boop graph unavailable for claude:4bf4853d-claude-root");
      },
    };
  });
  await page.goto("/e2e-dock-strip-in-tab.html?e2e=1");
  await page.keyboard.press(`${MOD}+Shift+Period`);
  await expect(page.getByTestId("strip-empty")).toContainText("no focused family sessions");
  await page.getByRole("button", { name: "refresh" }).click();
  await expect(page.getByText("boop graph unavailable for claude:4bf4853d-claude-root")).toBeVisible();
});

// Receipt (a): the summon bugs. A terminal whose sid has no tmux row and no
// related agent session had NO way to show the strip — the first hotkey press
// wrote open:false (absent entry read as open), and the shell refused to render
// with zero rows. Both are red at 57560ff.
const MOD = process.platform === "darwin" ? "Meta" : "Control";

test("hotkey summons the strip on a fresh terminal with no related sessions", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.clock.setFixedTime(new Date("2026-08-03T12:00:00Z"));
  await page.addInitScript(() => {
    const w = window as Window & { __instantE2eNativeResults?: Record<string, unknown> };
    w.__instantE2eNativeResults = {
      harness_trace_rows: [],
      list_dir: () => {
        throw new Error("no such dir");
      },
      read_text: () => {
        throw new Error("no such file");
      },
    };
  });
  await page.goto("/e2e-dock-strip-in-tab.html?e2e=1&term=s3");

  const strip = page.getByTestId("in-tab-strip");
  await expect(page.getByTestId("term-stub")).toBeVisible();
  await expect(strip).toHaveCount(0);

  // One press = summoned. The empty state names the terminal's sid (the tmux
  // join is by session name, so the sid is the diagnostic) and says why it is
  // empty rather than rendering nothing.
  await page.keyboard.press(`${MOD}+Shift+KeyX`);
  await expect(strip).toBeVisible();
  const empty = page.getByTestId("strip-empty");
  await expect(empty).toContainText("s3");
  await expect(empty).toContainText("no related sessions");

  // A second press dismisses it.
  const refits = () =>
    page.evaluate(() => (window as Window & { __termRefits?: number }).__termRefits ?? 0);
  const beforeHide = await refits();
  await page.keyboard.press(`${MOD}+Shift+KeyX`);
  await expect(strip).toHaveCount(0);
  // Hiding hands the strip's height back to the xterm, so the host is asked to
  // refit on the way out as well as on the way in (9d85a55); the height gate
  // that stopped the reload-driven refits must not swallow this one.
  await expect.poll(refits).toBeGreaterThan(beforeHide);
  expect(pageErrors).toEqual([]);
});
