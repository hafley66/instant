// Live boop lanes over the real backend. A lane is a tmux session on the
// default socket whose pane runs a stub harness executable, registered with
// `boop beep lane patch`, which writes the route boop's own store keeps. The
// Boop rail panel is the surface that rows those lanes now: the in-tab strip,
// the dock strip panel, the going-on bar and the waterfall panel were all
// removed from the product in 061a2bc0.
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOP, boot, closeTabs, killAllSessions, shot, sql, stubHarnesses, tmuxDefault,
} from "./0_real";

const dirs: string[] = [];
const lanes: string[] = [];

const proofName = (label: string) => `proof-${label}-${Date.now().toString(36)}`;

const hasDefaultSession = (name: string): boolean =>
  spawnSync("tmux", ["has-session", "-t", `=${name}`]).status === 0;

/// A lane the way boop registers one whose pane already exists: a tmux session
/// on the default socket running the stub harness, then `lane patch` to point
/// the route at it. No model process is started.
async function dispatchLane(label: string): Promise<string> {
  const lane = proofName(label);
  const dir = mkdtempSync(join(tmpdir(), "proof-cwd-"));
  dirs.push(dir);
  const bytes = join(dir, "pane.txt");
  writeFileSync(bytes, "LANE PANE RECEIPT\n");
  const stubDir = await stubHarnesses();
  const created = spawnSync("tmux", ["new-session", "-d", "-s", lane, "-c", dir, join(stubDir, "codex"), bytes, "0"]);
  expect(created.status, `tmux new-session ${lane}`).toBe(0);
  const patched = spawnSync(
    BOOP,
    ["beep", "lane", "patch", "--tmux", lane, "--harness", "codex", "--cwd", dir, lane],
    { encoding: "utf8" },
  );
  expect(patched.status, patched.stderr).toBe(0);
  lanes.push(lane);
  return lane;
}

function dropLane(lane: string): void {
  spawnSync(BOOP, ["beep", "lane", "delete", lane], { encoding: "utf8" });
  spawnSync("tmux", ["kill-session", "-t", `=${lane}`]);
  sql(`delete from agent_route where route='${lane}'`);
}

/// The Boop rail panel, sorted newest first. The roster is a virtual table over
/// every lane boop knows, so a fresh lane is brought to the top by the
/// `started` header before the test looks for it.
async function openBoopPanel(page: Page): Promise<void> {
  await page.locator("#boop-toggle").click();
  const started = page.locator("th", { hasText: "started" }).first();
  await expect(started).toBeVisible({ timeout: 20_000 });
  await started.click();
  await started.click();
}

/// The lane's own row state, read from the class the roster paints its name
/// with: `boop-open` while the pane is alive, `boop-closed` once it is gone.
async function laneState(page: Page, lane: string): Promise<string> {
  if (await page.locator("td.boop-open", { hasText: lane }).count()) return "live";
  if (await page.locator("td.boop-closed", { hasText: lane }).count()) return "closed";
  return "absent";
}

test.afterEach(async ({ page }) => {
  await closeTabs(page);
  for (const lane of lanes.splice(0)) dropLane(lane);
  killAllSessions();
});

test.afterAll(() => {
  killAllSessions();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  // Receipt that nothing this file made survives it.
  expect(tmuxDefault(["list-sessions", "-F", "#{session_name}"]).split("\n").filter((name) => name.startsWith("proof-"))).toEqual([]);
  expect(sql("select count(*) from agent_route where route like 'proof-%'")).toBe("0");
});

test("a dispatched lane rows the panel; its death drops the row with zero clicks", async ({ page }) => {
  await boot(page);
  await openBoopPanel(page);
  const lane = await dispatchLane("row");
  expect(hasDefaultSession(lane)).toBe(true);

  // Every transition after the panel is open belongs to its own poll; the test
  // clicks nothing more.
  await expect.poll(() => laneState(page, lane), { timeout: 45_000 }).toBe("live");
  await shot(page, "strip-live-01-live-row");

  spawnSync("tmux", ["kill-session", "-t", `=${lane}`]);
  await expect.poll(() => laneState(page, lane), { timeout: 45_000 }).toBe("absent");
  await shot(page, "strip-live-02-row-dropped");
});

// The strip drew an X per row that killed the lane's tmux session. No surviving
// panel carries a kill control, so the gesture has no surface to run on.
test.fixme("the row X kills the real tmux session", async () => {});

// The Boop roster drops a lane the moment its pane dies, so a done lane has no
// row to render as history and none to double-click.
test.fixme("a done lane renders as history and its double-click never mints a session", async () => {});

// The waterfall panel and its overview brush left the product with the rest of
// the harness-trace plugin; the roster's spark column draws mail dots and has
// no brush to narrow.
test.fixme("history waterfall bars real lanes and the brush narrows them away", async () => {});
