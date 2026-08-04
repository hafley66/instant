import { expect, test } from "@playwright/test";

// Dock-strip (CONTRACT2): the "who called who" tree mounted as a bottom strip.
// Fixtures: one claude parent with two subagent children (one live, one done)
// plus one cross-harness dispatch child (opencode, parentKind dispatch via the
// mail ledger). The store tmux session's pwd matches the parent + live-subagent
// cwd, so those two rows join a tmux session; the dispatch child stays unjoined.
test("dock strip mounts below, shows children under parents, opens joined rows", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // relTime cells render against Date.now(); freeze it so the screenshot
  // baseline is date-independent.
  await page.clock.setFixedTime(new Date("2026-08-03T12:00:00Z"));
  const mailDir = "~/.agent/mail";
  const envelopes = [
    { id: "m-01", from: "par-driver", to: "oc-chan", ts: "2026-08-02T22:40:00Z", kind: "dispatch", body: "build the strip\nfull brief below" },
  ].map((e) => JSON.stringify(e)).join("\n");
  const registry = JSON.stringify({ "oc-chan": "oc-dispatch", "par-driver": "parent-uuid", version: 1 });
  await page.addInitScript(({ mailDir, envelopes, registry }) => {
    const w = window as Window & { __instantE2eNativeResults?: Record<string, unknown> };
    w.__instantE2eNativeResults = {
      harness_trace_rows: [
        { id: "parent-uuid", harness: "claude", sessionId: "parent-uuid", parentId: null, parentKind: null, ts: "2026-08-02T20:00:00Z", lastActivity: "2026-08-02T23:00:00Z", status: "live", cwd: "~/projects/dock-demo" },
        { id: "sub-live", harness: "claude", sessionId: "sub-live", parentId: "parent-uuid", parentKind: "subagent", ts: "2026-08-02T20:10:00Z", lastActivity: "2026-08-02T22:50:00Z", status: "live", cwd: "~/projects/dock-demo" },
        { id: "sub-done", harness: "claude", sessionId: "sub-done", parentId: "parent-uuid", parentKind: "subagent", ts: "2026-08-02T20:20:00Z", lastActivity: "2026-08-02T21:00:00Z", status: "done", cwd: "~/projects/dock-archive" },
        { id: "oc-dispatch", harness: "opencode", sessionId: "oc-dispatch", parentId: null, parentKind: null, ts: "2026-08-02T22:40:00Z", lastActivity: "2026-08-02T22:41:00Z", status: "live", cwd: "~/projects/dock-other" },
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
  }, { mailDir, envelopes, registry });
  await page.goto("/e2e-dock-strip.html?e2e=1");

  const strip = page.getByTestId("dock-strip");
  const opened = () => page.evaluate(() => (window as Window & { __dockStripOpened?: string }).__dockStripOpened ?? null);

  // Open the strip from the rail. It should mount in a BOTTOM group: the strip's
  // panel sits below the sessions group (larger y).
  await page.locator('#actbar [data-panel="dock-strip"]').click();
  await expect(strip).toBeVisible();
  const sessionsBox = await page.getByTestId("sessions-panel").boundingBox();
  const stripBox = await strip.boundingBox();
  expect(stripBox!.y).toBeGreaterThan(sessionsBox!.y);

  // Parent is a top-level row, children are collapsed by default (tree law).
  const parentRow = page.locator("tr").filter({ hasText: "parent-uuid" });
  await expect(parentRow).toBeVisible();
  await expect(page.locator("tr").filter({ hasText: "sub-live" })).toHaveCount(0);
  await expect(page.locator("tr").filter({ hasText: "oc-dispatch" })).toHaveCount(0);

  // Expand the parent: its two subagent children + the dispatch child appear.
  await parentRow.locator(".tt-twisty").click();
  await expect(page.locator("tr").filter({ hasText: "sub-live" })).toBeVisible();
  await expect(page.locator("tr").filter({ hasText: "sub-done" })).toBeVisible();
  await expect(page.locator("tr").filter({ hasText: "oc-dispatch" })).toBeVisible();

  // Activating a joined row (parent-uuid -> tmux-dock) calls the bridge onOpen.
  await page.evaluate(() => ((window as Window & { __dockStripOpened?: string }).__dockStripOpened = undefined));
  await parentRow.locator(".s-name").click();
  await expect.poll(opened).toBe("tmux-dock");

  // Activating an unjoined row (oc-dispatch) calls nothing: the spy is unchanged.
  await page.locator("tr").filter({ hasText: "oc-dispatch" }).locator(".s-name").click();
  expect(await opened()).toBe("tmux-dock");

  await expect(page.locator("tr").filter({ hasText: "sub-live" })).toBeVisible();
  await expect(strip).toHaveScreenshot("dock-strip.png", { animations: "disabled" });
  expect(pageErrors).toEqual([]);
});

// Sabotage twin (RCA 2026-08-03): a registry-routed lane whose tmux is dead
// renders as a history row, and its click must never reach the bridge — before
// the openAction guard, `tmux new-session -A` minted an empty shell under the
// lane's name.
test("a routed row whose tmux is dead never opens", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.clock.setFixedTime(new Date("2026-08-03T12:00:00Z"));
  const mailDir = "~/.agent/mail";
  const registry = JSON.stringify({
    "lane-x": { sessionId: "", harness: "shell", tmux: "lane-dead", cwd: "~/projects/dock-other" },
    version: 1,
  });
  await page.addInitScript(({ mailDir, registry }) => {
    const w = window as Window & { __instantE2eNativeResults?: Record<string, unknown> };
    w.__instantE2eNativeResults = {
      harness_trace_rows: [
        { id: "parent-uuid", harness: "claude", sessionId: "parent-uuid", parentId: null, parentKind: null, ts: "2026-08-02T20:00:00Z", lastActivity: "2026-08-02T23:00:00Z", status: "live", cwd: "~/projects/dock-demo" },
      ],
      list_dir: (args?: Record<string, unknown>) => {
        if (args?.path === mailDir) {
          return { entries: [{ name: "registry.json", path: `${mailDir}/registry.json`, is_dir: false }] };
        }
        throw new Error("no such dir");
      },
      read_text: (args?: Record<string, unknown>) => {
        if (args?.path === `${mailDir}/registry.json`) return registry;
        throw new Error("no such file");
      },
    };
  }, { mailDir, registry });
  await page.goto("/e2e-dock-strip.html?e2e=1");

  const opened = () => page.evaluate(() => (window as Window & { __dockStripOpened?: string }).__dockStripOpened ?? null);
  await page.locator('#actbar [data-panel="dock-strip"]').click();
  await expect(page.getByTestId("dock-strip")).toBeVisible();

  // The dead-routed lane renders (status done, tmux name shown) but a click
  // leaves the bridge untouched.
  const deadRow = page.locator("tr").filter({ hasText: "lane-x" });
  await expect(deadRow).toBeVisible();
  await expect(deadRow).toContainText("done");
  await deadRow.locator(".s-name").click();
  expect(await opened()).toBe(null);

  // Positive control: the live-joined row still opens through the same guard.
  await page.locator("tr").filter({ hasText: "parent-uuid" }).locator(".s-name").click();
  await expect.poll(opened).toBe("tmux-dock");
  expect(pageErrors).toEqual([]);
});
