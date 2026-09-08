// Shared edges of the real tier: the built bundle in Chromium against
// instant-serve on a private tmux socket. Every spec drives the app the way a
// user does (keys, mouse, tmux panes) and reads receipts from the DOM, tmux,
// the file system, or boop's sqlite store. No fixture page, no window hook.
import { expect, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const shots = path.join(root, "artifacts", "real");
export const PORT = Number(process.env.INSTANT_REAL_PORT ?? 47790);
export const SOCKET = process.env.INSTANT_REAL_SOCKET ?? "instant-real-e2e";
export const BOOP = process.env.BOOP_BIN ?? path.join(process.env.HOME ?? "", ".cargo/bin/boop");
/// Where e2e-real/stub-bin/boop logs every `beep fork` call: one line per call,
/// `<cwd>\t<args>`. The tier never opens a real lane.
export const STUB_LOG = process.env.INSTANT_FORK_STUB_LOG ?? path.join(process.env.INSTANT_SERVE_DATA ?? `/tmp/${SOCKET}`, "fork-stub.log");
export const forkCalls = (): { cwd: string; args: string }[] => {
  let text = "";
  try { text = readFileSync(STUB_LOG, "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).map((line) => { const [cwd, args] = line.split("\t"); return { cwd, args }; });
};
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
  fs.mkdirSync(shots, { recursive: true });
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

// real-term-hover lane additions (kept at the end; other lanes append below).

/// First pane row holding `marker`, -1 when absent. Row 0 is the top of the
/// visible screen, so the number feeds straight into `cell`.
export const findRow = (session: string, marker: string): number =>
  paneScreen(session).findIndex((line) => line.includes(marker));

/// The tab's harness badge flips only after the store's tmux sweep sees the
/// pane's foreground process, so a stub harness launch is awaited, not assumed.
export async function waitForHarness(page: Page, id: string): Promise<void> {
  await expect
    .poll(() => page.locator(`.term-host[data-harness="${id}"]`).count(), {
      timeout: 30_000,
      message: `harness ${id} never detected`,
    })
    .toBeGreaterThan(0);
}

/// A stub codex pane writes no transcript, so the spec seeds the one turn in
/// boop's sqlite whose `said` it also cats to the screen.
const seededTurns: string[] = [];
export function seedTurn(session: string, turn: number, said: string): void {
  const quote = said.replace(/'/g, "''");
  sql(`insert into dict_session(value) values ('${session}')`);
  sql(`insert into agent_session(session_id, harness_id, cwd_id, started_ts)
      values ((select id from dict_session where value='${session}'),
              (select id from dict_harness where value='codex'),
              null, ${Date.now()})`);
  sql(`insert into agent_turn(session_id, turn, ts, role_id, said, cwd_id)
      values ((select id from dict_session where value='${session}'), ${turn}, ${Date.now()},
              (select id from dict_role where value='assistant'), '${quote}', null)`);
  seededTurns.push(session);
}

export function dropSeededTurns(): void {
  for (const session of seededTurns) {
    sql(`delete from agent_turn where session_id=(select id from dict_session where value='${session}')`);
    sql(`delete from agent_session where session_id=(select id from dict_session where value='${session}')`);
    sql(`delete from dict_session where value='${session}'`);
  }
  seededTurns.length = 0;
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

// ---- lane: real-cmdclick-previews ----
// instant-serve's data dir (mirrors playwright.real.config.ts); its instant.log is the receipt for opens the browser cannot do.
export const DATA_DIR = process.env.INSTANT_SERVE_DATA ?? `/tmp/${SOCKET}`;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "e2e",
  GIT_AUTHOR_EMAIL: "e2e@instant",
  GIT_COMMITTER_NAME: "e2e",
  GIT_COMMITTER_EMAIL: "e2e@instant",
};

/// `git -C dir` with the e2e identity; throws with stderr on failure.
export function gitIn(dir: string, args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git -C ${dir} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/// A fresh temp dir holding `files` (relative path -> content), committed when
/// `commit` names a subject. Fresh dir per call: the resolver caches its index 30s.
export function mkRepo(files: Record<string, string>, commit?: string): string {
  // realpath: macOS hands out /var/folders/... while every path the app prints
  // comes back as /private/var/folders/..., and the specs compare the two.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "instant-real-")));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  if (commit) {
    gitIn(dir, ["init", "-q", "-b", "main"]);
    gitIn(dir, ["add", "-A"]);
    gitIn(dir, ["commit", "-qm", commit]);
  }
  return dir;
}

/// ⌘-click at a viewport point: Meta down, a real pointer pair with no travel,
/// Meta up. The gesture a ⌘-click on any surface is.
export async function metaClick(page: Page, x: number, y: number): Promise<void> {
  await page.keyboard.down("Meta");
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await page.keyboard.up("Meta");
}

/// ⌘-click `token` wherever the pane currently shows it (last row wins: output
/// follows the command line, and both hold the token).
export async function cmdClickToken(page: Page, session: string, token: string): Promise<void> {
  const rows = paneScreen(session);
  let row = -1;
  let col = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const at = rows[i].indexOf(token);
    if (at >= 0) { row = i; col = at + Math.min(2, token.length - 1); break; }
  }
  expect(row, `pane never showed ${token}; screen: ${rows.filter(Boolean).join(" | ")}`).toBeGreaterThanOrEqual(0);
  const at = await cell(page, row, col);
  await metaClick(page, at.x, at.y);
}

/// Echo `text` into the pane and ⌘-click `token` inside it: the way a user
/// opens a path printed in terminal output.
export async function clickToken(page: Page, session: string, text: string, token: string): Promise<void> {
  typeLine(session, `clear; echo "${text}"`);
  await page.waitForTimeout(1_200);
  await cmdClickToken(page, session, token);
}

/// A tab on a tmux session this test made, named once and never reused.
/// The backend keys its pty map by `s:<session>` and drops an entry only when
/// the app itself kills the session, so a second test that mints the same name
/// gets the dead first pty back and no pane at all. A fresh name per test, plus
/// the session created at `cwd`, also gives the pane its directory immediately.
/// The user gesture: the sessions rail panel lists every tmux session, and a
/// click on its row opens it as a tab.
export async function openSessionTab(page: Page, cwd: string): Promise<string> {
  const name = `real${Math.random().toString(36).slice(2, 8)}`;
  tmux(["new-session", "-d", "-s", name, "-c", cwd]);
  const toggle = page.locator("#sessions-toggle");
  const row = page.locator("tr", { has: page.locator(".s-name", { hasText: new RegExp(`^${name}$`) }) });
  // The panel reads tmux when it is shown; hide then show is the refresh.
  await expect.poll(async () => {
    if ((await toggle.getAttribute("class"))?.includes("active")) await toggle.click();
    await toggle.click();
    await page.waitForTimeout(1_000);
    return await row.count();
  }, { timeout: 30_000, message: `sessions panel never listed ${name}` }).toBeGreaterThan(0);
  await row.locator(".s-name").click();
  await expect(page.locator(".term-host .xterm-screen").last()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1_500);
  // A tab opened from the panel carries no launch cwd; a ⌘-click reads the pane
  // directory from `store.sessions[].paths`, which one more panel show fills.
  await settleCwd(page, name, path.basename(cwd));
  return name;
}

/// instant-serve's own log. The browser build has no opener, so every link the
/// app hands to the host lands here as `ports: openUrl … ignored outside
/// tauri`: the receipt for an open that leaves the window.
export const serveLog = (): string => {
  try {
    return fs.readFileSync(path.join(DATA_DIR, "instant.log"), "utf8");
  } catch {
    return "";
  }
};

// ---- lane: real-term-hover (context queue ports) ----

/// A pane on a session named once per test: bash with no prompt and no tty
/// echo, then one `cat` of the bytes the spec wants on screen. The pane holds
/// those lines and nothing else, so the row tmux reports is the row xterm
/// paints. `prelude` carries escape bytes (mouse tracking, alternate screen)
/// through `printf %b` before the body.
export async function silentSessionPane(
  page: Page,
  cwd: string,
  body: string,
  marker: string,
  prelude = "",
): Promise<string> {
  const session = await openSessionTab(page, cwd);
  typeLine(session, "bash --norc --noprofile");
  await page.waitForTimeout(600);
  typeLine(session, "PS1=; stty -echo");
  await page.waitForTimeout(400);
  const file = path.join(cwd, `pane-${Math.random().toString(36).slice(2, 8)}.txt`);
  fs.writeFileSync(file, body);
  typeLine(session, prelude ? `clear; printf '%b' '${prelude}'; cat ${file}` : `clear; cat ${file}`);
  await expect.poll(() => paneScreen(session).join("\n"), {
    timeout: 20_000,
    message: `pane ${session} never showed ${JSON.stringify(marker)}`,
  }).toContain(marker);
  await page.waitForTimeout(400);
  return session;
}

/// Queue rows live in boop's sqlite and reload onto a tab of the same name, so
/// a test drops its own rows rather than leaving them for the next reader.
export function dropTabComments(tab: string): void {
  sql(`delete from agent_turn_comment_target where comment_id in
       (select comment_id from agent_turn_comment where tab_name='${tab}')`);
  sql(`delete from agent_turn_comment where tab_name='${tab}'`);
}

/// Cell height in viewport pixels of the visible terminal host, read from the
/// same measure element xterm sizes its rows with.
export async function cellHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const host = [...document.querySelectorAll<HTMLElement>(".term-host")].find((h) => h.getBoundingClientRect().width > 0)!;
    return host.querySelector(".xterm-char-measure-element")!.getBoundingClientRect().height;
  });
}

