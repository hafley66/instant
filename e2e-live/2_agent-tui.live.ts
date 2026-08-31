import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TuiTest } from "@microsoft/tui-test";
import { expect, test } from "@playwright/test";
import { parseTerminalCast, type TerminalCastEvent } from "../scripts/0_terminalCast";
import {
  liveAgentAdapters,
  liveAgentPrompt,
  liveAgentReplyMarker,
  resolveAgentExecutable,
  resolveLlmockExecutable,
} from "../scripts/2_agentTuiReplay";

declare global {
  interface Window {
    __instantE2eNativeResults?: Record<string, unknown>;
    __term?: {
      write: (data: string) => void;
      resize: (cols: number, rows: number) => void;
      point: (row: number, col: number) => { x: number; y: number } | null;
    };
  }
}

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(repo, "fixtures", "transcripts", "provider", "0_terminal-flow.yaml");
const reportArtifacts = join(repo, "artifacts", "morning-report");
const llmockExecutable = resolveLlmockExecutable(repo);
let scratch = "";
let workspace = "";
let port = 0;
let llmock: ChildProcess | null = null;
let llmockLog = "";
const inheritedNoColor = process.env.NO_COLOR;

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const selected = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return selected;
}

async function waitForProvider(server: ChildProcess, selectedPort: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`llmock exited with ${server.exitCode}`);
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port: selectedPort });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`llmock did not bind 127.0.0.1:${selectedPort}`);
}

async function writeCastEvents(events: readonly TerminalCastEvent[]) {
  for (const [, code, data] of events) {
    if (code === "o") window.__term!.write(data);
    if (code === "r") {
      const [cols, rows] = data.split("x").map(Number);
      window.__term!.resize(cols, rows);
    }
  }
}

async function waitForTerminalText(terminal: TuiTest, wanted: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let screen = "";
  while (Date.now() < deadline) {
    screen = await terminal.text({ full: true });
    if (screen.includes(wanted)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${JSON.stringify(wanted)}\n\n${screen}`);
}

async function settleTerminal(terminal: TuiTest) {
  const timeout = () => new Promise<void>((resolve) => setTimeout(resolve, 5_000));
  await Promise.race([terminal.kill().catch(() => {}), timeout()]);
  await Promise.race([terminal.closeQuiet(), timeout()]);
}

test.beforeAll(async () => {
  test.skip(!llmockExecutable, "run `pnpm replay:setup` to install pinned llmock v0.1.2 locally");
  delete process.env.NO_COLOR;
  scratch = mkdtempSync(join(tmpdir(), "instant-agent-replay-"));
  workspace = join(scratch, "workspace");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(reportArtifacts, { recursive: true });
  port = await unusedLoopbackPort();
  llmock = spawn(llmockExecutable!, [
    "--port", String(port),
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
  await waitForProvider(llmock, port);
});

test.afterAll(() => {
  llmock?.kill();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (inheritedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = inheritedNoColor;
});

for (const adapter of liveAgentAdapters) {
  test(`real ${adapter.harness} CLI consumes a fixed provider stream and renders through Instant`, async ({ page }, testInfo) => {
    const executable = resolveAgentExecutable(adapter);
    test.skip(!executable, `${adapter.harness} executable is absent from PATH`);
    const launch = adapter.writeLaunch(executable!, join(scratch, adapter.harness), workspace, port);
    const terminal = TuiTest.ephemeral(`instant-live-${adapter.harness}-`, {
      profile: { scrollback: 4_000 },
      timeouts: { text: 30_000, idle: 30_000, exit: 10_000 },
    });
    const castPath = testInfo.outputPath(`${adapter.harness}.cast`);

    try {
      await terminal.run(launch.executable, [...launch.args], {
        cols: 120,
        rows: 35,
        cwd: workspace,
        env: { ...launch.env },
      });
      await launch.beginReplay(terminal, castPath);
      await waitForTerminalText(terminal, launch.replyMarker, 30_000);
      await terminal.waitIdle({ timeout: 30_000 });
      await terminal.stopRecording();

      const captured = parseTerminalCast(castPath);
      const renderedText = captured.outputEvents.map((event) => event[2]).join("");
      expect(renderedText).toContain(liveAgentReplyMarker);
      expect(renderedText).toContain("Markdown");

      await page.goto(`/e2e-term.html?e2e=1&noSidebar=1&harness=${adapter.harness}`);
      await page.evaluate((turns) => {
        window.__instantE2eNativeResults!.boop_turns = turns;
      }, launch.turns);
      await page.getByTestId("open-term").click();
      await expect(page.locator(".term-host")).toBeVisible({ timeout: 10_000 });
      await page.waitForFunction(() => !!window.__term?.point(0, 0));
      await page.evaluate(writeCastEvents, captured.events);

      const diagram = page.locator('.term-diagram[data-language="mermaid"]');
      await expect(diagram.locator("svg")).toBeVisible({ timeout: 15_000 });
      await expect(diagram).toContainText("PTY");
      await expect(diagram).toContainText("Markdown");
      await page.locator("#turn-debug-toggle").click();
      await expect(page.locator("#turn-debug-toggle")).toHaveAttribute("aria-pressed", "true");
      const attributedRows = page.locator('.term-turn-debug-row[data-turn-id]:not([data-turn-id=""])');
      await expect.poll(() => attributedRows.count())
        .toBeGreaterThan(0);
      await expect.poll(() => page.locator('.term-turn-debug-row[data-role="assistant"]').count())
        .toBeGreaterThan(0);
      if (await page.locator(".xterm-rows").getByText(liveAgentPrompt, { exact: false }).count()) {
        await expect.poll(() => page.locator('.term-turn-debug-row[data-role="user"]').count())
          .toBeGreaterThan(0);
      }
      await page.locator('[data-testid="visible-turn-readout"], [data-testid="cmd-click-event-readout"]')
        .evaluateAll((elements) => elements.forEach((element) => element.remove()));
      const screenshot = join(reportArtifacts, `${adapter.harness}-turn-attribution.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await testInfo.attach(`${adapter.harness}-turn-attribution`, { path: screenshot, contentType: "image/png" });
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nllmock:\n${llmockLog}`);
    } finally {
      await settleTerminal(terminal);
    }
  });
}
