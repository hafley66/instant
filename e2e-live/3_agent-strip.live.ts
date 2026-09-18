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
    __echoProbe?: { enabled: boolean; pending?: { at: number; id: string; text: string }; samples: number[] };
    __squaresFrames?: Array<{
      session: string;
      rows: number;
      turns: Array<{ id: string; role: string; said: string }>;
      pinned: Array<{ id: string; role: string; said: string }>;
      tags: Record<string, string[]>;
      layout:
        | { mode: "relative"; squares: Square[]; band: number; rows: number }
        | { mode: "recent"; squares: Square[]; rows: number }
        | null;
    }>;
  }
}

type Square = { id: string; kind: string; y: number; scale: number; active: boolean };

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(repo, "fixtures", "transcripts", "provider", "2_terminal-scroll.yaml");
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
    if (tmux(["capture-pane", "-p", "-J", "-S", "-200", "-t", session]).stdout.includes(wanted)) return;
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
    window.__echoProbe = { enabled: false, samples: [] };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        const frame = JSON.parse(String(data));
        if (window.__echoProbe!.enabled && frame.method === "write_pty" && /^[a-z0-9]$/.test(frame.params?.data)) {
          window.__echoProbe!.pending = { at: performance.now(), id: frame.params.id, text: frame.params.data };
        }
      } catch {}
      return send.call(this, data);
    };
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
            const pending = window.__echoProbe?.pending;
            if (pending && frame?.params?.event === "pty-data-batch"
              && frame.params.payload.chunks.some((chunk: { id: string; chunk: string }) => chunk.id === pending.id && chunk.chunk.includes(pending.text))) {
              window.__echoProbe!.samples.push(performance.now() - pending.at);
              delete window.__echoProbe!.pending;
            }
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