/// The tmux pane id of a session's active pane, `%NN`.
export const paneId = (session: string): string =>
  tmux(["display-message", "-p", "-t", `${session}:`, "#{pane_id}"]).trim();

const boundRoutes: string[] = [];

/// Bind a pane to a seeded boop session the way a lane registration does: the
/// app asks boop which session stands in the pane, and boop answers from its
/// route table. Without the binding the pane is unbound and the turn
/// projection has nothing to place. Rows are dropped by `dropPaneSessions`.
export function bindPaneSession(session: string, harness = "codex"): void {
  const route = `e2e-real-${session}`;
  const pane = paneId(session);
  const held = sql(`select route from agent_route where tmux='${pane}' limit 1`);
  if (held) throw new Error(`pane ${pane} is already bound to route ${held}; burn ids first`);
  sql(`insert or replace into agent_route(route, kind, harness, tmux, session_id, registered_at)
       values ('${route}', 'lane', '${harness}', '${pane}', '${session}',
               strftime('%Y-%m-%d %H:%M:%f000', 'now'))`);
  boundRoutes.push(route);
}

/// tmux hands out pane ids per server from %0 up, and boop keys its lane
/// bindings by the bare pane id with no server in it, so a pane on the app's
/// private socket lands on an id a lane on the default socket already holds.
/// Probe panes burn ids until the next one tmux will hand out is free.
export function burnClaimedPaneIds(): void {
  for (let i = 0; i < 40; i += 1) {
    const probe = `paneprobe${i}`;
    tmux(["new-session", "-d", "-s", probe]);
    const next = `%${Number(paneId(probe).slice(1)) + 1}`;
    tmux(["kill-session", "-t", `=${probe}`]);
    if (sql(`select count(*) from agent_route where tmux='${next}'`) === "0") return;
  }
}

export function dropPaneSessions(): void {
  for (const route of boundRoutes) sql(`delete from agent_route where route='${route}'`);
  boundRoutes.length = 0;
}
