// The strip, all the way through, with a real agent on the near end.
//
//   llmock (fixed stream)  ->  real CLI in a real tmux pane   claude/codex/opencode/kimi
//      ->  the CLI's own transcript in the scratch HOME
//      ->  boop ingest (the app's per-tab sync)              real store
//      ->  capture-pane + boop-turnvis + boop-turnstrip      the shipped feed
//      ->  host.emit("squares-update", Strip)                the shipped push
//      ->  squares in the margin                             the shipped client
//      ->  one PNG per harness
//
// Nothing is stubbed: no cast replayed into xterm, no turns hand-written into
// sqlite, no frame fabricated in the page. The only fake is the model provider,
// which is what makes the terminal text — and therefore the picture — the same
// every run.
//
// Run through playwright.agent.config.ts:
//   corepack pnpm@10.12.4 exec playwright test --config playwright.agent.config.ts
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  liveAgentAdapters,
  liveAgentPrompt,
  liveAgentReplyMarker,
  resolveAgentExecutable,
  resolveLlmockExecutable,
  wrappedAgentCommand,
  type AgentTuiLaunch,
} from "../scripts/2_agentTuiReplay";

declare global {
  interface Window {
    __squaresFrames?: Array<{
      session: string;
      rows: number;
      turns: Array<{ id: string; role: string; said: string }>;
      tags: Record<string, string[]>;
      layout: { squares: Array<{ id: string; y: number; scale: number; active: boolean }>; span: number; block: { top: number; height: number } } | null;
    }>;
  }
}

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(repo, "fixtures", "transcripts", "provider", "0_terminal-flow.yaml");
const shots = join(repo, "artifacts", "agent-strip");
const llmockExecutable = resolveLlmockExecutable(repo);
const BOOP = process.env.BOOP_BIN ?? join(process.env.HOME ?? "", ".cargo/bin/boop");
const port = Number(process.env.INSTANT_AGENT_PORT ?? 47821);
const scratchRoot = process.env.INSTANT_AGENT_TMP ?? `/private/tmp/instant-agent-${port}`;
const home = join(scratchRoot, "home");
const tmuxDir = join(scratchRoot, "tmux");
const boopDir = join(scratchRoot, "boop");
const boopDb = join(boopDir, "boop.db");
const workspace = join(scratchRoot, "workspace");

const tmuxEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.TMUX;
  env.TMUX_TMPDIR = tmuxDir;
  return env;
};
const tmux = (args: string[]) => spawnSync("tmux", args, { encoding: "utf8", env: tmuxEnv() });

const boopEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.TMUX;
  env.TMUX_TMPDIR = tmuxDir;
  env.BOOP_DB = boopDb;
  env.BOOP_MAIL_DIR = boopDir;
  env.BOOP_NO_SYNC = "1";
  return env;
};

let llmock: ChildProcess | null = null;
let llmockPort = 0;
let llmockLog = "";

async function unusedLoopbackPort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const picked = typeof address === "object" && address ? address.port : 0;
    server.close(() => (picked ? resolve(picked) : reject(new Error("no port"))));
  });
  return promise;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function providerIsUp(selectedPort: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect(selectedPort, "127.0.0.1");
  socket.on("connect", () => { socket.destroy(); resolve(true); });
  socket.on("error", () => resolve(false));
  return promise;
}

async function waitForProvider(server: ChildProcess, selectedPort: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`llmock exited ${server.exitCode}\n${llmockLog}`);
    if (await providerIsUp(selectedPort)) return;
    await sleep(150);
  }
  throw new Error(`llmock never listened on ${selectedPort}\n${llmockLog}`);
}

function startAgentPane(session: string, launch: AgentTuiLaunch): void {
  tmux(["kill-session", "-t", `=${session}`]);
  const started = tmux([
    "-f", "/dev/null", "new-session", "-d", "-s", session,
    "-x", "200", "-y", "50", "-c", workspace,
    "bash", "-lc", wrappedAgentCommand({ launch, boop: BOOP, session, workspace, boopDir, boopDb, tmuxDir }),
  ]);
  expect(started.status, `tmux new-session ${session}: ${started.stderr}`).toBe(0);
}

function paneText(session: string): string {
  return tmux(["capture-pane", "-p", "-J", "-t", session]).stdout;
}

async function waitForPaneText(session: string, wanted: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paneText(session).includes(wanted)) return;
    await sleep(250);
  }
  throw new Error(`pane ${session} never printed ${wanted}\n--- pane ---\n${paneText(session)}`);
}

/// The CLIs that open a TUI take the prompt at their own composer. Text first,
/// then a beat, then the return: a return sent in the same tick as the text can
/// land before the composer has it, and kimi is still showing the prompt in its
/// box minutes later when that happens.
async function submitPrompt(session: string, prompt: string): Promise<void> {
  await sleep(400);
  tmux(["send-keys", "-t", `${session}:`, "-l", prompt]);
  await sleep(400);
  tmux(["send-keys", "-t", `${session}:`, "C-m"]);
}

