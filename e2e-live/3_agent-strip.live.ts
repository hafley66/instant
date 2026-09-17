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
      pinned: Array<{ id: string; role: string; said: string }>;
      tags: Record<string, string[]>;
      layout:
        | { mode: "relative"; squares: Square[]; band: number; rows: number }
        | { mode: "map"; squares: Square[]; band: number; span: number; block: { top: number; height: number } }
        | null;
    }>;
  }
}

type Square = { id: string; kind: string; y: number; scale: number; active: boolean };

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
    const bound = await expect
      .poll(() => boundSession(session), {
        timeout: 90_000,
        message: `no session bound to pane ${session}`,
      })
      .not.toBeNull()
      .then(() => boundSession(session));
    expect(bound, `no session bound to pane ${session}`).not.toBeNull();

    // Second dump, after the app attached: `dead=1` here is the app's own
    // attach having taken the pane down, which no later assertion can see.
    dumpEvidence(`${adapter.harness}-after-open`, session);

    await expect
      .poll(() => page.evaluate(() => window.__squaresFrames?.length ?? 0), {
        timeout: 90_000,
        message: `no strip frame for ${adapter.harness}`,
      })
      .toBeGreaterThan(0);

    // The newest frame of THIS session that carries this reply. Two filters,
    // both needed: a previous test's watcher keeps pushing its own session's
    // strip into this page (the server watches a pty until it is told to stop,
    // and a page that closes without unwatching leaves that feed running), and
    // the reply marker is the same string for every harness — so "the last frame
    // carrying the marker" can be another harness's, in another mode.
    const frame = await page.evaluate(
      ([marker, sessionId]) => {
        const frames = window.__squaresFrames ?? [];
        return (
          frames
            .filter((f) => f.session === sessionId && f.turns.some((turn) => turn.said.includes(marker)))
            .pop() ?? null
        );
      },
      [liveAgentReplyMarker, bound],
    );
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
    const relative = frame.layout;
    expect(relative?.mode, "the strip starts in the relative mode").toBe("relative");
    // Two sets, and they are not the same set: the band's squares are the
    // reader's own turns the window does not hold (the frame carries them in
    // `pinned`, not in `turns`), and the rest are rows of the window, which by
    // definition are turns the matcher found on the pane.
    const allIds = relative!.squares.map((square) => square.id);
    const drawnIds = relative!.squares.slice(relative!.band).map((square) => square.id);
    const turnIds = frame.turns.map((turn) => turn.id);
    expect(new Set(allIds).size, "a square was placed twice").toBe(allIds.length);
    for (const id of drawnIds) expect(turnIds, `square ${id} is not in the frame`).toContain(id);
    expect(drawnIds, "the pane's reply was never placed").toContain(replied[0].id);
    expect(relative!.squares.filter((square) => square.active)).toHaveLength(1);

    // The reader's own prompts stay on the strip whatever the mode places: the
    // band is the turns a reader navigates by, and a band square is by
    // definition not a turn the window holds.
    const pinnedIds = frame.pinned.map((turn) => turn.id);
    const bandIds = relative!.squares.slice(0, relative!.band).map((square) => square.id);
    for (const id of bandIds) {
      expect(pinnedIds, `band square ${id} is not a pinned turn`).toContain(id);
      expect(turnIds, `band square ${id} is on the pane after all`).not.toContain(id);
    }

    // 3. what the client drew from that frame.
    await expect
      .poll(() => page.locator(".asq").count(), { timeout: 30_000, message: "the strip drew no squares" })
      .toBe(allIds.length);
    await expect(page.locator(".asq[data-active='true']")).toHaveCount(1);
    await expect(page.locator(".asq[data-band='true']")).toHaveCount(relative!.band);
    await expect(page.locator(".term-host.asq-open")).toHaveCount(1);
    const mapping = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>(".term-host.asq-open")
      const screen = host?.querySelector<HTMLElement>(".xterm-screen")
      const rows = Number(host?.dataset.rows ?? 0)
      return {
        cell: screen && rows ? screen.clientHeight / rows : 0,
        squares: [...document.querySelectorAll<HTMLElement>(".asq:not([data-band='true'])")].map((square) => ({
          id: square.dataset.turn ?? "",
          y: Number.parseFloat(square.style.getPropertyValue("--asq-y")),
        })),
      }
    });
    // The pane gives the strip its right margin up and the grid is measured
    // again so its last column stops at the margin instead of running under it.
    // Reported from a live run as "the margin is nowhere to be found and the
    // squares draw on tui space": both are this geometry, and both settle with
    // the 260ms padding transition, so this polls rather than racing the
    // animation. The padding is on the measured element — padding on the host is
    // invisible to FitAddon, which reads the host's border box.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const host = document.querySelector<HTMLElement>(".term-host.asq-open")
            const term = host?.querySelector<HTMLElement>(".xterm")
            const screen = host?.querySelector<HTMLElement>(".xterm-screen")
            const strip = host?.querySelector<HTMLElement>(".asq-host")
            return {
              padding: term ? getComputedStyle(term).paddingRight : "",
              clear: (screen?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY) <= (strip?.getBoundingClientRect().left ?? 0),
            }
          }),
        { timeout: 10_000, message: "the grid never cleared the strip's margin" },
      )
      .toEqual({ padding: "32px", clear: true });
    // Relative mode draws a square on its own row, so the px it lands on is the
    // server's row times the pane's own row height. That is the whole contract
    // of this mode, and nothing else checks it: a square at the wrong px still
    // looks like a square.
    expect(mapping.cell, "the pane reports its own row height").toBeGreaterThan(0);
    expect(mapping.squares.length).toBe(drawnIds.length);
    for (const drawn of mapping.squares) {
      const placed = relative!.squares.find((square) => square.id === drawn.id);
      expect(placed, `${drawn.id} drew a square the layout does not place`).toBeDefined();
      expect(drawn.y, `${drawn.id} is not on its own row`).toBeCloseTo(placed!.y * mapping.cell, 1);
    }

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

    // 4. A click opens the turn's own card, and the card keeps its place while
    //    the strip re-projects under it: the pane writes, a frame lands, and the
    //    squares move while the card does not.
    await replySquare.click();
    const card = page.locator(".turn-panel");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText(liveAgentReplyMarker);
    const box = await card.boundingBox();
    expect(box, "the card has a box").not.toBeNull();
    const frameCount = () => page.evaluate(() => (window.__squaresFrames ?? []).length);
    const seen = await frameCount();
    tmux(["send-keys", "-t", `${session}:`, "-l", " "]);
    await expect
      .poll(frameCount, { timeout: 60_000, message: "the pane's write never produced a frame" })
      .toBeGreaterThan(seen);
    await expect(card).toBeVisible();
    expect(await card.boundingBox(), "the card moved with the squares").toEqual(box);
    const panelPng = join(shots, `${adapter.harness}-panel.png`);
    await page.screenshot({ path: panelPng });
    await testInfo.attach(`${adapter.harness}-panel`, { path: panelPng, contentType: "image/png" });
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();

    // 5. The other mode. The reader picks it in the toolbar, the server answers
    //    with the map's own shape, and the block is what a scroll moves.
    await page.selectOption("#squares-mode", "map");
    await expect
      .poll(
        () =>
          page.evaluate(
            (sessionId) =>
              (window.__squaresFrames ?? []).filter((f) => f.session === sessionId && f.layout?.mode === "map").length,
            bound,
          ),
        { timeout: 60_000, message: "no map frame after the reader asked for one" },
      )
      .toBeGreaterThan(0);
    const mapFrame = await page.evaluate(
      (sessionId) =>
        (window.__squaresFrames ?? [])
          .filter((f) => f.session === sessionId && f.layout?.mode === "map")
          .pop() ?? null,
      bound,
    );
    const map = mapFrame?.layout;
    expect(map?.mode, "the frame that arrived after the switch").toBe("map");
    if (!map || map.mode !== "map") throw new Error("no map frame to read");
    expect(map.span, "a map with no rows in it").toBeGreaterThan(0);
    expect(map.block.height, "a block with no height").toBeGreaterThan(0);
    expect(map.squares.length).toBeGreaterThan(0);
    await expect
      .poll(() => page.locator(".asq").count(), { timeout: 30_000, message: "the map drew no squares" })
      .toBe(map.squares.length);
    const blockHeight = await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>(".asq-window");
      return block ? Number.parseFloat(block.style.getPropertyValue("--asq-win-height")) : 0;
    });
    expect(blockHeight, "the map drew no window block").toBeGreaterThan(0);
    const mapPng = join(shots, `${adapter.harness}-map.png`);
    await page.screenshot({ path: mapPng });
    await testInfo.attach(`${adapter.harness}-map`, { path: mapPng, contentType: "image/png" });
  });
}
