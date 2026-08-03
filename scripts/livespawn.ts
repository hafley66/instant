// Live-spawn gate: one claude session, started with --model sonnet in its own
// tmux server, is hailed once over the bus and told to run one verbatim
// `opencode run` command; the harness stores are then polled and the trace page
// is rendered from each sample's real bytes.
//
// USER-NAMED EXCEPTION to the 10-second law (2026-08-01): this is a wall-clock
// live test, run on demand only. It must never enter green-all, `vitest run`,
// or the playwright default config.
//
//   node scripts/livespawn.ts --scratch <dir> [--windows 6] [--interval 10]
//
// Writes <scratch>/run.json (samples + transcript), <scratch>/samples/*.json,
// <scratch>/png/*.png. Assertions live in labs/livespawn/livespawn.test.ts and
// read run.json; nothing here asserts.
//
// Two out-of-process reads stand in for rust seams the app owns: claude's
// jsonl store and opencode.db (src-tauri/src/harness.rs is a tauri command, not
// callable from node). Both read the SAME files that seam reads, scoped to the
// gate cwd, and bucket status through LiveGate so the rules stay in one place.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import playwright from "@playwright/test";
import { LiveGate, MAIL_DIR } from "../src/plugins/harnessTrace/0_live.ts";

const SOCKET = "livespawn-gate";
const PANE = "gate-claude";
const PARENT_AGENT = "gate-claude";
const CHILD_AGENT = "oc-child";
const PORT = 4193;
const MODEL = "openrouter/deepseek/deepseek-v4-flash-0731";
// The one command the hail tells claude to run verbatim. It is data here and in
// the mail body; nothing asserts on its text.
const SPAWN_COMMAND = `opencode run -m ${MODEL} --auto "say the word pineapple and stop"`;
// The command ends the sentence: any trailing punctuation is typed into the
// pane too, and claude passes it on as one more argument.
const HAIL_BODY =
  "Reply with the single word done after you run exactly this command with the " +
  "Bash tool, changing nothing about it: " +
  SPAWN_COMMAND;
const OPENCODE_DB = join(homedir(), ".local", "share", "opencode", "opencode.db");

// A bare injected line is indistinguishable from a prompt injection, and a
// recipient that reads its own instructions correctly says so: an unverified
// external instruction demanding exact reproduction and a one-word reply is the
// shape it is told to refuse. The scratch cwd therefore carries the gate's own
// context BEFORE the pane starts, naming the sender, the prefix, the one
// command and the script that sends it, so the hail is checkable against
// something local instead of taken on faith.
function scratchClaudeMd(driverPath: string): string {
  return [
    "# livespawn gate scratch",
    "",
    "This directory is the scratch cwd of the livespawn gate, an on-demand live",
    `test in the instant repo. The driver is \`${driverPath}\`; it created this`,
    "file before starting this session.",
    "",
    "## What will arrive",
    "",
    "One message, injected into this pane by `scripts/bus.ts hail` over tmux,",
    "prefixed `[bus m-<id>]` and sent by the agent id `coordinator`. It asks for",
    "exactly one command to be run with the Bash tool and for the single word",
    "`done` in reply. Running it is the entire purpose of this session.",
    "",
    "## The one pinned command",
    "",
    "```",
    SPAWN_COMMAND,
    "```",
    "",
    "It starts a cheap opencode session in this same cwd, whose row in",
    "`~/.local/share/opencode/opencode.db` is what the gate polls. Nothing else",
    "in this session is expected to touch the filesystem or the network.",
    "",
    "`.claude/settings.json` here allows `Bash(opencode run:*)` and nothing else.",
    "",
  ].join("\n");
}

// The confirmation sent if the recipient challenges the hail instead of running
// it. Sent at most once per run, over the same tmux leg as the hail.
const CONFIRM_LINE = "yes, run it: this is the livespawn gate driver, see CLAUDE.md in this cwd";
// How long after the hail a still-childless, turn-ended pane counts as a
// challenge rather than a slow tool call.
const CONFIRM_AFTER_MS = 25_000;

