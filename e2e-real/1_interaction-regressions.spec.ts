import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { boot, cell, killAllSessions, mkRepo, openSessionTab, paneScreen, screenRows, sessions, tmux, typeLine } from "./0_real";

const dirs: string[] = [];
const editor = (page: Page) => page.locator('.monaco-code-viewer[data-status="ready"]');

// Only inspect application DOM and real WebSocket traffic. All interactions
// reach the production bundle through Chromium's keyboard and mouse.
function requests(page: Page) {
  const sent: { id?: number; method: string; params?: Record<string, unknown>; result?: unknown }[] = [];
  page.on("websocket", ws => {
    ws.on("framesent", frame => {
      try { sent.push(JSON.parse(String(frame.payload))); } catch { /* non-JSON frame */ }
    });
    ws.on("framereceived", frame => {
      const reply = JSON.parse(String(frame.payload));
      const request = sent.find(r => r.id === reply.id && reply.id !== undefined);
      if (request) request.result = reply.result;
    });
  });
  return sent;
}

async function tokenPoint(page: Page, token: string) {
  await expect.poll(() => screenRows(page)).toEqual(expect.arrayContaining([expect.stringContaining(token)]));
  const rows = await screenRows(page);
  const row = rows.findLastIndex(text => text.includes(token));
  return cell(page, row, rows[row].indexOf(token) + 2);
}

async function cmdClick(page: Page, token: string) {
  const point = await tokenPoint(page, token);
  await page.keyboard.down("Meta");
  await page.mouse.move(point.x, point.y);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up("Meta");
}

