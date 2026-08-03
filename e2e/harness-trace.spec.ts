import { expect, test } from "@playwright/test";

// harness trace = the who-called-who tree. Fixtures cover all three link cases:
// a claude subagent chain two levels deep (parentKind "subagent", from rust), a
// cross-harness dispatch child whose sender resolves through the mail registry
// (parentKind "dispatch"), and a session whose sender does NOT resolve, which
// must stay a root rather than get an invented edge.
test("harness trace renders the session tree, lazily, with mail attribution", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // relTime cells render against Date.now(); freeze it so the screenshot
  // baseline is date-independent.
  await page.clock.setFixedTime(new Date("2026-08-03T12:00:00Z"));
  await page.addInitScript(() => {
    const w = window as Window & { __instantE2eNativeResults?: Record<string, unknown> };
    const mailDir = "~/.agent/mail";
    const envelopes = [
      { id: "m-01", from: "fable", to: "oc-worker", ts: "2026-08-02T22:41:00Z", kind: "request", body: "harness-trace panel lab: build per CONTRACT.md" },
      { id: "m-02", from: "fable", to: "ses_bridge01", ts: "2026-08-02T21:58:00Z", kind: "request", body: "bridge prior-art sweep, keyword-driven" },
      { id: "m-03", from: "opus", to: "kimi-plan", ts: "2026-08-02T20:12:00Z", kind: "request", body: "schemagen MVP plan duel" },
    ].map((e) => JSON.stringify(e)).join("\n");
    // "opus" is deliberately absent: m-03's sender resolves to no session, so
    // session_9adf keeps a null parent.
    const registry = JSON.stringify({
      "oc-worker": "ses_trace77", "kimi-plan": "session_9adf", fable: "4bf4853d", version: 1,
    });
    w.__instantE2eNativeResults = {
      harness_trace_rows: [
        { id: "c1", harness: "claude", sessionId: "4bf4853d", parentId: null, parentKind: null, ts: "2026-08-02T20:05:00Z", lastActivity: "2026-08-02T23:02:00Z", status: "live", cwd: "~/projects/sprefa" },
        { id: "s1", harness: "claude", sessionId: "sub-one", parentId: "4bf4853d", parentKind: "subagent", ts: "2026-08-02T20:20:00Z", lastActivity: "2026-08-02T22:55:00Z", status: "live", cwd: "~/projects/sprefa" },
        { id: "s2", harness: "claude", sessionId: "deep-two", parentId: "sub-one", parentKind: "subagent", ts: "2026-08-02T20:31:00Z", lastActivity: "2026-08-02T22:40:00Z", status: "done", cwd: "~/projects/sprefa" },
        { id: "o1", harness: "opencode", sessionId: "ses_trace77", parentId: null, parentKind: null, ts: "2026-08-02T22:41:00Z", lastActivity: "2026-08-02T23:00:00Z", status: "live", cwd: "~/projects/instant-lab-trace" },
        { id: "o2", harness: "opencode", sessionId: "ses_bridge01", parentId: null, parentKind: null, ts: "2026-08-02T21:58:00Z", lastActivity: "2026-08-02T22:14:00Z", status: "idle", cwd: "~/projects/sprefa-lane-bridge" },
        { id: "x1", harness: "codex", sessionId: "rollout-2026-08-01", parentId: null, parentKind: null, ts: "2026-08-01T09:30:00Z", lastActivity: "2026-08-01T11:02:00Z", status: "done", cwd: "~/projects/sprefa" },
        { id: "k1", harness: "kimi", sessionId: "session_9adf", parentId: null, parentKind: null, ts: "2026-08-02T20:12:00Z", lastActivity: "2026-08-02T20:31:00Z", status: "idle", cwd: "~/projects/sprefa" },
      ],
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
    };
  });
  await page.goto("/e2e-harness-trace.html?e2e=1");

  await page.locator('#actbar [data-panel="harness-trace"]').click();
  const panel = page.getByTestId("harness-trace");
  const rootRow = panel.locator("tr").filter({ hasText: "4bf4853d" });
  await expect(rootRow).toBeVisible();

  // Lazy proof, level 1: no descendant of the collapsed root is in the DOM, and
  // the count line says how many sessions the roots stand for.
  await expect(panel.locator("tr").filter({ hasText: "sub-one" })).toHaveCount(0);
  await expect(panel.locator("tr").filter({ hasText: "ses_trace77" })).toHaveCount(0);
  await expect(panel).toContainText("3 roots · 7 sessions");

  // A sender the registry cannot resolve gets NO invented edge: session_9adf
  // stays a root beside the codex session, both with link "—".
  await expect(panel.locator("tr").filter({ hasText: "session_9adf" })).toBeVisible();
  await expect(panel.locator("tr").filter({ hasText: "rollout-2026-08-01" })).toContainText("user");

  // Level 1 expand: the subagent child and both dispatch children appear, with
  // their mail attribution. The grandchild is still unmaterialized (lazy).
  await rootRow.locator(".tt-twisty").click();
  const subRow = panel.locator("tr").filter({ hasText: "sub-one" });
  await expect(subRow).toBeVisible();
  await expect(panel).toContainText("harness-trace panel lab: build per CONTRACT.md");
  await expect(panel).toContainText("bridge prior-art sweep, keyword-driven");
  await expect(panel.locator("tr").filter({ hasText: "ses_trace77" })).toContainText("dispatch");
  await expect(panel.locator("tr").filter({ hasText: "deep-two" })).toHaveCount(0);

  // Level 2 expand: the grandchild materializes only now.
  await subRow.locator(".tt-twisty").click();
  await expect(panel.locator("tr").filter({ hasText: "deep-two" })).toBeVisible();

  await expect(panel).toHaveScreenshot("harness-trace.png", { animations: "disabled" });

  // The filter box still works over the loaded rows.
  await panel.locator(".tt-search").fill("deep-two");
  await expect(panel.locator("tr").filter({ hasText: "rollout-2026-08-01" })).toHaveCount(0);
  await expect(panel.locator("tr").filter({ hasText: "deep-two" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