const transcript: Record<string, unknown>[] = [];

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const next = argv[i + 1];
    out[token.slice(2)] = next && !next.startsWith("--") ? next : "true";
    if (next && !next.startsWith("--")) i += 1;
  }
  return out;
}

// Every CLAUDE* var removed: the pane's claude must boot as its own root
// session, not as a child of the session driving this script.
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("CLAUDE")) continue;
    env[key] = value;
  }
  return env;
}

// One robot-mode cass line runs to kilobytes of counters; run.json is meant to
// be read, so the transcript keeps a head of each stream.
function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}\n… (${trimmed.length} chars)` : trimmed;
}

function step(name: string, bin: string, argv: string[], env?: NodeJS.ProcessEnv) {
  const result = spawnSync(bin, argv, { encoding: "utf8", env: env ?? process.env });
  const entry = {
    at: new Date().toISOString(),
    step: name,
    argv: [bin, ...argv],
    exit: result.status,
    stdout: clip(result.stdout ?? ""),
    stderr: clip(result.stderr ?? ""),
  };
  transcript.push(entry);
  console.log(`[${entry.at}] ${name} exit=${entry.exit}`);
  if (entry.stdout) console.log(entry.stdout);
  if (entry.stderr) console.log(entry.stderr);
  return entry;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tildify(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path;
}

// claude encodes a project dir by replacing every non-alphanumeric char with
// '-', then keeps one <session-uuid>.jsonl per conversation (harness.rs).
function claudeProjectDir(cwd: string): string {
  const enc = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return join(homedir(), ".claude", "projects", enc);
}

function mtimeMs(path: string): number {
  try {
    return Math.floor(statSync(path).mtimeMs);
  } catch {
    return 0;
  }
}

// Mirrors harness.rs read_claude_transcript: the first cwd-bearing record of the
// leading lines carries the session cwd and start ts; a sidechain marker means
// the file is a subagent transcript, not a top-level session.
function readClaudeTranscript(path: string): { cwd: string; ts: string; sidechain: boolean } {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { cwd: "", ts: "", sidechain: false };
  }
  for (const line of text.split("\n").slice(0, 10)) {
    if (!line.trim()) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (value.isSidechain === true) return { cwd: "", ts: "", sidechain: true };
    if (typeof value.cwd === "string") {
      return { cwd: value.cwd, ts: typeof value.timestamp === "string" ? value.timestamp : "", sidechain: false };
    }
  }
  return { cwd: "", ts: "", sidechain: false };
}

// Read from the transcript store, not the pane's pixels; the decision itself is
// LiveGate.turnEnded, which vitest covers.
function claudeTurnEnded(path: string): boolean {
  try {
    return LiveGate.turnEnded(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

function claudeRows(cwd: string, now: number) {
  const dir = claudeProjectDir(cwd);
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    const meta = readClaudeTranscript(path);
    if (meta.sidechain) continue;
    const last = mtimeMs(path);
    const sessionId = name.slice(0, -".jsonl".length);
    rows.push({
      id: sessionId,
      harness: "claude" as const,
      sessionId,
      parentId: null,
      parentKind: null,
      ts: meta.ts,
      lastActivity: LiveGate.iso(last),
      status: LiveGate.status(existsSync(meta.cwd || cwd), last, now),
      cwd: tildify(meta.cwd || cwd),
    });
  }
  return rows;
}

// harness.rs trace_opencode's query, scoped to the gate cwd (the panel's seam
// takes every row; the gate only ever renders its own scratch cwd).
function opencodeRows(cwd: string, now: number) {
  if (!existsSync(OPENCODE_DB)) return [];
  const sql =
    "SELECT id, directory, time_created, time_updated FROM session " +
    `WHERE time_archived IS NULL AND directory = '${cwd.replace(/'/g, "''")}' ` +
    "ORDER BY time_updated DESC";
  const result = spawnSync("sqlite3", ["-readonly", "-json", OPENCODE_DB, sql], { encoding: "utf8" });
  if (result.status !== 0) return [];
  let parsed: { id: string; directory: string; time_created: number; time_updated: number }[];
  try {
    parsed = JSON.parse(result.stdout || "[]");
  } catch {
    return [];
  }
  return parsed.map((row) => ({
    id: row.id,
    harness: "opencode" as const,
    sessionId: row.id,
    parentId: null,
    parentKind: null,
    ts: LiveGate.iso(row.time_created),
    lastActivity: LiveGate.iso(row.time_updated),
    status: LiveGate.status(existsSync(row.directory), row.time_updated, now),
    cwd: tildify(row.directory),
  }));
}

