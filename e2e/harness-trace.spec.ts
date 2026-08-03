import { expect, test } from "@playwright/test";

// Coordinator-authored proof spec (identical fixtures to the flash lane's spec;
// only the mail-dir path and registry location differ to match this
// implementation's "~/.agent/mail" + in-dir registry.json convention).
test("harness trace renders cross-harness sessions with mail attribution", async ({ page }) => {
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
    const registry = JSON.stringify({
      "oc-worker": "ses_trace77", "kimi-plan": "session_9adf", version: 1,
    });
    w.__instantE2eNativeResults = {
      harness_trace_rows: [
        { id: "c1", harness: "claude", sessionId: "4bf4853d", ts: "2026-08-02T20:05:00Z", lastActivity: "2026-08-02T23:02:00Z", status: "live", cwd: "~/projects/sprefa" },
        { id: "o1", harness: "opencode", sessionId: "ses_trace77", ts: "2026-08-02T22:41:00Z", lastActivity: "2026-08-02T23:00:00Z", status: "live", cwd: "~/projects/instant-lab-trace" },
        { id: "o2", harness: "opencode", sessionId: "ses_bridge01", ts: "2026-08-02T21:58:00Z", lastActivity: "2026-08-02T22:14:00Z", status: "idle", cwd: "~/projects/sprefa-lane-bridge" },
        { id: "x1", harness: "codex", sessionId: "rollout-2026-08-01", ts: "2026-08-01T09:30:00Z", lastActivity: "2026-08-01T11:02:00Z", status: "done", cwd: "~/projects/sprefa" },
        { id: "k1", harness: "kimi", sessionId: "session_9adf", ts: "2026-08-02T20:12:00Z", lastActivity: "2026-08-02T20:31:00Z", status: "idle", cwd: "~/projects/sprefa" },
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
  // Mail join proves flow B: registry-mapped and direct-to joins both enrich.
  await expect(panel).toContainText("harness-trace panel lab: build per CONTRACT.md");
  await expect(panel).toContainText("bridge prior-art sweep, keyword-driven");
  await expect(panel).toContainText("schemagen MVP plan duel");
  // Un-dispatched session stays "user"/"".
  await expect(panel.locator("tr").filter({ hasText: "4bf4853d" })).toContainText("user");
  await expect(panel).toHaveScreenshot("harness-trace.png", { animations: "disabled" });
  expect(pageErrors).toEqual([]);
});
