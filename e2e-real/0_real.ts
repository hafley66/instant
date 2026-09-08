// Shared edges of the real tier: the built bundle in Chromium against
// instant-serve on a private tmux socket. Every spec drives the app the way a
// user does (keys, mouse, tmux panes) and reads receipts from the DOM, tmux,
// the file system, or boop's sqlite store. No fixture page, no window hook.
import { expect, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const shots = path.join(root, "artifacts", "real");
export const PORT = Number(process.env.INSTANT_REAL_PORT ?? 47790);
export const SOCKET = process.env.INSTANT_REAL_SOCKET ?? "instant-real-e2e";
export const BOOP = process.env.BOOP_BIN ?? path.join(process.env.HOME ?? "", ".cargo/bin/boop");
export const DB = path.join(process.env.HOME ?? "", ".agent/boop.db");

export const sql = (q: string): string => {
  const r = spawnSync("sqlite3", [DB, q], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`sqlite3: ${r.stderr}`);
  return r.stdout.trim();
};

/// tmux on the app's private socket.
export const tmux = (args: string[]): string => spawnSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8" }).stdout ?? "";
/// tmux on the default socket, where boop lanes live.
export const tmuxDefault = (args: string[]): string => spawnSync("tmux", args, { encoding: "utf8" }).stdout ?? "";
export const tmuxHasDefault = (name: string): boolean => spawnSync("tmux", ["has-session", "-t", `=${name}`]).status === 0;
export const sessions = (): string[] => tmux(["list-sessions", "-F", "#{session_name}"]).split("\n").filter(Boolean);
export const killAllSessions = (): void => { for (const s of sessions()) tmux(["kill-session", "-t", `=${s}`]); };

/// Type a line into a session's active pane and press Enter.
export const typeLine = (session: string, line: string): string => tmux(["send-keys", "-t", `${session}:`, line, "Enter"]);
/// Raw keys, no Enter (`send-keys -l` sends the string literally).
export const typeRaw = (session: string, text: string): string => tmux(["send-keys", "-t", `${session}:`, "-l", text]);
/// The pane's visible screen as tmux sees it, one string per row.
export const paneScreen = (session: string): string[] => tmux(["capture-pane", "-p", "-t", `${session}:`]).split("\n");

export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

export const errors: string[] = [];
/// Load the bundle and wait for the rail. The side service on :7748 is not
/// running under test, so its connection-refused console lines are expected.
export async function boot(page: Page): Promise<void> {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("ERR_CONNECTION_REFUSED")) errors.push(m.text()); });
  await page.goto(`/?ws=ws://127.0.0.1:${PORT}/ws`);
  await expect(page.locator("#sessions-toggle")).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => document.fonts.status === "loaded");
}

/// Cmd+T is the keymap's "new tab at current directory"; a synthetic keydown on
/// the window reaches tinykeys the way the real chord does. Returns the tmux
/// session name the app minted.
export async function openTab(page: Page): Promise<string> {
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
    message: `no new tmux session; before=${[...before]} now=${sessions()} errors=${errors.join(" / ")}`,
  }).not.toBe("");
  await expect(page.locator(".term-host .xterm-screen").last()).toBeVisible();
  await page.waitForTimeout(1_500);
  return name;
}

/// The store re-reads every pane's cwd when the tmux panel shows; nothing polls
/// it. The rail button `#sessions-toggle` carries `active` while its panel is
/// open; hide then show is the refresh. Rows are the React table's `tr`s, one
/// `.s-name` per session. The panel is a dockview tab in the terminal's group,
/// so it is hidden again before returning.
export async function settleCwd(page: Page, session: string, needle: string): Promise<void> {
  const toggle = page.locator("#sessions-toggle");
  const row = page.locator("tr", { has: page.locator(".s-name", { hasText: new RegExp(`^${session}$`) }) });
  await expect.poll(async () => {
    if ((await toggle.getAttribute("class"))?.includes("active")) await toggle.click();
    await toggle.click();
    await page.waitForTimeout(1_500);
    return (await row.locator(".s-pwd").textContent().catch(() => "")) ?? "";
  }, { timeout: 30_000, message: `cwd of ${session} never showed ${needle}` }).toContain(needle);
  await toggle.click();
  await expect(page.locator(".term-host .xterm-screen").last()).toBeVisible();
  await page.waitForTimeout(500);
}

/// Viewport pixel at the centre of a terminal cell of the visible host. xterm
/// measures a 32-character span, so one column is a 32nd of its width.
export async function cell(page: Page, row: number, col: number): Promise<{ x: number; y: number }> {
  return page.evaluate(([r, c]) => {
    const host = [...document.querySelectorAll<HTMLElement>(".term-host")].find((h) => h.getBoundingClientRect().width > 0)!;
    const box = host.querySelector(".xterm-screen")!.getBoundingClientRect();
    const m = host.querySelector(".xterm-char-measure-element")!.getBoundingClientRect();
    const cellW = m.width / 32;
    return { x: Math.round(box.left + (c + 0.5) * cellW), y: Math.round(box.top + (r + 0.5) * m.height) };
  }, [row, col]);
}