/// Ask the app's own rpc for a scroll, the way the UI's wheel handler does: the
/// `scroll_session` command on the pane's session, over the loopback socket the
/// serve binary opens. The reply says the command ran; the frame it wakes is the
/// assertion.
async function askScroll(session: string): Promise<boolean> {
  const port = Number(process.env.INSTANT_AGENT_PORT ?? 47821);
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const done = (answer: boolean) => {
      socket.close();
      resolve(answer);
    };
    const timer = setTimeout(() => done(false), 10_000);
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "scroll_session",
          params: { name: session, up: true, lines: 40 },
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as { id?: number; error?: unknown };
      if (frame.id !== 1) return;
      clearTimeout(timer);
      done(!frame.error);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
}

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
    expect(relative!.squares.filter((square) => square.active).map((square) => square.id)).toEqual(drawnIds);

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
    await expect(page.locator(".asq[data-active='true']")).toHaveCount(drawnIds.length);
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
      expect(placed?.id, `${drawn.id} drew a square the layout does not place`).toBe(drawn.id);
      expect(drawn.y, `${drawn.id} is not on its own row`).toBeCloseTo(placed!.y * mapping.cell, 1);
    }

    // The reply's own square carries the reply, on hover.
    const replySquare = page.locator(`.asq[data-turn='${replied[0].id}']`);
    await expect(replySquare).toHaveCount(1);
    fs.writeFileSync(join(shots, `${adapter.harness}-hit-target.json`), JSON.stringify(await replySquare.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      return { box: box.toJSON(), own: node.outerHTML, hit: hit?.outerHTML.slice(0, 1000) };
    }), null, 2));
    await replySquare.hover();
    const pop = page.locator(".asq:hover .asq-pop");
    await expect(pop).toBeVisible({ timeout: 10_000 });
    await expect(pop).toContainText(liveAgentReplyMarker);
    await page.waitForTimeout(400);

    // The pointer magnifies what it is over, Dock-style: the hovered square
    // carries the active multiplier on top of whatever size the server gave it,
    // and a square the pointer is not over keeps exactly that size.
    const shown = await page.evaluate(() => {
      const scaleOf = (el: HTMLElement) => Number.parseFloat(getComputedStyle(el).transform.slice(7).split(",")[0]);
      const ownOf = (el: HTMLElement) => Number.parseFloat(el.style.getPropertyValue("--asq-scale"));
      const hovered = document.querySelector<HTMLElement>(".asq:hover");
      const cold = [...document.querySelectorAll<HTMLElement>(".asq:not(:hover)")].pop();
      return {
        hovered: hovered ? { drawn: scaleOf(hovered), own: ownOf(hovered) } : null,
        cold: cold ? { drawn: scaleOf(cold), own: ownOf(cold) } : null,
      };
    });
    expect(shown.hovered, "the pointer is over a square").not.toBeNull();
    expect(shown.cold, "a square the pointer is not over").not.toBeNull();
    // How much it magnifies is the stylesheet's business; that it magnifies the
    // square under the pointer and nothing else is this test's.
    expect(shown.hovered!.drawn, "the hovered square is magnified").toBeCloseTo(shown.hovered!.own * 1.1, 2);
    expect(shown.cold!.drawn, "a cold square draws at its own size").toBeCloseTo(shown.cold!.own, 1);
    const popGeometry = await pop.evaluate((node) => {
      const element = node as HTMLElement;
      const pane = element.closest(".term-host")!;
      const owner = element.closest(".asq")!;
      const parentScale = Number.parseFloat(getComputedStyle(owner).transform.slice(7).split(",")[0]);
      return { scale: Number.parseFloat(getComputedStyle(element).scale) * parentScale,
        fraction: element.getBoundingClientRect().width / pane.getBoundingClientRect().width };
    });
    expect(popGeometry.scale).toBeCloseTo(1, 2);
    expect(popGeometry.fraction).toBeCloseTo(0.36, 2);

    const png = join(shots, `${adapter.harness}-strip.png`);
    await page.screenshot({ path: png });
    await testInfo.attach(`${adapter.harness}-strip`, { path: png, contentType: "image/png" });

    // 4. A click opens the turn's own card, and the card keeps its place while
    //    the strip re-projects under it: the reader scrolls, a frame lands, and
    //    the squares move while the card does not.
    await replySquare.click();
    const card = page.locator(".turn-panel");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card).toContainText(liveAgentReplyMarker);
    // A fence that is a diagram is drawn, not printed: the card hands both
    // diagram languages to the renderer the terminal's own overlay uses, so the
    // reply's mermaid and d2 blocks arrive as SVG rather than as code. A diagram
    // lands a tick after the text does, so this is also what settles the card's
    // own height before its place is measured below.
    await expect(card.locator(".mdview-mermaid svg").first()).toBeVisible({ timeout: 30_000 });
    await expect(card.locator(".mdview-d2 svg").first()).toBeVisible({ timeout: 30_000 });
    const box = await card.boundingBox();
    expect(box, "the card has a box").not.toBeNull();
    const frameCount = () => page.evaluate(() => (window.__squaresFrames ?? []).length);
    const seen = await frameCount();
    // A reader action that re-projects the strip without restarting it: the pane
    // writes another turn, so its own rows change and the frame the feed sends is
    // a different one. (Not a pane write the projection ignores — a space typed
    // into a composer is one of those and is correctly not sent at all. Not the
    // mode either: that restarts the watcher, card and all.)
    await submitPrompt(session, "one more, please");
    await expect
      .poll(frameCount, { timeout: 90_000, message: "the pane's second turn never produced a frame" })
      .toBeGreaterThan(seen);
    await expect(card).toBeVisible();
    expect(await card.boundingBox(), "the card moved with the squares").toEqual(box);
    // A scroll is not pane output either — the reader's window is read off
    // tmux's `scroll_position` — so the app nudges the feed itself when the
    // reader scrolls. Asked over the app's own rpc rather than with a wheel: a
    // pane whose TUI grabs the mouse consumes the wheel and scrolls its own
    // view, which is a different thing and would test the TUI.
    expect(await askScroll(session), "the rpc took the scroll").toBe(true);
    // The screenshot is taken at the end of the body, where the diagrams are.
    await card.locator(".turn-panel-body").evaluate((body) => {
      body.scrollTop = body.scrollHeight;
    });
    const panelPng = join(shots, `${adapter.harness}-panel.png`);
    await page.screenshot({ path: panelPng });
    await testInfo.attach(`${adapter.harness}-panel`, { path: panelPng, contentType: "image/png" });
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();

    // 5. The other mode — the reader picked it in the toolbar above — and the
    //    server answers with the session's own recency list: the newest
    //    conversation turns, one square each, uniform, oldest first. A set that
    //    is not the window's, and a placement that is not a row.
    await page.selectOption("#squares-mode", "recent");
    const recentFrames = () =>
      page.evaluate(
        (sessionId) =>
          (window.__squaresFrames ?? []).filter((f) => f.session === sessionId && f.layout?.mode === "recent"),
        bound,
      );
    await expect
      .poll(() => recentFrames().then((frames) => frames.length), {
        timeout: 60_000,
        message: "no recent frame after the reader asked for one",
      })
      .toBeGreaterThan(0);
    const recentFrame = (await recentFrames()).pop();
    const recent = recentFrame?.layout;
    if (!recent || recent.mode !== "recent") throw new Error("no recent frame to read");
    const carried = new Set((recentFrame?.turns ?? []).map((turn) => turn.id));
    const roleOf = new Map((recentFrame?.turns ?? []).map((turn) => [turn.id, turn.role]));
    expect(recent.squares.length, "a recency list with nothing in it").toBeGreaterThan(0);
    for (const square of recent.squares) {
      // A square the frame cannot name has nothing to show on hover, so the
      // client drops it: the frame carries every turn the list placed.
      expect(carried, `square ${square.id} is not on the frame`).toContain(square.id);
      expect(["user", "assistant"], `a ${roleOf.get(square.id)} turn drew a square`).toContain(roleOf.get(square.id));
    }
    // Places in the block, oldest first, all one size: a place, never a row.
    expect(recent.squares.map((square) => square.y)).toEqual(recent.squares.map((_, index) => index));
    expect(new Set(recent.squares.map((square) => square.scale))).toEqual(new Set([1]));
    await expect
      .poll(() => page.locator(".asq").count(), { timeout: 30_000, message: "the recency block drew no squares" })
      .toBe(recent.squares.length);
    // The block rides the reader: the square for the turn being read sits on the
    // reader's line at the pane's bottom edge, older turns above it and newer
    // ones below, one step apart — and the block is pushed down when it would
    // run off the pane's top. A centred block would instead sit wherever its own
    // height put it and never move with the scroll.
    const block = await page.evaluate(() => {
      const strip = document.querySelector<HTMLElement>(".asq-strip");
      const tracks = Number.parseFloat(strip?.style.getPropertyValue("--asq-track") ?? "0");
      const step = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--asq-step") || "0",
      );
      const squares = [...document.querySelectorAll<HTMLElement>(".asq:not([data-band='true'])")].map((square) => ({
        id: square.dataset.turn ?? "",
        y: Number.parseFloat(square.style.getPropertyValue("--asq-y")),
        active: square.dataset.active === "true",
      }));
      return { tracks, step, squares };
    });
    expect(block.step, "the strip's own step, in px").toBeGreaterThan(0);
    expect(block.squares.length).toBe(recent.squares.length);
    const read = block.squares.findIndex((square) => square.active);
    expect(read, "the square the reader is inside is on the strip").toBeGreaterThanOrEqual(0);
    const start = Math.max(0, (block.tracks - (block.squares.length - 1) * block.step) / 2);
    expect(block.squares.map((square) => square.y)).toEqual(block.squares.map((_, index) => start + index * block.step));
    const stacked = [...block.squares].sort((left, right) => left.y - right.y);
    for (let index = 1; index < stacked.length; index += 1) {
      expect(stacked[index].y - stacked[index - 1].y, "a square per step").toBeCloseTo(block.step, 0);
    }
    const recentPng = join(shots, `${adapter.harness}-recent.png`);
    await page.screenshot({ path: recentPng });
    await testInfo.attach(`${adapter.harness}-recent`, { path: recentPng, contentType: "image/png" });

    // Exercise the actual wheel path and keyboard echo in this private pane.
    tmux(["send-keys", "-t", session, "-X", "cancel"]);
    const terminal = page.locator(".term-host .xterm-screen:visible");
    await terminal.click();
    const beforeWheel = paneText(session);
    const terminalMode = tmux(["display-message", "-p", "-t", session,
      "#{alternate_on} #{history_size} #{mouse_any_flag}"]).stdout.trim();
    if (adapter.harness === "claude") expect(terminalMode).toBe("1 0 1");
    await page.mouse.wheel(0, -480);
    await expect.poll(() => paneText(session), { timeout: 10_000 }).not.toBe(beforeWheel);
    tmux(["send-keys", "-t", session, "-X", "cancel"]);
    await page.mouse.wheel(0, 4000);
    const echoes: Array<{ squares: boolean; milliseconds: number; perKeyMs: number[] }> = [];
    for (const enabled of [true, false, true]) {
      const toggle = page.locator("#squares-toggle");
      if ((await toggle.getAttribute("aria-pressed")) !== String(enabled)) await toggle.click();
      await terminal.click();
      await page.keyboard.press("Control+u");
      const marker = `ASQ_INPUT_${echoes.length}_0123456789`;
      const started = performance.now();
      await page.keyboard.insertText(marker);
      await expect.poll(() => paneText(session), { intervals: [10], timeout: 2000 }).toContain(marker);
      const milliseconds = Math.round(performance.now() - started);
      await page.evaluate(() => { window.__echoProbe = { enabled: true, samples: [] }; });
      for (const character of "abcdefgh") {
        const count = await page.evaluate(() => window.__echoProbe!.samples.length);
        await page.keyboard.press(character);
        await expect.poll(() => page.evaluate(() => window.__echoProbe!.samples.length), { intervals: [10], timeout: 2000 }).toBe(count + 1);
      }
      const perKeyMs = await page.evaluate(() => {
        window.__echoProbe!.enabled = false;
        return window.__echoProbe!.samples.map((value) => Math.round(value * 10) / 10);
      });
      echoes.push({ squares: enabled, milliseconds, perKeyMs });
      await page.keyboard.press("Control+u");
    }
    await testInfo.attach("keyboard-echo", { body: JSON.stringify(echoes), contentType: "application/json" });
    fs.writeFileSync(join(shots, `${adapter.harness}-echo.json`), JSON.stringify({ echoes, popGeometry, terminalMode }, null, 2));
    dumpEvidence(`${adapter.harness}-verified`, session);
    expect(echoes.every((sample) => sample.milliseconds < 500), JSON.stringify(echoes)).toBe(true);
  });
}
