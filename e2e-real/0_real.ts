// Shared edges of the real tier: the built bundle in Chromium against
// instant-serve on a private tmux socket. Every spec drives the app the way a
// user does (keys, mouse, tmux panes) and reads receipts from the DOM, tmux,
// the file system, or boop's sqlite store. No fixture page, no window hook.
import { expect, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
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

// lane real-term-basics
// The codex-pane prelude in printf %b form: alternate screen plus mouse tracking.
export const MOUSE_PANE = "\\033[?1049h\\033[?1006h\\033[?1000h\\033[?1002h";

// bash with prompt and tty echo silenced, so a printf paints the screen and
// nothing else. The caller names a marker that must reach the pane first.
export async function openSilentPane(page: Page, payload: string, marker: string): Promise<string> {
  const session = await openTab(page);
  typeLine(session, "bash --norc --noprofile");
  await page.waitForTimeout(400);
  typeLine(session, "PS1=; stty -echo");
  await page.waitForTimeout(200);
  typeLine(session, `printf '%b' '${payload}'`);
  await expect.poll(() => paneScreen(session).join("\n"), {
    timeout: 20_000,
    message: `pane ${session} never showed ${JSON.stringify(marker)}`,
  }).toContain(marker);
  await page.waitForTimeout(300);
  return session;
}

/// The system clipboard after the app's autocopy of a finished selection.
export const clipboardText = (page: Page): Promise<string> =>
  page.evaluate(() => navigator.clipboard.readText());

/// ⌘W closes the active tab, and the app drops that tab's pty when it does.
/// A test that leaves a tab open blocks the next test from minting a session of
/// the same name, because the backend keeps `s:<name>` wired to the dead pty
/// (src-tauri/src/pty.rs:596). Every spec closes its tabs before the tmux
/// sessions are killed from outside.
export async function closeTabs(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    if ((await page.locator(".term-host").count().catch(() => 0)) === 0) return;
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", metaKey: true, bubbles: true, cancelable: true }));
    }).catch(() => {});
    await page.waitForTimeout(500);
  }
}

/// A command typed into a pane after a drag. The app forwards mouse reports to
/// the pty, and those bytes sit in the shell's line buffer, so Ctrl-U drops
/// them before the command goes in. Receipt of the fix: the pane runs the
/// command instead of answering "bash: 0: command not found".
export const paneCommand = (session: string, line: string): void => {
  tmux(["send-keys", "-t", `${session}:`, "C-u"]);
  typeLine(session, line);
};