/// The visible xterm rows of the visible host, as text.
export async function screenRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const host = [...document.querySelectorAll<HTMLElement>(".term-host")].find((h) => h.getBoundingClientRect().width > 0);
    return [...(host?.querySelectorAll(".xterm-rows > div") ?? [])].map((d) => d.textContent ?? "");
  });
}

/// A context-menu row by its label.
export async function menuRow(page: Page, label: string) {
  const row = page.locator(".ctx-menu [data-nav-id]").filter({ has: page.locator(".ctx-label", { hasText: label }) }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  return row;
}

export async function toast(page: Page): Promise<string> {
  const el = page.locator(".app-toast.on");
  await expect(el).toBeVisible({ timeout: 30_000 });
  return (await el.textContent()) ?? "";
}

// ---- real-term-diagrams lane: transcript sandbox under the serve HOME ----
export const SANDBOX_HOME = process.env.INSTANT_REAL_HOME ?? "/tmp/instant-real-c-home";

const claudeProjectDir = (cwd: string): string =>
  path.join(SANDBOX_HOME, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));

/// A claude transcript under the sandbox home, discovered for `cwd`. Every
/// record line should carry `cwd` so the session lists under the pane's dir.
export function installClaudeSession(sessionId: string, cwd: string, lines: readonly string[]): string {
  const file = path.join(claudeProjectDir(cwd), `${sessionId}.jsonl`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/// A codex transcript under the sandbox home; the session_meta head line is
/// prepended so the reader lists the file instead of skipping it.
export function installCodexSession(sessionId: string, cwd: string, lines: readonly string[]): string {
  const day = new Date();
  const dir = path.join(
    SANDBOX_HOME, ".codex", "sessions",
    String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"),
  );
  const file = path.join(dir, `rollout-${day.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}-${sessionId}.jsonl`);
  mkdirSync(dir, { recursive: true });
  const meta = JSON.stringify({
    timestamp: day.toISOString(),
    type: "session_meta",
    payload: { id: sessionId, cwd },
  });
  writeFileSync(file, [meta, ...lines].map((line) => `${line}\n`).join(""));
  return file;
}

/// Rewrite every cwd the corpus carries so the session belongs to `cwd`.
export function recwd(text: string, cwd: string): string {
  return text.replaceAll('/"cwd":"/Users/dev/projects/sprefa"', `/"cwd":"${cwd}"`)
    .replaceAll("/Users/dev/projects/sprefa", cwd);
}

const stubSource = `
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  if (argc > 1) {
    int fd = open(argv[1], O_RDONLY);
    if (fd >= 0) {
      char buf[65536];
      ssize_t n;
      while ((n = read(fd, buf, sizeof buf)) > 0) write(1, buf, n);
    }
  }
  if (argc > 2) {
    int count = atoi(argv[2]);
    for (int i = 0; i < count; i++) {
      char line[64];
      int len = snprintf(line, sizeof line, "\\rworking %d", i);
      write(1, line, len);
      usleep(60000);
    }
  }
  for (;;) pause();
}
`;

let stubDir: Promise<string> | null = null;
/// `claude` / `codex` executables: print a bytes file, stream writes, then idle.
export function stubHarnesses(): Promise<string> {
  stubDir ??= new Promise((resolve, reject) => {
    const dir = mkdtempSync(path.join(tmpdir(), "instant-stub-"));
    const src = path.join(dir, "stub.c");
    writeFileSync(src, stubSource);
    for (const name of ["claude", "codex"]) {
      const built = spawnSync("cc", ["-o", path.join(dir, name), src]);
      if (built.status !== 0) reject(new Error(`cc build ${name}: ${built.stderr}`));
    }
    resolve(dir);
  });
  return stubDir;
}

/// Clear the pane and hand it to the stub harness: the bytes file fills row 0
/// down, `streamWrites` "\rworking N" chunks arrive 60ms apart when asked.
export async function runStubHarness(
  session: string,
  name: "claude" | "codex",
  bytesFile: string,
  streamWrites = 0,
): Promise<void> {
  const dir = await stubHarnesses();
  typeLine(session, `clear; PATH=${dir}:$PATH exec ${name} '${bytesFile}' ${streamWrites}`);
}

/// The turn-attribution debug overlay, switched on the way a user does it.
export async function turnDebugOn(page: Page): Promise<void> {
  const button = page.locator("#turn-debug-toggle");
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

/// Unique turn ids the debug rows attribute the visible host to, sorted.
export async function visibleTurnIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const host = [...document.querySelectorAll<HTMLElement>(".term-host")].find((h) => h.getBoundingClientRect().width > 0);
    return [...(host?.querySelectorAll<HTMLElement>(".term-turn-debug-row[data-turn-id]:not([data-turn-id=''])") ?? [])]
      .map((row) => row.dataset.turnId!)
      .sort();
  });
}