// ---- the app, served by the real backend ----

async function boot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("skin", JSON.stringify("xp"));
    localStorage.setItem("mode", JSON.stringify("dark"));
    localStorage.setItem("panicButton", JSON.stringify(false));
  });
  await page.goto(`/?ws=ws://127.0.0.1:${port}/ws`);
  await expect(page.locator("#sessions-toggle")).toBeVisible({ timeout: 30_000 });
}

/// Record every frame the server pushes, so the assertions read the wire rather
/// than the drawing. The transport assigns `socket.onmessage`.
async function hookFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__squaresFrames = [];
    const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
    Object.defineProperty(WebSocket.prototype, "onmessage", {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get: descriptor?.get,
      set(listener) {
        const wrapped = function (this: WebSocket, event: MessageEvent) {
          try {
            const frame = JSON.parse(String(event.data));
            if (frame?.params?.event === "squares-update") window.__squaresFrames!.push(frame.params.payload);
          } catch {}
          listener.call(this, event);
        };
        descriptor?.set?.call(this, wrapped);
      },
    });
  });
}

/// What the app's own binding call answers for this pane, asked over the
/// server's ws the way the tab asks it. The strip needs this to resolve before
/// any frame exists, so a failure here is the real failure and the frame poll
/// is only its symptom.
async function boundSession(session: string): Promise<string | null> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  return new Promise((resolve) => {
    const done = (value: string | null) => {
      socket.close();
      resolve(value);
    };
    socket.onopen = () =>
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "boop_mux_session",
        params: { target: session, socket: null },
      }));
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.id !== 1) return;
      done(frame.result?.session ?? null);
    };
    socket.onerror = () => done(null);
  });
}

/// The pane's own text plus every pane on the scratch server, written beside
/// the PNG. A harness that binds but never pushes leaves the question "did the
/// pane survive the app's attach?" — `dead=` answers it.
function dumpEvidence(harness: string, session: string): void {
  const panes = tmux(["-u", "list-panes", "-a", "-F", "#{session_name}.#{pane_id} dead=#{pane_dead} cmd=#{pane_current_command}"]).stdout;
  fs.writeFileSync(join(shots, `${harness}-pane.txt`), `${panes}\n${paneText(session)}`);
  fs.copyFileSync(join(scratchRoot, "serve", "instant.log"), join(shots, `${harness}-server.log`));
}

async function openSession(page: Page, session: string): Promise<void> {
  await page.locator(".dv-tab", { hasText: "tmux" }).first().click();
  const row = page.locator(".dtable-row", { has: page.locator(".s-name", { hasText: new RegExp(`^${session}$`) }) }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.locator(".term-host .xterm-screen:visible")).toBeVisible({ timeout: 30_000 });
}