function readMailFiles(mailDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  if (!existsSync(mailDir)) return files;
  for (const name of readdirSync(mailDir).sort()) {
    if (name !== "registry.json" && !name.endsWith(".ndjson")) continue;
    files[name] = readFileSync(join(mailDir, name), "utf8");
  }
  return files;
}

function readRegistry(mailDir: string): Record<string, unknown> {
  const path = join(mailDir, "registry.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function writeRegistry(mailDir: string, registry: Record<string, unknown>) {
  writeFileSync(join(mailDir, "registry.json"), JSON.stringify(registry, null, 2) + "\n");
}

async function waitFor<T>(what: string, attempts: number, everyMs: number, probe: () => T | null): Promise<T | null> {
  for (let i = 0; i < attempts; i += 1) {
    const value = probe();
    if (value !== null) return value;
    await wait(everyMs);
  }
  transcript.push({ at: new Date().toISOString(), step: `wait:${what}`, exit: 1, stdout: "timed out" });
  return null;
}

// First port at or above `from` the OS will hand out. Probing by binding and
// closing races only against another gate run, which is the one case
// --strictPort then reports instead of silently sharing a server.
function freePort(from: number): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.on("error", () => resolve(freePort(from + 1)));
    probe.listen(from, "127.0.0.1", () => probe.close(() => resolve(from)));
  });
}

async function webUp(url: string): Promise<boolean> {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      // dev server not listening yet
    }
    await wait(500);
  }
  return false;
}

async function renderSample(browser, url: string, sample) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 620 } });
  const page = await context.newPage();
  // relTime cells render against Date.now(): pin it to the sample's own instant
  // so "activity" reads as it did when the stores were read.
  await page.clock.setFixedTime(new Date(sample.atMs));
  await page.addInitScript((seed) => {
    const files = seed.files;
    (window as unknown as { __instantE2eNativeResults: Record<string, unknown> }).__instantE2eNativeResults = {
      harness_trace_rows: seed.rows,
      list_dir: (args?: Record<string, unknown>) => {
        if (args?.path === seed.mailDir) {
          return {
            entries: Object.keys(files).map((name) => ({
              name,
              path: `${seed.mailDir}/${name}`,
              is_dir: false,
            })),
          };
        }
        throw new Error("no such dir");
      },
      read_text: (args?: Record<string, unknown>) => {
        const path = typeof args?.path === "string" ? args.path : "";
        const name = path.slice(seed.mailDir.length + 1);
        if (name in files) return files[name];
        throw new Error("no such file");
      },
    };
  }, LiveGate.seed(sample));
  await page.goto(url);
  await page.locator('#actbar [data-panel="harness-trace"]').click();
  const panel = page.getByTestId("harness-trace");
  await panel.waitFor({ timeout: 10_000 });
  // Open every root that has children so a spawned child is on screen.
  for (let i = 0; i < 4; i += 1) {
    const twisty = panel.locator("tr .tt-twisty").nth(i);
    if ((await twisty.count()) === 0) break;
    await twisty.click().catch(() => {});
  }
  await page.waitForTimeout(200);
  await panel.screenshot({ path: sample.png });
  await context.close();
}

