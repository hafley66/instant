// The fork verb, end to end, in Chromium against instant-serve: a real tab on
// the app's own tmux socket, a word pinned by double-click, the right-click
// menu, Fork selection, a preset, the note prompt, Enter. Receipts come from
// outside the page: the comment row, the fork link row, the tmux session boop
// made, and a PNG at every step under artifacts/real/.
import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = path.join(root, "artifacts", "real");
const SOCKET = "instant-real-e2e";
const BOOP = process.env.BOOP_BIN ?? path.join(process.env.HOME ?? "", ".cargo/bin/boop");
const DB = path.join(process.env.HOME ?? "", ".agent/boop.db");

const sql = (q: string): string => {
  const r = spawnSync("sqlite3", [DB, q], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sqlite3: ${r.stderr}`);
  return r.stdout.trim();
};
const tmux = (args: string[]): string => spawnSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8" }).stdout ?? "";
const tmuxHasDefault = (name: string): boolean => spawnSync("tmux", ["has-session", "-t", `=${name}`]).status === 0;
const sessions = (): string[] => tmux(["list-sessions", "-F", "#{session_name}"]).split("\n").filter(Boolean);

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

const errors: string[] = [];
async function boot(page: Page): Promise<void> {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto("/?ws=ws://127.0.0.1:47790/ws");
  await expect(page.locator("#sessions-toggle")).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => document.fonts.status === "loaded");
}

// Cmd+T is the keymap's "new tab at current directory"; a synthetic keydown on
// the window reaches tinykeys the way the real chord does.
async function openTab(page: Page): Promise<string> {
  const before = new Set(sessions());
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", code: "KeyT", metaKey: true, bubbles: true, cancelable: true }));
  });
  let name = "";
  await expect.poll(() => {
    name = sessions().find((s) => !before.has(s)) ?? "";
    return name;
  }, {
    timeout: 15_000,
    message: `no new tmux session; before=${[...before]} now=${sessions()} hosts=${await page.locator(".term-host").count()} errors=${errors.join(" / ")}`,
  }).not.toBe("");
  await expect(page.locator(".term-host .xterm-screen").last()).toBeVisible();
  await page.waitForTimeout(1_500);
  return name;
}

const typeLine = (session: string, line: string) => tmux(["send-keys", "-t", `${session}:`, line, "Enter"]);

// The store re-reads every pane's cwd when the tmux panel shows; nothing polls
// it. Showing the panel after a `cd` is what a user does to see the new path.
// The rail button carries `active` while its panel is open; hide then show is
// the refresh. Rows are the React table's `tr`s, one `.s-name` per session.
async function settleCwd(page: Page, session: string, needle: string): Promise<void> {
  const toggle = page.locator("#sessions-toggle");
  const row = page.locator("tr", { has: page.locator(".s-name", { hasText: new RegExp(`^${session}$`) }) });
  await expect.poll(async () => {
    if ((await toggle.getAttribute("class"))?.includes("active")) await toggle.click();
    await toggle.click();
    await page.waitForTimeout(1_500);
    return (await row.locator(".s-pwd").textContent().catch(() => "")) ?? "";
  }, { timeout: 30_000, message: `cwd of ${session} never showed ${needle}` }).toContain(needle);
  // The panel is a dockview tab in the terminal's group: while it is up the
  // terminal host has no width. Hide it so the pane is back in front.
  await toggle.click();
  await expect(page.locator(".term-host .xterm-screen").last()).toBeVisible();
  await page.waitForTimeout(500);
}

async function cell(page: Page, row: number, col: number): Promise<{ x: number; y: number }> {
  return page.evaluate(([r, c]) => {
    const host = [...document.querySelectorAll<HTMLElement>(".term-host")].find((h) => h.getBoundingClientRect().width > 0)!;
    const box = host.querySelector(".xterm-screen")!.getBoundingClientRect();
    // xterm measures a 32-character span, so one column is a 32nd of its width.
    const m = host.querySelector(".xterm-char-measure-element")!.getBoundingClientRect();
    const cellW = m.width / 32;
    return { x: Math.round(box.left + (c + 0.5) * cellW), y: Math.round(box.top + (r + 0.5) * m.height) };
  }, [row, col]);
}

async function menuRow(page: Page, label: string) {
  const row = page.locator(".ctx-menu [data-nav-id]").filter({ has: page.locator(".ctx-label", { hasText: label }) }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  return row;
}

async function forkFlow(page: Page, word: string, note: string, tag: string): Promise<void> {
  const at = await cell(page, 0, 3);
  await page.mouse.dblclick(at.x, at.y);
  await page.waitForTimeout(300);
  await page.mouse.click(at.x, at.y, { button: "right" });
  await expect(page.locator(".ctx-menu")).toBeVisible();
  await shot(page, `${tag}-02-menu`);
  // The Fork row runs its main preset on click; the preset submenu opens on hover.
  await (await menuRow(page, "Fork selection")).hover();
  const preset = await menuRow(page, "flash4");
  await shot(page, `${tag}-03-presets`);
  await preset.click();
  const input = page.locator(".cmdp-input");
  await expect(input).toBeVisible();
  await shot(page, `${tag}-04-prompt-empty`);
  await input.fill(note);
  await shot(page, `${tag}-04-prompt`);
  await input.press("Enter");
}

async function toast(page: Page): Promise<string> {
  const el = page.locator(".app-toast.on");
  await expect(el).toBeVisible({ timeout: 30_000 });
  return (await el.textContent()) ?? "";
}

test.afterAll(() => {
  if (process.env.INSTANT_E2E_KEEP) return;
  for (const s of sessions()) tmux(["kill-session", "-t", `=${s}`]);
});

test("a word in a repo tab forks on flash4 with a note, and the app names the lane boop made", async ({ page }) => {
  const word = `forkproof${Date.now().toString(36)}`;
  await boot(page);
  const session = await openTab(page);
  typeLine(session, `cd ${root}`);
  await page.waitForTimeout(800);
  await settleCwd(page, session, "condom");
  typeLine(session, `clear; echo ${word}`);
  await page.waitForTimeout(1_500);
  await shot(page, "fork-01-tab");

  await forkFlow(page, word, `proof note ${word}`, "fork");
  const text = await toast(page);
  await shot(page, "fork-05-toast");

  const commentId = sql(`select comment_id from agent_turn_comment where note='proof note ${word}' order by comment_id desc limit 1`);
  expect(commentId, `no comment row carried the note; toast: ${text}`).not.toBe("");
  const lane = sql(`select lane from agent_turn_comment_fork where comment_id=${commentId}`);
  const errorPanel = await page.evaluate(() => document.getElementById("boot-error")?.innerText ?? "");
  try {
    expect(lane, `no fork row; toast: ${text}; error panel: ${errorPanel}`).toBe(`fork-comment-${commentId}`);
    expect(text).toBe(`fork-comment-${commentId} spawned, flash4`);
    expect(tmuxHasDefault(`fork-comment-${commentId}`), "tmux session for the lane").toBe(true);
    expect(errorPanel).toBe("");
  } finally {
    spawnSync(BOOP, ["beep", "lane", "delete", `fork-comment-${commentId}`], { encoding: "utf8" });
  }
});

test("a word in a tab outside any repo fails in the open: toast and error panel carry boop's line", async ({ page }) => {
  const word = `forkfail${Date.now().toString(36)}`;
  await boot(page);
  const session = await openTab(page);
  typeLine(session, "cd /private/tmp");
  await page.waitForTimeout(800);
  await settleCwd(page, session, "/private/tmp");
  typeLine(session, `clear; echo ${word}`);
  await page.waitForTimeout(1_500);

  await forkFlow(page, word, `proof note ${word}`, "forkfail");
  const text = await toast(page);
  await page.waitForTimeout(200);
  await shot(page, "forkfail-06-failure");

  const commentId = sql(`select comment_id from agent_turn_comment where note='proof note ${word}' order by comment_id desc limit 1`);
  const lane = sql(`select lane from agent_turn_comment_fork where comment_id=${commentId || -1}`);
  const errorPanel = await page.evaluate(() => document.getElementById("boot-error")?.innerText ?? "");
  if (lane) spawnSync(BOOP, ["beep", "lane", "delete", lane], { encoding: "utf8" });
  expect(lane, `a fork spawned from a non-repo tab: ${lane}`).toBe("");
  expect(text).toMatch(/^fork failed: /);
  expect(errorPanel).toMatch(/no git repo at/);
});
