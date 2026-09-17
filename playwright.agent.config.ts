import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Live agent tier: a real CLI — claude, codex, opencode, kimi — talking to the
// pinned llmock provider, running inside a private tmux server, with the built
// bundle served by instant-serve. Nothing on the path is stubbed: the pane is a
// real pane, the transcript is the CLI's own, the store ingest is the shipped
// one, and the capture, the matcher and the strip's layout are the shipped
// code. The provider is what makes it deterministic — the same fixed stream
// every run, no model called.
//
// Isolation is the README tier's, one level tighter because an agent runs here:
//   HOME           scratch home the CLI writes its config and transcript into,
//                  and the same HOME the server resolves that registry from
//   TMUX_TMPDIR    private socket; the agent's pane and the app's capture share it
//   BOOP_DB / BOOP_MAIL_DIR  scratch store and mailbox for the ingest
//   BOOP_NO_SYNC   no startup sync; the app's own per-tab sync does the ingest
//   INSTANT_NO_GLOBALS  no tray, global shortcut, or summon gesture
const port = Number(process.env.INSTANT_AGENT_PORT ?? 47821);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const serve = process.env.INSTANT_AGENT_SERVE ?? path.join(root, "src-tauri/target/debug/instant-serve");
const scratchRoot = process.env.INSTANT_AGENT_TMP ?? `/private/tmp/instant-agent-${port}`;
const home = path.join(scratchRoot, "home");
const tmuxDir = path.join(scratchRoot, "tmux");
const boopDir = path.join(scratchRoot, "boop");
const boopDb = path.join(boopDir, "boop.db");
const dataDir = path.join(scratchRoot, "serve");

for (const dir of [home, tmuxDir, boopDir, dataDir]) fs.mkdirSync(dir, { recursive: true });

export default defineConfig({
  testDir: "./e2e-live",
  testMatch: "**/3_agent-strip.live.ts",
  workers: 1,
  timeout: 240_000,
  outputDir: "test-results/agent-strip",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 960 },
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    // The app persists its workspace — tabs, their bindings, the favicon cache —
    // under `--data-dir`, and a run that inherits the last one's tabs opens them
    // against panes that no longer exist: a restored tab keeps a stale binding
    // and never watches the pane this run started. The tier owns this directory,
    // so it starts empty.
    command:
      `rm -rf ${dataDir} && ` +
      `env -u TMUX HOME=${home} TMUX_TMPDIR=${tmuxDir} PATH=${path.dirname(process.env.BOOP_BIN ?? path.join(process.env.HOME ?? "", ".cargo/bin/boop"))}:$PATH ` +
      `INSTANT_NO_GLOBALS=1 INSTANT_TMUX_SOCKET= BOOP_DB=${boopDb} BOOP_MAIL_DIR=${boopDir} BOOP_NO_SYNC=1 ` +
      `${serve} --port ${port} --data-dir ${dataDir} --dist ${path.join(root, "dist")}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: !!process.env.INSTANT_AGENT_REUSE,
    timeout: 30_000,
  },
  metadata: { scratchRoot, home, tmuxDir, boopDir, boopDb },
});