test.afterEach(async ({ page }) => {
  await page.keyboard.up("Meta");
  for (let i = 0; i < 10 && await page.locator(".term-host").count(); i++) {
    await page.keyboard.press("Meta+w");
  }
  await page.close();
  killAllSessions();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("real tmux status moves without moving Cmd-click targets; Monaco highlights occurrences", async ({ page }) => {
  const sent = requests(page);
  const dir = mkRepo({ "sample.ts": "const repeated = 1;\nconst total = repeated + repeated;\n" }, "interaction fixture");
  dirs.push(dir);
  await boot(page);
  const session = await openSessionTab(page, dir);
  typeLine(session, "clear; printf 'sample.ts\\n'");
  await expect.poll(() => paneScreen(session).join("\n")).toContain("sample.ts");

  for (const [status, position] of [["on", "bottom"], ["on", "top"], ["2", "top"], ["off", "top"]]) {
    tmux(["set-option", "-t", session, "status", status]);
    tmux(["set-option", "-t", session, "status-position", position]);
    tmux(["set-option", "-t", session, "status-left", "STATUS-DO-NOT-OPEN"]);
    await expect.poll(() => sent.filter(r => r.method === "boop_mux_status" && r.result !== undefined).at(-1)?.result)
      .toEqual({ position, rows: status === "off" ? 0 : status === "on" ? 1 : 2 });
    await expect.poll(async () => {
      const rows = await screenRows(page);
      return status === "off" ? rows.some(row => row.includes("STATUS"))
        : (position === "top" ? rows[0] : rows.at(-1))?.includes("STATUS");
    }).toBe(status !== "off");
    await cmdClick(page, "sample.ts");
    await expect(editor(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".view-lines")).toContainText("repeated");
    await expect(page.getByRole("button", { name: "Open in external application", exact: true })).toBeVisible();
    await page.locator(".view-lines .view-line").first().dblclick({ position: { x: 70, y: 10 } });
    await expect.poll(() => page.locator(".selectionHighlight, .wordHighlight, .wordHighlightText").count()).toBeGreaterThanOrEqual(2);
    await page.keyboard.press("Meta+w");
    await expect(editor(page)).toHaveCount(0);
    await expect(page.locator(".term-host .xterm-screen")).toBeVisible();
  }
});

test("closing and opening tabs creates new tmux sessions and detaches old clients", async ({ page }) => {
  const dir = mkRepo({});
  dirs.push(dir);
  await boot(page);
  const initial = await openSessionTab(page, dir);
  const opened = [initial];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Meta+w");
    await expect(page.locator(".term-host")).toHaveCount(0);
    await expect.poll(() => tmux(["list-clients", "-F", "#{session_name}"]).trim()).toBe("");
    await page.keyboard.press("Meta+t");
    await expect.poll(() => sessions().length).toBe(opened.length + 1);
    const next = sessions().find(name => !opened.includes(name))!;
    opened.push(next);
    await expect(page.locator(".term-host .xterm-screen")).toBeVisible();
    await expect.poll(() => tmux(["list-clients", "-F", "#{session_name}"]).trim()).toBe(next);
  }
  expect(new Set(opened).size).toBe(4);
});

test("hover does no lookup and repeated missing Cmd-clicks finish without queued searches", async ({ page }) => {
  const sent = requests(page);
  const dir = mkRepo({ "README.md": "a small real repository\n" }, "interaction fixture");
  dirs.push(dir);
  await boot(page);
  const session = await openSessionTab(page, dir);
  const token = "absent_interaction_regression_8137.ts";
  tmux(["respawn-pane", "-k", "-t", `${session}:`, `printf '\\033[?1049h\\033[2J\\033[H${token}\\n'; exec /bin/sleep 60`]);
  const point = await tokenPoint(page, token);
  const methods = () => sent.filter(r => /resolve_ref|run_click/.test(r.method));
  const before = methods().length;
  await page.keyboard.down("Meta");
  await page.mouse.move(point.x, point.y);
  await expect(page.locator(".term-inspector:popover-open")).toBeVisible();
  expect(methods().length).toBe(before);
  // The results dock can resize the terminal during the burst. Re-read the
  // drawn token's coordinates so every click still targets the same token.
  for (let i = 0; i < 8; i++) await cmdClick(page, token);
  await page.keyboard.up("Meta");
  await expect(page.locator(".term-inspector:popover-open")).toHaveCount(0);
  await expect(page.locator(".rg-panel")).toContainText(`no match, and no file named ${token}`, { timeout: 15_000 });
  const lookups = methods().slice(before);
  expect(lookups.filter(r => r.method === "resolve_ref")).toHaveLength(1);
  expect(lookups.filter(r => r.method === "run_click").length).toBeLessThanOrEqual(1);
});

test("real RPC limits concurrent rg commands and kills the process group at the deadline", async ({ page }) => {
  const dir = mkRepo({});
  dirs.push(dir);
  expect(spawnSync("mkfifo", [`${dir}/input`]).status).toBe(0);
  await boot(page);
  // A real rg blocks opening this FIFO. The shell records its process group
  // and rg pid, letting the test verify both disappear after the deadline.
  const command = "echo $$ >> groups; rg --text needle input & echo $! >> children; wait";
  const repliesPromise = page.evaluate(async ({ command, cwd }) => {
    const socket = new WebSocket(`${location.origin.replace("http", "ws")}/ws`);
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
    const replies: any[] = [];
    return await new Promise<any[]>((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new Error("RPC flood never finished")); }, 12_000);
      socket.onmessage = event => {
        const reply = JSON.parse(event.data);
        if (typeof reply.id !== "number") return;
        replies.push(reply);
        if (replies.length === 12) { clearTimeout(timeout); socket.close(); resolve(replies); }
      };
      for (let id = 0; id < 12; id++) socket.send(JSON.stringify({ jsonrpc: "2.0", id, method: "run_click", params: { command, cwd } }));
    });
  }, { command, cwd: dir });
  await expect.poll(() => existsSync(`${dir}/children`)).toBe(true);
  const child = Number(readFileSync(`${dir}/children`, "utf8").trim());
  expect(spawnSync("ps", ["-p", String(child), "-o", "comm="], { encoding: "utf8" }).stdout).toContain("rg");
  const replies = await repliesPromise;
  expect(replies.map(r => r.error?.message).sort()).toEqual([
    ...Array(11).fill("A click command is already running"),
    expect.stringContaining("timed out"),
  ]);
  expect(readFileSync(`${dir}/children`, "utf8").trim().split("\n")).toHaveLength(1);
  const group = readFileSync(`${dir}/groups`, "utf8").trim();
  await expect.poll(() => spawnSync("ps", ["-p", `${group},${child}`, "-o", "pid="], { encoding: "utf8" }).stdout.trim()).toBe("");
});