async function squaresOn(page: Page): Promise<void> {
  const button = page.locator("#squares-toggle");
  await expect(button).toBeVisible();
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

test.beforeAll(async () => {
  test.skip(!llmockExecutable, "run `pnpm replay:setup` to install pinned llmock v0.1.2 locally");
  fs.mkdirSync(shots, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  // The claude launcher on this machine resolves its install from `$HOME`
  // (`~/.local/share/claude`) and writes a shim into `~/.local/bin`. The scratch
  // home links the owner's install and provides that directory, so the CLI runs
  // while its config and its transcript stay scratch.
  const install = join(process.env.HOME ?? "", ".local", "share", "claude");
  fs.mkdirSync(join(home, ".local", "bin"), { recursive: true });
  if (fs.existsSync(install)) {
    fs.mkdirSync(join(home, ".local", "share"), { recursive: true });
    const link = join(home, ".local", "share", "claude");
    if (!fs.existsSync(link)) fs.symlinkSync(install, link);
  }

  llmockPort = await unusedLoopbackPort();
  llmock = spawn(llmockExecutable!, [
    "--port", String(llmockPort),
    "--fixtures", fixture,
    "--deterministic",
    "--default-ttft-ms", "0",
    "--default-inter-token-ms", "0",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", RUST_LOG: "debug" },
  });
  llmock.stdout?.on("data", (chunk) => { llmockLog += chunk.toString(); });
  llmock.stderr?.on("data", (chunk) => { llmockLog += chunk.toString(); });
  await waitForProvider(llmock, llmockPort);

  // Create the scratch store's schema the way every other tier does.
  const schema = spawnSync(BOOP, ["beep", "selection", "list"], { env: boopEnv(), encoding: "utf8" });
  expect(schema.status, `boop schema init: ${schema.stderr}`).toBe(0);
});

test.afterAll(() => {
  llmock?.kill();
  for (const adapter of liveAgentAdapters) tmux(["kill-session", "-t", `=agent-${adapter.harness}`]);
});

for (const adapter of liveAgentAdapters) {
  test(`real ${adapter.harness} against the mock provider draws its strip`, async ({ page }, testInfo) => {
    const executable = resolveAgentExecutable(adapter);
    test.skip(!executable, `${adapter.harness} is not on PATH`);
    const session = `agent-${adapter.harness}`;
    const launch = adapter.writeLaunch(executable!, home, workspace, llmockPort);

    // 1. the real CLI, in a real pane, answering from the fixed stream. Three of
    //    the four take the prompt at their own composer and need nothing in
    //    argv; the wrapper recipe says which way this one goes.
    startAgentPane(session, launch);
    if (launch.wrapper.replay.kind === "type-prompt") {
      await waitForPaneText(session, launch.wrapper.replay.readiness, 90_000);
      await submitPrompt(session, liveAgentPrompt);
    }
    await waitForPaneText(session, liveAgentReplyMarker, 120_000);

    // 2. the app against the real backend: the tab's own sync ingests the
    //    transcript, the feed captures this pane, and the frame it pushes is
    //    the evidence.
    await hookFrames(page);
    await boot(page);
    await openSession(page, session);
    await squaresOn(page);

    // The pane and the server's own log, kept beside the PNG: when a harness
    // fails to bind, the pane shows which launcher ran and the log shows what
    // the capture and the binding answered.
    dumpEvidence(adapter.harness, session);

    // The tab has to bind the pane before any frame can exist. Asserted first so
    // a binding failure reads as itself instead of as a frame timeout.
    await expect
      .poll(() => boundSession(session), {
        timeout: 90_000,
        message: `no session bound to pane ${session}`,
      })
      .not.toBeNull();

    // Second dump, after the app attached: `dead=1` here is the app's own
    // attach having taken the pane down, which no later assertion can see.
    dumpEvidence(`${adapter.harness}-after-open`, session);

    await expect
      .poll(() => page.evaluate(() => window.__squaresFrames?.length ?? 0), {
        timeout: 90_000,
        message: `no strip frame for ${adapter.harness}`,
      })
      .toBeGreaterThan(0);

    // The newest frame that carries this reply. A previous test's watcher can
    // still be pushing its own session's strip into this page — the server keeps
    // watching a pty until it is told to stop, and a page that closes without
    // unwatching leaves that feed running — so "the last frame" is not
    // necessarily this harness's.
    const frame = await page.evaluate((marker) => {
      const frames = window.__squaresFrames ?? [];
      return frames.filter((f) => f.turns.some((turn) => turn.said.includes(marker))).pop() ?? null;
    }, liveAgentReplyMarker);
    expect(frame, `no frame ever carried the reply for ${adapter.harness}`).not.toBeNull();
    const replied = frame.turns.filter((turn) => turn.said.includes(liveAgentReplyMarker));
    expect(replied, `the pane's reply was never attributed: ${JSON.stringify(frame.turns.map((t) => t.id))}`).not.toHaveLength(0);
    expect(replied[0].role).toBe("assistant");
    expect(frame.layout, "the server measured no strip").not.toBeNull();

    // The server places what the window can measure: a turn scrolled entirely
    // above the pane's rows has no rows to measure and gets no square, so the
    // layout is a subset of the frame's turns rather than a copy. What it must
    // hold: every square is one of those turns, exactly one is active, and the
    // reply — which is on screen by construction — is placed.
    const placedIds = frame.layout!.squares.map((square) => square.id);
    const turnIds = frame.turns.map((turn) => turn.id);
    expect(new Set(placedIds).size, "a square was placed twice").toBe(placedIds.length);
    for (const id of placedIds) expect(turnIds, `square ${id} is not in the frame`).toContain(id);
    expect(placedIds, "the pane's reply was never placed").toContain(replied[0].id);
    expect(frame.layout!.squares.filter((square) => square.active)).toHaveLength(1);

    // 3. what the client drew from that frame.
    await expect
      .poll(() => page.locator(".asq").count(), { timeout: 30_000, message: "the strip drew no squares" })
      .toBe(placedIds.length);
    await expect(page.locator(".asq[data-active='true']")).toHaveCount(1);
    await expect(page.locator(".term-host.asq-open")).toHaveCount(1);
    const placed = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".asq")].map((square) => Number.parseFloat(square.style.getPropertyValue("--asq-y"))),
    );
    expect(placed).toEqual([...placed].sort((a, b) => a - b));
    expect(Math.max(...placed)).toBeGreaterThan(0);

    // The reply's own square carries the reply, on hover.
    const replySquare = page.locator(`.asq[data-turn='${replied[0].id}']`);
    await expect(replySquare).toHaveCount(1);
    await replySquare.hover();
    const pop = page.locator(".asq:hover .asq-pop");
    await expect(pop).toBeVisible({ timeout: 10_000 });
    await expect(pop).toContainText(liveAgentReplyMarker);
    await page.waitForTimeout(400);

    const png = join(shots, `${adapter.harness}-strip.png`);
    await page.screenshot({ path: png });
    await testInfo.attach(`${adapter.harness}-strip`, { path: png, contentType: "image/png" });
  });
}