async function main() {
  const args = flags(process.argv.slice(2));
  const root = dirname(import.meta.dirname);
  const scratch = args.scratch ?? join(tmpdir(), "livespawn-gate");
  // A fresh cwd per run: claude keys its transcript store on the cwd and
  // opencode keys session.directory on it, so a reused cwd would hand the run
  // the PREVIOUS run's sessions as its own rows.
  const runId = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const cwd = join(scratch, `cwd-${runId}`);
  const mailDir = join(scratch, "mail");
  const samplesDir = join(scratch, "samples");
  const pngDir = join(scratch, "png");
  const windows = Number(args.windows ?? 6);
  const intervalMs = Number(args.interval ?? 10) * 1000;
  const startedAt = new Date().toISOString();

  for (const dir of [cwd, mailDir, samplesDir, pngDir]) mkdirSync(dir, { recursive: true });
  rmSync(join(mailDir, "bus.ndjson"), { force: true });
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  // The pane must be able to run the one command it is told to run without a
  // human at the keyboard; nothing else is allowed.
  writeFileSync(
    join(cwd, ".claude", "settings.json"),
    JSON.stringify({ permissions: { allow: ["Bash(opencode run:*)"], deny: [] } }, null, 2) + "\n",
  );
  // Written before the pane starts so it is session context, not a later read.
  writeFileSync(join(cwd, "CLAUDE.md"), scratchClaudeMd(join(root, "scripts", "livespawn.ts")));
  // The send leg only needs the pane; the session id and source path are the
  // ack leg's, and claude does not write a transcript until its first message,
  // so they are filled in after the hail lands.
  writeRegistry(mailDir, {
    [PARENT_AGENT]: { sessionId: "", harness: "claude", tmux: PANE, sourcePath: null },
  });

  const env = scrubbedEnv();
  step("default-socket-before", "tmux", ["-L", "default", "ls"]);
  step("kill-stale-gate", "tmux", ["-L", SOCKET, "kill-server"], env);
  step("new-session", "tmux", [
    "-L", SOCKET, "new-session", "-d", "-s", PANE, "-x", "200", "-y", "50", "-c", cwd,
    "claude", "--model", "sonnet",
  ], env);
  await wait(8000);
  // Scratch cwd = a folder claude has never seen: answer the trust prompt.
  step("trust-prompt", "tmux", ["-L", SOCKET, "send-keys", "-t", PANE, "Enter"], env);
  await wait(4000);

  // Own port, so a sibling lane's dev server cannot serve its tree's sources
  // into this gate's PNGs. Taken by asking the OS for a free one, never by
  // killing whatever holds the preferred number: the gate kills only processes
  // it started.
  const port = await freePort(PORT);
  transcript.push({ at: new Date().toISOString(), step: "web-port", exit: 0, stdout: String(port), stderr: "" });
  const web = spawn(join(root, "node_modules", ".bin", "vite"), [
    "--host", "127.0.0.1", "--port", String(port), "--strictPort",
  ], { cwd: root, stdio: "ignore", detached: true });
  const url = `http://127.0.0.1:${port}/e2e-harness-trace.html?e2e=1`;
  if (!(await webUp(url))) throw new Error(`vite never came up on ${port}`);
  const browser = await playwright.chromium.launch();

  const hail = step("hail", "node", [
    join(root, "scripts", "bus.ts"),
    "hail", "--mail-dir", mailDir, "--socket", SOCKET,
    "--to", PARENT_AGENT, "--from", "coordinator", "--kind", "dispatch",
    "--body", HAIL_BODY,
  ]);
  const hailId = /queued (m-[0-9a-f]+)/.exec(hail.stdout)?.[1] ?? "";
  const hailedAt = Date.now();

  const samples = [];
  let childSessionId = "";

  // The spawn edge. Nothing in either harness writes a bus row when one agent
  // starts another, so the observer writes it the moment it first sees the db
  // row, before the sample that will render it: an edge minted after its own
  // sample would leave that sample's child hanging off nothing.
  // to_timestamp stays null — no cass proof was taken for this row.
  // `opencode run` leaves more than one session row in the cwd (the titled one
  // that answers, plus its own bookkeeping rows), so the spawned child is the
  // EARLIEST created, never whichever row was touched last: newest-updated
  // flips between polls and would hand a later sample a different child.
  const registerChild = (rows: { harness: string; sessionId: string; ts: string }[]) => {
    const child = rows
      .filter((row) => row.harness === "opencode")
      .sort((a, b) => a.ts.localeCompare(b.ts))[0];
    if (!child || childSessionId) return;
    childSessionId = child.sessionId;
    const registry = readRegistry(mailDir);
    registry[CHILD_AGENT] = { sessionId: childSessionId, harness: "opencode", tmux: null, sourcePath: null };
    writeRegistry(mailDir, registry);
    appendFileSync(join(mailDir, "bus.ndjson"), JSON.stringify({
      id: "m-spawn-" + childSessionId.slice(-8),
      from: PARENT_AGENT,
      to: CHILD_AGENT,
      from_timestamp: child.ts,
      to_timestamp: null,
      kind: "dispatch",
      reply_to: hailId || null,
      body: SPAWN_COMMAND,
      ref: null,
    }) + "\n");
    console.log(`child session ${childSessionId} registered`);
  };

  const takeSample = async (index: number) => {
    const now = Date.now();
    const opencode = opencodeRows(cwd, now);
    registerChild(opencode);
    // The gate follows the session it saw spawned; opencode's other rows in the
    // same cwd are its own bookkeeping and are not this run's child.
    const rows = [
      ...claudeRows(cwd, now),
      ...opencode.filter((row) => row.sessionId === childSessionId),
    ];
    const sample = {
      index,
      at: new Date(now).toISOString(),
      atMs: now,
      rows,
      files: readMailFiles(mailDir),
      png: join(pngDir, `${String(index).padStart(2, "0")}.png`),
    };
    await renderSample(browser, url, sample);
    writeFileSync(join(samplesDir, `${String(index).padStart(2, "0")}.json`), JSON.stringify(sample, null, 2));
    samples.push(sample);
    const child = sample.rows.find((row) => row.harness === "opencode");
    const parent = sample.rows.find((row) => row.harness === "claude");
    console.log(
      `sample ${index} @${sample.at} parent=${parent?.status ?? "-"} child=${child?.sessionId ?? "-"}:${child?.status ?? "-"}`,
    );
    return sample;
  };

  const projectDir = claudeProjectDir(cwd);
  const jsonl = await waitFor("claude-session", 60, 500, () => {
    if (!existsSync(projectDir)) return null;
    const files = readdirSync(projectDir).filter((name) => name.endsWith(".jsonl"));
    return files.length ? join(projectDir, files.sort()[0]) : null;
  });
  if (!jsonl) {
    step("capture-no-session", "tmux", ["-L", SOCKET, "capture-pane", "-p", "-t", PANE], env);
    throw new Error(`claude never wrote a transcript under ${projectDir}`);
  }
  const claudeSessionId = jsonl.slice(jsonl.lastIndexOf("/") + 1, -".jsonl".length);
  writeRegistry(mailDir, {
    [PARENT_AGENT]: { sessionId: claudeSessionId, harness: "claude", tmux: PANE, sourcePath: jsonl },
  });
  console.log(`claude session ${claudeSessionId}`);

  // First sample: the hail has landed and claude's transcript exists, but the
  // command it was told to run has not created an opencode session yet.
  await takeSample(0);

  let acked = 0;
  let sweeps = 0;
  let confirmations = 0;
  let compliance = "direct";
  const totalTicks = windows * Math.max(1, Math.round(60_000 / intervalMs));
  for (let tick = 1; tick <= totalTicks; tick += 1) {
    await wait(intervalMs);
    const sample = await takeSample(tick);
    const pane = spawnSync("tmux", ["-L", SOCKET, "capture-pane", "-p", "-t", PANE], { encoding: "utf8", env });
    // Claude asks before a Bash call the allow-list does not cover; the dialog's
    // first option is "yes", so an Enter keeps the pane moving. Logged, never
    // matched on prompt text beyond the dialog marker.
    if (/Do you want to (proceed|run)/i.test(pane.stdout ?? "")) {
      step(`permission-enter-${tick}`, "tmux", ["-L", SOCKET, "send-keys", "-t", PANE, "Enter"], env);
    }

    // Challenge state, read structurally: the turn is over, nothing was spawned,
    // and enough time has passed that a slow tool call is not the explanation.
    // The recipient is entitled to ask; the driver answers ONCE and records that
    // it had to, because a challenged hail and a direct one are different facts.
    const challenged =
      !childSessionId &&
      confirmations === 0 &&
      Date.now() - hailedAt >= CONFIRM_AFTER_MS &&
      claudeTurnEnded(jsonl);
    if (challenged) {
      confirmations += 1;
      compliance = "challenged";
      step("confirm-1", "tmux", ["-L", SOCKET, "send-keys", "-t", PANE, "-l", "--", CONFIRM_LINE], env);
      step("confirm-1-enter", "tmux", ["-L", SOCKET, "send-keys", "-t", PANE, "Enter"], env);
      console.log("recipient challenged the hail; one confirmation sent");
    }

    if (childSessionId && acked === 0 && sweeps < 4) {
      sweeps += 1;
      step(`cass-index-${sweeps}`, "cass", ["index", "--watch-once", dirname(jsonl), "--robot"]);
      const swept = step(`sweep-${sweeps}`, "node", [
        join(root, "scripts", "bus.ts"), "sweep", "--mail-dir", mailDir, "--agent", PARENT_AGENT,
      ]);
      acked = Number(/acked (\d+)/.exec(swept.stdout)?.[1] ?? "0");
    }

    const childRow = sample.rows.find((row) => row.harness === "opencode");
    if (acked > 0 && childRow && childRow.status !== "live") break;
  }

  // One last sample after the ack row landed, so the final PNG shows it.
  await takeSample(samples.length);

  await browser.close();
  try {
    process.kill(-web.pid!, "SIGTERM");
  } catch {
    // dev server already gone
  }
  await wait(1000);
  try {
    // Only ever this run's own dev server, by process group id.
    process.kill(-web.pid!, "SIGKILL");
  } catch {
    // exited on the SIGTERM above
  }
  step("list-mail", "node", [join(root, "scripts", "bus.ts"), "list", "--mail-dir", mailDir]);
  step("capture-final", "tmux", ["-L", SOCKET, "capture-pane", "-p", "-t", PANE], env);
  step("kill-gate", "tmux", ["-L", SOCKET, "kill-server"], env);
  step("gate-socket-after", "tmux", ["-L", SOCKET, "ls"], env);
  step("default-socket-after", "tmux", ["-L", "default", "ls"]);

  writeFileSync(join(scratch, "run.json"), JSON.stringify({
    startedAt,
    finishedAt: new Date().toISOString(),
    scratch,
    socket: SOCKET,
    pane: PANE,
    model: { claude: "sonnet", opencode: MODEL },
    cwd,
    mailDir,
    claudeSessionId,
    childSessionId,
    hailId,
    spawnCommand: SPAWN_COMMAND,
    // Whether the recipient ran the pinned command off the hail alone
    // ("direct") or asked to have it confirmed first ("challenged").
    compliance,
    confirmations,
    samples,
    transcript,
  }, null, 2) + "\n");
  console.log(`run.json written to ${join(scratch, "run.json")}`);
}

await main();
