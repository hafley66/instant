import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const BOOP = process.env.BOOP_BIN ?? "/Users/chrishafley/.cargo/bin/boop";
const lane = `proof-external-shell-${process.pid}`;
const session = `${lane}-session`;
const mailDir = `/tmp/${lane}-mail`;
const subprocessEnv = { ...process.env, TMUX: undefined, TMUX_PANE: undefined };

function tmux(args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8", env: subprocessEnv });
}

test.beforeAll(() => {
  try { execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore", env: subprocessEnv }); } catch {}
  execFileSync("tmux", ["new-session", "-d", "-s", session, "sh", "-lc", "printf 'LIVE PANE RECEIPT\\n'; sleep 300"], { stdio: "ignore", env: subprocessEnv });
  execFileSync("mkdir", ["-p", mailDir], { stdio: "ignore" });
});

test.afterAll(() => {
  try { execFileSync("tmux", ["kill-session", "-t", `=${session}`], { stdio: "ignore", env: subprocessEnv }); } catch {}
  execFileSync("rm", ["-rf", mailDir], { stdio: "ignore" });
});

test("Boop live pane opens its contents, survives reload, and close detaches", async ({ page }) => {
  const pane = tmux(["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"]).trim();
  const patched = spawnSync(
    BOOP,
    ["beep", "lane", "patch", "--tmux", session, "--harness", "shell", lane, "--mail-dir", mailDir],
    { encoding: "utf8", env: subprocessEnv },
  );
  expect(patched.status).toBe(0);
  // `lane patch` validates session targets. The running pane itself is the
  // durable route projection consumed by Instant, so make that projection
  // explicit after registration to exercise the `%pane` path.
  const registryPath = `${mailDir}/registry.json`;
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Record<string, { tmux?: string }>;
  registry[lane].tmux = pane;
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  const fetched = spawnSync(
    BOOP,
    ["beep", "lane", "get", lane, "--mail-dir", mailDir],
    { encoding: "utf8", env: subprocessEnv },
  );
  expect(fetched.status, fetched.stderr).toBe(0);
  const row = JSON.parse(fetched.stdout || fetched.stderr);
  expect(row.tmux).toBe(pane);
  const paneText = tmux(["capture-pane", "-p", "-t", pane]);
  const contentB64 = Buffer.from(paneText, "utf8").toString("base64");

  await page.goto(`/e2e-term.html?e2e=1&viewer=1&lane=${encodeURIComponent(row.lane)}&pane=${encodeURIComponent(row.tmux)}&contentB64=${encodeURIComponent(contentB64)}`);
  await page.getByTestId("open-viewer").click();
  await expect(page.locator(".dv-default-tab-content", { hasText: row.lane })).toBeVisible();
  await expect(page.locator(".xterm-screen")).toContainText("LIVE PANE RECEIPT");
  await expect.poll(() => page.evaluate(() => (window as Window & { __externalOpenSession?: Record<string, unknown> }).__externalOpenSession ?? null)).toMatchObject({
    name: row.lane,
    tmuxTarget: row.tmux,
    attachOnly: true,
  });

  await page.reload();
  await expect(page.locator(".dv-default-tab-content", { hasText: row.lane })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as Window & { __externalOpenSession?: Record<string, unknown> }).__externalOpenSession ?? null)).toMatchObject({
    name: row.lane,
    tmuxTarget: row.tmux,
    attachOnly: true,
  });
  await page.keyboard.press("Meta+w");
  await expect(page.locator(".dv-default-tab-content", { hasText: row.lane })).toHaveCount(0);
  expect(() => tmux(["has-session", "-t", `=${session}`])).not.toThrow();
});
