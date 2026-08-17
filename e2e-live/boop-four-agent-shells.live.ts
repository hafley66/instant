import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const BOOP = process.env.BOOP_BIN ?? "/Users/chrishafley/.cargo/bin/boop";
const REPO = "/Users/chrishafley/projects/instant";
const suffix = `${process.pid}`;
const specs = [
  { branch: `chore/e2e-luna-a-${suffix}`, preset: "luna", harness: "codex" },
  { branch: `chore/e2e-luna-b-${suffix}`, preset: "luna", harness: "codex" },
  { branch: `chore/e2e-haiku-a-${suffix}`, model: "haiku", harness: "claude" },
  { branch: `chore/e2e-haiku-b-${suffix}`, model: "haiku", harness: "claude" },
];
const lanes = specs.map((spec) => spec.branch.replace("/", "-"));
const temp = mkdtempSync(join(tmpdir(), "instant-four-agent-"));
const brief = join(temp, "brief.md");

function boop(args: string[]): string {
  return execFileSync(BOOP, args, { cwd: REPO, encoding: "utf8", timeout: 30_000 });
}

test.describe.configure({ timeout: 240_000 });

test.beforeAll(async () => {
  writeFileSync(brief, "Remain available for the external-shell E2E. Run `sleep 180`, then reply done. Do not edit files.\n");
  for (const spec of specs) {
    const args = ["beep", "lane", "create", "--branch", spec.branch, "--brief", brief, "--cwd", REPO, "--base-sha", "HEAD", "--no-start", "--harness", spec.harness];
    if (spec.preset) args.push("--preset", spec.preset);
    if (spec.model) args.push("--model", spec.model);
    boop(args);
  }
  await expect.poll(() => {
    const list = boop(["beep", "lane", "list"]);
    return lanes.filter((lane) => new RegExp(`^live\\s+${lane}\\s`, "m").test(list)).length;
  }, { timeout: 60_000 }).toBe(4);
});

test.afterAll(() => {
  for (const lane of lanes) {
    try { boop(["beep", "lane", "delete", lane]); } catch {}
  }
  for (const spec of specs) {
    const worktree = join(REPO, ".boop-worktrees", spec.branch);
    try { execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: REPO }); } catch {}
    try { execFileSync("git", ["branch", "-D", spec.branch], { cwd: REPO }); } catch {}
  }
  rmSync(temp, { recursive: true, force: true });
});

test("refreshes four Boop shell rows and opens every exact target", async ({ page }) => {
  const list = boop(["beep", "lane", "list"]);
  const rows = list.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6 || !lanes.includes(fields[1])) return [];
    return [{ state: fields[0], lane: fields[1], harness: fields[2], mode: fields[3], model: fields[4], tmux: fields[5], cwd: fields.slice(6).join(" ") }];
  });
  expect(rows).toHaveLength(4);
  const encoded = Buffer.from(JSON.stringify(rows)).toString("base64");
  await page.goto(`/e2e-term.html?e2e=1&boopRowsB64=${encodeURIComponent(encoded)}`);
  await page.getByTestId("open-term").click();
  await page.keyboard.press("Meta+Shift+Period");
  await expect(page.getByTestId("boop-external-shell-strip")).toContainText("4 live");
  for (const row of rows) await expect(page.getByTestId("boop-external-shell-strip")).toContainText(`${row.lane}`);

  await page.reload();
  await page.getByTestId("open-term").click();
  await expect(page.getByTestId("boop-external-shell-strip")).toContainText("4 live");
  for (const row of rows) {
    await page.getByTestId("boop-external-shell-strip").getByText(row.lane, { exact: true }).dblclick();
    await expect.poll(() => page.evaluate(() => (window as Window & { __externalOpenSession?: Record<string, unknown> }).__externalOpenSession ?? null)).toMatchObject({
      name: row.lane,
      tmuxTarget: row.tmux,
      attachOnly: true,
    });
    await page.keyboard.press("Meta+w");
  }
});
