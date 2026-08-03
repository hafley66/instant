import { expect, test } from "@playwright/test";

// In-tab relation strip (CONTRACT3): the same AgentSessionNode tree as the dock
// strip, mounted INSIDE a terminal tab beneath the xterm area and filtered to
// the trees containing a node joined to THIS terminal's tmux session.
// Fixtures: tree 1 = claude parent + subagent child, both in the s1 tmux cwd
// (so both join s1); tree 2 = another claude parent + child in the s2 cwd.
// The terminal's sid is "s1", so the strip keeps all of tree 1 and drops tree 2.
test("in-tab strip renders under the term, filters by tmux, pushes and pops the router", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  // relTime cells render against Date.now(); freeze it so the screenshot
  // baseline is date-independent.
  await page.clock.setFixedTime(new Date("2026-08-03T12:00:00Z"));
  const mailDir = "~/.agent/mail";
  const envelopes = "";
  const registry = JSON.stringify({ version: 1 });
  await page.addInitScript(({ mailDir, envelopes, registry }) => {
    const w = window as Window & { __instantE2eNativeResults?: Record<string, unknown> };
    w.__instantE2eNativeResults = {
      harness_trace_rows: [
        { id: "parent-s1", harness: "claude", sessionId: "parent-s1", parentId: null, parentKind: null, ts: "2026-08-03T10:00:00Z", lastActivity: "2026-08-03T11:00:00Z", status: "live", cwd: "~/projects/demo" },
        { id: "child-s1", harness: "claude", sessionId: "child-s1", parentId: "parent-s1", parentKind: "subagent", ts: "2026-08-03T10:10:00Z", lastActivity: "2026-08-03T10:50:00Z", status: "live", cwd: "~/projects/demo" },
        { id: "parent-other", harness: "claude", sessionId: "parent-other", parentId: null, parentKind: null, ts: "2026-08-03T09:00:00Z", lastActivity: "2026-08-03T09:30:00Z", status: "done", cwd: "~/projects/other" },
        { id: "child-other", harness: "claude", sessionId: "child-other", parentId: "parent-other", parentKind: "subagent", ts: "2026-08-03T09:05:00Z", lastActivity: "2026-08-03T09:20:00Z", status: "done", cwd: "~/projects/other" },
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

  // Filtered to tree 1 only: the parent is visible, tree 2 (joined to s2) is dropped.
  const parentRow = page.locator("tr").filter({ hasText: "parent-s1" });
  await expect(parentRow).toBeVisible();
  await expect(page.locator("tr").filter({ hasText: "parent-other" })).toHaveCount(0);

  // Expand the parent and click the subagent child: it opens s1 (bridge) and
  // pushes the row onto the router, so the "viewing:" header appears.
  await parentRow.locator(".tt-twisty").click();
  const childRow = page.locator("tr").filter({ hasText: "child-s1" });
  await expect(childRow).toBeVisible();
  await page.evaluate(() => ((window as Window & { __dockStripOpened?: string }).__dockStripOpened = undefined));
  await childRow.locator(".s-name").click();
  await expect(page.getByText("viewing: child-s1")).toBeVisible();
  await expect.poll(opened).toBe("s1");

  // Clicking back pops the router and clears the header.
  await page.locator(".term-strip .strip-back").click();
  await expect(page.getByText("viewing: child-s1")).toHaveCount(0);

  await expect(strip).toHaveScreenshot("dock-strip-in-tab.png", { animations: "disabled" });
  expect(pageErrors).toEqual([]);
});
