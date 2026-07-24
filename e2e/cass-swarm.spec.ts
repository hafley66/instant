import { expect, test } from "@playwright/test";

test("CASS swarm renders subagent coordination data", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const w = window as Window & { __instantE2eNativeResults?: Record<string, unknown> };
    w.__instantE2eNativeResults = {
      cass_swarm_status: {
        schema_version: "cass.swarm.status.v1",
        status: "ready",
        providers: [
          { name: "agent_mail", source: "agent-mail", status: "ready" },
          { name: "beads", source: "beads", status: "degraded", warning: "stale by 5m" },
        ],
        summary: {
          ready_count: 1,
          in_progress_count: 1,
          blocked_count: 1,
          active_agent_count: 2,
          active_reservation_count: 1,
          dirty_worktree: true,
          recommended_action: "review blocked work",
        },
        beads: {
          ready: [{ id: "instant-1", title: "Render swarm panel", owner: "agent-ui" }],
          in_progress: [{ id: "instant-2", title: "Read CASS status", owner: "agent-data" }],
          blocked: [{ id: "instant-3", title: "Capture swarm photo", reason: "waiting on provider" }],
        },
        agents: [
          {
            agent_id: "agent-ui",
            state: "working",
            task: "Render panel",
            messages: [{ role: "assistant", summary: "Rendering the CASS panel" }],
            calls: [{ status: "complete", tool: "exec_command", command: "pnpm test" }],
          },
          { agent_id: "agent-data", state: "waiting", task: "Read status" },
        ],
        reservations: [{ id: "reserve-1", status: "active", path: "src/plugins/cass" }],
      },
    };
  });
  await page.goto("/e2e-cass.html?e2e=1");

  await page.locator("#cass-swarm-toggle").click();
  const panel = page.getByTestId("cass-swarm");
  await expect(panel).toHaveAttribute("data-state", "ready");
  await expect(panel).toContainText("agent-ui");
  await expect(panel).toContainText("Render panel");
  await expect(panel).toContainText("agents 2");
  expect(await page.evaluate(() => (window as Window & { __instantE2eNativeCalls?: string[] }).__instantE2eNativeCalls ?? [])).toEqual(["cass_swarm_status"]);

  await panel.locator("tr").filter({ hasText: "agent-ui" }).dblclick();
  await expect(panel).toContainText("Rendering the CASS panel");
  await expect(panel).toContainText("exec_command");

  await panel.locator("select").selectOption("work");
  await expect(panel).toContainText("Capture swarm photo");
  await panel.locator("select").selectOption("provider");
  await expect(panel).toContainText("agent_mail");
  await expect(panel).toContainText("stale by 5m");
  await panel.locator("select").selectOption("agent");
  await expect(panel).toHaveScreenshot("cass-swarm.png", { animations: "disabled" });
  expect(pageErrors).toEqual([]);
});