test("right click identifies the stored Boop turn after tmux status moves", async ({ page }) => {
  const calls = new Map<number, { method: string; params?: { session?: string } }>();
  const receipts: Record<string, unknown> = {};
  page.on("websocket", ws => {
    ws.on("framesent", frame => { const r = JSON.parse(String(frame.payload)); if (r.id) calls.set(r.id, r); });
    ws.on("framereceived", frame => {
      const r = JSON.parse(String(frame.payload));
      const call = calls.get(r.id);
      const method = call?.method;
      if (method === "boop_turns" && call?.params?.session !== "interaction-pointer") return;
      if (method && ["boop_mux_status", "boop_mux_session", "boop_turns", "boop_locate_turns"].includes(method)) receipts[method] = {
        error: r.error,
        result: Array.isArray(r.result) ? r.result.map(({ session, turn, bufferStart, bufferEnd }: any) => ({ session, turn, bufferStart, bufferEnd })).slice(0, 3) : r.result,
      };
    });
  });
  const database = process.env.BOOP_DB;
  const mail = process.env.BOOP_MAIL_DIR;
  expect(mail?.startsWith("/tmp/instant-interaction-")).toBe(true);
  expect(database).toBe(`${mail}/boop.db`);
  await boot(page);
  // Initialize the isolated store through its real write API and migrations.
  const initialized = await page.evaluate(async () => {
    const socket = new WebSocket(`${location.origin.replace("http", "ws")}/ws`);
    return await new Promise<any>((resolve, reject) => {
      socket.onerror = reject;
      socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "boop_tags_apply", params: { note: "", source: "interaction-regression" } }));
      socket.onmessage = event => { const reply = JSON.parse(event.data); if (reply.id === 1) { socket.close(); resolve(reply); } };
    });
  });
  expect(initialized).toEqual({ jsonrpc: "2.0", id: 1, result: [] });
  const dir = mkRepo({});
  dirs.push(dir);
  const session = await openSessionTab(page, dir);
  const pane = tmux(["display-message", "-p", "-t", `${session}:`, "#{pane_id}"]).trim();
  const pid = Number(tmux(["display-message", "-p", "-t", `${session}:`, "#{pane_pid}"]).trim());
  const said = "The pointer must identify this stored assistant turn.\nThis interior row belongs to that same assistant turn.\nThe final sentence completes the stored assistant turn.";
  const seed = spawnSync("sqlite3", [database!, `
    INSERT OR IGNORE INTO dict_harness(value) VALUES ('codex');
    INSERT OR IGNORE INTO dict_role(value) VALUES ('assistant');
    INSERT INTO dict_session(value) VALUES ('interaction-pointer');
    INSERT INTO agent_session(session_id,harness_id,started_ts)
      VALUES ((SELECT id FROM dict_session WHERE value='interaction-pointer'),(SELECT id FROM dict_harness WHERE value='codex'),${Date.now()});
    INSERT INTO agent_turn(session_id,turn,ts,role_id,said)
      VALUES ((SELECT id FROM dict_session WHERE value='interaction-pointer'),7,${Date.now()},(SELECT id FROM dict_role WHERE value='assistant'),'${said}');
    INSERT INTO agent_route(route,kind,harness,tmux,session_id,registered_at)
      VALUES ('interaction-pointer','lane','codex','${pane}','interaction-pointer',strftime('%Y-%m-%d %H:%M:%f000','now'));
    INSERT OR IGNORE INTO dict_pane(value) VALUES ('${pane}');
    INSERT INTO agent_live(session_id,pid,tmux_pane_id,pane_alive,pid_alive,last_seen_ts)
      VALUES ((SELECT id FROM dict_session WHERE value='interaction-pointer'),${pid},(SELECT id FROM dict_pane WHERE value='${pane}'),1,1,${Date.now()});
  `], { encoding: "utf8" });
  expect(seed.stderr).toBe("");
  expect(seed.status).toBe(0);
  typeLine(session, `clear; printf '${said.replaceAll("\n", "\\n")}\\n'`);
  for (const [status, position] of [["on", "bottom"], ["on", "top"], ["2", "top"], ["off", "top"]]) {
    tmux(["set-option", "-t", session, "status", status]);
    tmux(["set-option", "-t", session, "status-position", position]);
    await expect.poll(() => receipts.boop_mux_status).toEqual({ error: undefined,
      result: { position, rows: status === "off" ? 0 : status === "on" ? 1 : 2 } });
    await expect(async () => {
      await page.keyboard.press("Escape");
      const point = await tokenPoint(page, "This interior row");
      await page.mouse.click(point.x, point.y, { button: "right" });
      await expect(page.locator(".ctx-menu")).toContainText("Boop interaction-pointer:7 · assistant", { timeout: 1000 });
    }).toPass({ timeout: 15_000 }).catch(error => { throw new Error(`${error}\nNative receipts: ${JSON.stringify(receipts)}`); });
    await page.keyboard.press("Escape");
  }
});
