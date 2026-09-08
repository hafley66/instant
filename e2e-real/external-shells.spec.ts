// A shell the app did not start: a tmux session created outside it, registered
// with boop as a lane route, then opened from the tmux rail panel. The tab
// attaches to the running pane, so its text is the pane's own output, a reload
// re-attaches, and closing the tab leaves the session alive.
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boot, burnClaimedPaneIds, closeTabs, killAllSessions, paneId, screenRows, shot, sql, tmux,
  tmuxDefault,
} from "./0_real";

const RECEIPT = "LIVE PANE RECEIPT";

const dirs: string[] = [];
const routes: string[] = [];

/// Bind the pane to a boop lane route the way a lane registration does, under
/// the `proof-` name this file cleans up. `lane patch` validates its target
/// against the default tmux socket, and this pane lives on the app's own
/// socket, so the route row is written directly.
function bindProofLane(session: string): string {
  const route = `proof-extshell-${Date.now().toString(36)}`;
  const pane = paneId(session);
  const held = sql(`select route from agent_route where tmux='${pane}' limit 1`);
  expect(held, `pane ${pane} is already bound`).toBe("");
  sql(`insert or replace into agent_route(route, kind, harness, tmux, session_id, registered_at)
       values ('${route}', 'lane', 'shell', '${pane}', '${session}',
               strftime('%Y-%m-%d %H:%M:%f000', 'now'))`);
  routes.push(route);
  return route;
}

/// Open an existing tmux session as a tab: the rail's tmux panel lists every
/// session the backend can see, and a click on its name opens it. The panel is
/// a dockview tab in the terminal's group, so it is hidden again before the
/// pane can be read.
async function openExistingSession(page: Page, name: string): Promise<void> {
  const toggle = page.locator("#sessions-toggle");
  const row = page.locator("tr", { has: page.locator(".s-name", { hasText: new RegExp(`^${name}$`) }) });
  await expect.poll(async () => {
    if ((await toggle.getAttribute("class"))?.includes("active")) await toggle.click();
    await toggle.click();
    await page.waitForTimeout(1_000);
    return await row.count();
  }, { timeout: 30_000, message: `the tmux panel never listed ${name}` }).toBeGreaterThan(0);
  await row.locator(".s-name").click();
  if ((await toggle.getAttribute("class"))?.includes("active")) await toggle.click();
  await expect(page.locator(".term-host .xterm-screen").last()).toBeVisible({ timeout: 20_000 });
}

const paneText = (page: Page): Promise<string> => screenRows(page).then((rows) => rows.join("\n"));

const tabFor = (page: Page, name: string) => page.locator(".dv-default-tab-content", { hasText: name });

/// ⌘W on the window tinykeys listens on, the chord that closes the active tab.
async function closeTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", metaKey: true, bubbles: true, cancelable: true }));
  });
}

test.afterEach(async ({ page }) => {
  await closeTabs(page);
  for (const route of routes.splice(0)) sql(`delete from agent_route where route='${route}'`);
  killAllSessions();
});

test.afterAll(() => {
  killAllSessions();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  // Receipt that nothing this file made survives it.
  expect(tmuxDefault(["list-sessions", "-F", "#{session_name}"]).split("\n").filter((name) => name.startsWith("proof-"))).toEqual([]);
  expect(sql("select count(*) from agent_route where route like 'proof-%'")).toBe("0");
});

// The open and the close legs pass against the real backend; the reload leg
// does not. A reload restores the tab in the bar, and the pane's host element
// stays parked in `#panel-pool` at 0x0, so the pane never paints again.
test.fixme("Boop live pane opens its contents, survives reload, and close detaches", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "proof-extshell-"));
  dirs.push(dir);
  await boot(page);
  // tmux hands out pane ids per server, and boop keys a lane by the bare id, so
  // probe panes burn every id a real lane already holds before the shell opens.
  burnClaimedPaneIds();
  const session = `proof-extshell-${Date.now().toString(36)}`;
  // `-n`: the tab takes tmux's window name, and an unnamed window would be
  // called after the command instead of the session.
  tmux(["new-session", "-d", "-s", session, "-n", session, "-c", dir, "sh", "-lc", `printf '${RECEIPT}\\n'; sleep 300`]);
  expect(tmux(["list-sessions", "-F", "#{session_name}"]).split("\n")).toContain(session);
  const route = bindProofLane(session);
  expect(sql(`select session_id from agent_route where route='${route}'`)).toBe(session);

  await openExistingSession(page, session);
  await expect(tabFor(page, session)).toHaveCount(1);
  await expect.poll(() => paneText(page), { timeout: 20_000 }).toContain(RECEIPT);

  // A reload rebuilds the tab from the persisted list and re-attaches to the
  // same pane, so the pane's text comes back with it.
  await page.reload();
  await expect(page.locator("#sessions-toggle")).toBeVisible({ timeout: 30_000 });
  await expect(tabFor(page, session)).toHaveCount(1, { timeout: 30_000 });
  // The restored layout can put another panel of the group on top, so the tab
  // is clicked the way a user brings its pane back to the front.
  await tabFor(page, session).click();
  await expect(page.locator(".term-host .xterm-screen").last()).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => paneText(page), { timeout: 30_000 }).toContain(RECEIPT);
  await shot(page, "external-shells-01-attached");

  // Closing the tab drops the app's pty; the session it attached to keeps running.
  await closeTab(page);
  await expect(tabFor(page, session)).toHaveCount(0, { timeout: 20_000 });
  expect(spawnSync("tmux", ["-L", process.env.INSTANT_REAL_SOCKET ?? "instant-real-e2e", "has-session", "-t", `=${session}`]).status).toBe(0);
});
