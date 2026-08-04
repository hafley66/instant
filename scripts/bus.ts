// Message-bus edge CLI (2026-08-03 bus ruling): the queue is an NDJSON file on
// the OS filesystem, tmux is the injection transport, cass is the ack reader.
// Every decision lives in the pure modules this shells around
// (src/plugins/harnessTrace/0_bus.ts, 1_leg.ts); here there is only fs and
// spawn. Run with node's type stripping:
//   node scripts/bus.ts hail --to <agent> --body "..."
//   node scripts/bus.ts sweep [--max-age-days <n>] [--close-routeless]
//   node scripts/bus.ts list [--agent <agent>] [--all]
//   node scripts/bus.ts dispatch --to <lane-id> --cwd <dir> --cmd <shell command>
//   node scripts/bus.ts resolve --to <lane-id> [--mail-dir <dir>]
//   node scripts/bus.ts lane --cwd <dir> --name <lane-id> [--brief <path>] [--model <id>] [--tmux <name>] [--parent <agent>]
//   node scripts/bus.ts adopt --name <agent> --tmux <session> --harness <h> [--cwd <dir>] [--model <id>] [--mode <m>]
//   node scripts/bus.ts prune
// Exit codes: 0 ok, 1 usage/route error, 2 appended but not injected.
import { existsSync, appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { MailDirectory, MailStore } from "../src/plugins/harnessTrace/0_bus.ts";
import { MailLeg, injectedLine } from "../src/plugins/harnessTrace/1_leg.ts";
import { casUpdateJson, CorruptJsonError } from "./0_atomicJson.ts";

const DEFAULT_MAIL_DIR = "~/.agent/mail";
const DEFAULT_BOX = "bus.ndjson";

function untildify(path) {
  return path.startsWith("~") ? homedir() + path.slice(1) : path;
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const next = argv[i + 1];
    out[token.slice(2)] = next && !next.startsWith("--") ? next : "true";
    if (next && !next.startsWith("--")) i += 1;
  }
  return out;
}

function mailDirOf(args) {
  return untildify(args["mail-dir"] ?? DEFAULT_MAIL_DIR);
}

function readDirectory(dir) {
  const path = join(dir, "registry.json");
  return existsSync(path) ? MailDirectory.parse(readFileSync(path, "utf8")) : {};
}

// One entry per mailbox file so an ack row lands back in the file that holds
// its send row (append-only law: the log stays readable per file).
function readBoxes(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ndjson"))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      return { path, messages: MailStore.parse(readFileSync(path, "utf8")) };
    });
}

function allMessages(boxes) {
  return boxes.flatMap((box) => box.messages);
}

function append(path, message) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, MailStore.line(message) + "\n");
}

function run(bin, argv) {
  const result = spawnSync(bin, argv, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function nowIso() {
  return new Date().toISOString();
}

function mintId() {
  return "m-" + globalThis.crypto.randomUUID().slice(0, 8);
}

function readRegistryRaw(dir) {
  const path = join(dir, "registry.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    console.log(`registry.json is invalid JSON at ${path}: fix or remove it by hand`);
    throw new CorruptJsonError(`registry.json is invalid JSON at ${path}`);
  }
}

// null means tmux itself is unreachable, which is not the same as "no sessions".
function liveSessions() {
  const result = run("tmux", ["list-sessions", "-F", "#{session_name}"]);
  if (!result.ok) return null;
  return new Set(result.stdout.split("\n").filter(Boolean));
}

function mergeRoute(dir, laneId, route) {
  casUpdateJson(join(dir, "registry.json"), (registry) => ({ ...registry, [laneId]: route }));
}

// ---- per-harness session artifacts (the strip's ground truth, not dispatch
// args): codex rollouts / claude transcripts / the opencode.db. Each reader
// returns null when its source is unreadable, never throws, never guesses. ----

// Newest codex rollout whose session_meta cwd matches, or null. Codex stores
// rollouts as dated nested dirs under ~/.codex/sessions/<yyyy>/<MM>/<dd>.
function codexRolloutFor(cwd) {
  const root = join(homedir(), ".codex", "sessions");
  const stack = [root];
  let newest = null;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.name.endsWith(".jsonl")) {
        if (codexRolloutCwd(full) !== cwd) continue;
        const mtime = statSync(full).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { path: full, mtime, id: codexRolloutId(full) };
      }
    }
  }
  return newest;
}

function codexRolloutCwd(path) {
  try {
    const first = readFileSync(path, "utf8").split("\n", 1)[0];
    return JSON.parse(first)?.payload?.cwd ?? null;
  } catch {
    return null;
  }
}

function codexRolloutId(path) {
  try {
    const first = readFileSync(path, "utf8").split("\n", 1)[0];
    const payload = JSON.parse(first)?.payload;
    return payload?.id ?? payload?.session_id ?? null;
  } catch {
    return null;
  }
}

// The last turn_context's model name (session_meta carries only provider).
function codexModel(path) {
  try {
    let model = null;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.includes('"model"')) continue;
      const value = safeJson(line);
      if (value?.type === "turn_context" && typeof value.payload?.model === "string") model = value.payload.model;
    }
    return model;
  } catch {
    return null;
  }
}

// Cumulative input tokens: the last token_count event's total_token_usage.
function codexTokens(path) {
  try {
    let n = null;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.includes("total_token_usage")) continue;
      const value = safeJson(line);
      const total = value?.payload?.info?.total_token_usage;
      if (value?.payload?.type === "token_count" && typeof total?.input_tokens === "number") n = total.input_tokens;
    }
    return n;
  } catch {
    return null;
  }
}

function safeJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function claudeTranscriptFor(cwd) {
  const proj = join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"));
  let newest = null;
  try {
    for (const name of readdirSync(proj)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(proj, name);
      const mtime = statSync(path).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { path, mtime };
    }
  } catch {
    newest = null;
  }
  return newest?.path ?? null;
}

// Current context size: the last assistant usage's input side (input + cache
// read + cache creation). The transcript has no cumulative field.
function claudeTokens(path) {
  let n = null;
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.includes('"usage"')) continue;
      const usage = usageOf(safeJson(line), 0);
      if (!usage) continue;
      n =
        (typeof usage.input_tokens === "number" ? usage.input_tokens : 0) +
        (typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0) +
        (typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0);
    }
  } catch {
    return null;
  }
  return n;
}

function usageOf(value, depth) {
  if (depth > 6 || value === null || typeof value !== "object") return null;
  if (!Array.isArray(value) && typeof value.input_tokens === "number") return value;
  for (const v of Object.values(value)) {
    if (v && typeof v === "object") {
      const found = usageOf(v, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function opencodeSessionId(cwd) {
  if (typeof cwd !== "string" || cwd.includes("\0")) return null;
  const db = join(homedir(), ".local/share/opencode/opencode.db");
  const query = `SELECT id FROM session WHERE directory = '${cwd.replace(/'/g, "''")}' AND time_archived IS NULL ORDER BY time_created DESC LIMIT 1`;
  const result = run("sqlite3", [db, query]);
  return result.ok ? result.stdout.trim() || null : null;
}

// Per-message input tokens of the last message: the current in-flight count.
function opencodeTokens(cwd) {
  const sid = opencodeSessionId(cwd);
  if (!sid) return null;
  const db = join(homedir(), ".local/share/opencode/opencode.db");
  const query = `SELECT json_extract(data, '$.tokens.input') FROM message WHERE session_id = '${sid.replace(/'/g, "''")}' ORDER BY time_created DESC LIMIT 1`;
  const result = run("sqlite3", [db, query]);
  if (!result.ok) return null;
  const n = Number(result.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

function readTokens(harness, cwd) {
  try {
    if (harness === "codex") {
      const rollout = codexRolloutFor(cwd);
      return rollout?.path ? codexTokens(rollout.path) : null;
    }
    if (harness === "claude") {
      const path = claudeTranscriptFor(cwd);
      return path ? claudeTokens(path) : null;
    }
    if (harness === "opencode") return opencodeTokens(cwd);
    return null;
  } catch {
    return null;
  }
}

function sleepSync(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function dispatch(args) {
  const to = args.to;
  const cwd = args.cwd;
  const cmd = args.cmd;
  if (!to || !cwd || !cmd) {
    console.log("usage: bus.ts dispatch --to <lane-id> --cwd <dir> --cmd <shell command> [--from <agent>] [--harness <default opencode>] [--tmux <session name>] [--socket <tmux -L socket>] [--body <text>] [--ref <path>] [--mail-dir <dir>] [--resolve-wait <seconds>]");
    return 1;
  }
  const harness = args.harness ?? "opencode";
  // Fallback reads the invoke string itself when the caller does not say.
  const model = args.model ?? cmd.match(/(?:^|\s)-m\s+(\S+)/)?.[1] ?? null;
  const mode = args.mode ?? (cmd.includes("--auto") ? "auto" : null);
  const tmux = args.tmux ?? to;
  const socket = args.socket ?? null;
  const body = args.body ?? cmd;
  const ref = args.ref ?? null;
  const resolveWait = Number(args["resolve-wait"] ?? 3);

  const message = MailStore.send({
    id: mintId(),
    from: args.from ?? "coordinator",
    to,
    from_timestamp: nowIso(),
    kind: "dispatch",
    body,
    reply_to: null,
    ref,
  });

  const create = run("tmux", [
    ...(socket ? ["-L", socket] : []),
    "new-session", "-d", "-s", tmux, "-c", cwd, cmd,
  ]);
  if (!create.ok) {
    console.log(`tmux new-session failed (${create.status}): ${create.stderr.trim()}`);
    return 1;
  }

  // Stamp the envelope id into the fresh session so cass can ack it: the id
  // greps out of the lane's transcript just like a hail (injectedLine).
  const stamp = injectedLine({
    ...message,
    body: "dispatched: " + message.body.split("\n")[0],
  });
  for (const argv of MailLeg.tmuxSendArgs({ tmux }, stamp, socket)) {
    const result = run("tmux", argv);
    if (!result.ok) {
      console.log(`tmux send-keys failed (${result.status}): ${result.stderr.trim()}`);
      return 1;
    }
  }

  const dir = mailDirOf(args);
  mergeRoute(dir, to, { harness, tmux, cwd, model, mode });

  append(join(dir, DEFAULT_BOX), message);
  console.log(`dispatched ${message.id} -> ${to} (tmux ${tmux})`);

  sleepSync(resolveWait);
  return resolve(args);
}

function resolve(args) {
  const to = args.to;
  if (!to) {
    console.log("usage: bus.ts resolve --to <lane-id> [--mail-dir <dir>]");
    return 1;
  }
  const dir = mailDirOf(args);
  const route = readRegistryRaw(dir)[to];
  const harness = route?.harness ?? null;
  const cwd = route?.cwd ?? null;
  if (harness !== "opencode" && harness !== "claude" && harness !== "codex") {
    console.log(`unresolved ${to}: harness ${harness ?? "none"} has no resolve leg`);
    return 1;
  }
  if (!cwd) {
    console.log(`unresolved ${to}: no cwd in registry route`);
    return 1;
  }
  if (harness === "claude") {
    // A claude lane's session is its transcript: newest jsonl in the project
    // dir wins, and sourcePath is what scopes the sweep's cass ack to it.
    const proj = join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"));
    let newest = null;
    try {
      for (const name of readdirSync(proj)) {
        if (!name.endsWith(".jsonl")) continue;
        const path = join(proj, name);
        const mtime = statSync(path).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { path, mtime, id: name.slice(0, -6) };
      }
    } catch {
      newest = null;
    }
    if (!newest) {
      console.log(`unresolved ${to}: no claude transcript under ${proj} yet`);
      return 2;
    }
    mergeRoute(dir, to, { ...route, sessionId: newest.id, sourcePath: newest.path });
    console.log(`resolved ${to} -> ${newest.id}`);
    return 0;
  }
  if (harness === "codex") {
    // A codex lane's session is its rollout, matched by the session_meta cwd
    // like the opencode leg's newest-non-archived rule. Model comes from the
    // rollout's own turn_context records, never from the dispatch args.
    const rollout = codexRolloutFor(cwd);
    if (!rollout || !rollout.id) {
      console.log(`unresolved ${to}: no codex rollout for ${cwd} yet`);
      return 2;
    }
    const model = codexModel(rollout.path) ?? route.model ?? null;
    mergeRoute(dir, to, { ...route, sessionId: rollout.id, model });
    console.log(`resolved ${to} -> ${rollout.id} (${model ?? "?"})`);
    return 0;
  }
  // NUL bytes cannot survive argv, so refuse them. A single quote is fine: the
  // sqlite3 CLI has no bind params, so a literal is escaped by doubling the
  // quote (SQL string-literal rule); a doubled quote is not escaped further.
  if (cwd.includes("\0")) {
    console.log(`unresolved ${to}: cwd contains a NUL byte, refusing`);
    return 1;
  }
  const sessionId = opencodeSessionId(cwd);
  if (!sessionId) {
    console.log(`unresolved ${to}: no opencode session for ${cwd} yet`);
    return 2;
  }
  mergeRoute(dir, to, { ...route, sessionId });
  console.log(`resolved ${to} -> ${sessionId}`);
  return 0;
}

function hail(args) {
  const to = args.to;
  if (!to || !args.body) {
    console.log("usage: bus.ts hail --to <agent> --body <text> [--from <agent>] [--kind request|result|note]");
    return 1;
  }
  const dir = mailDirOf(args);
  const directory = readDirectory(dir);
  const agent = MailDirectory.agent(directory, to);
  const message = MailStore.send({
    id: args.id ?? mintId(),
    from: args.from ?? "coordinator",
    to,
    from_timestamp: nowIso(),
    kind: args.kind ?? "request",
    body: args.body,
    reply_to: args["reply-to"] ?? null,
    ref: args.ref ?? null,
  });
  append(join(dir, args.box ?? DEFAULT_BOX), message);
  console.log(`queued ${message.id} -> ${to}`);

  if (!agent) {
    console.log(`no registry route for ${to}: message stays queued, to_timestamp null`);
    return 2;
  }
  const legs = MailLeg.tmuxSendArgs(agent, injectedLine(message), args.socket ?? null);
  if (!legs) {
    console.log(`${to} has no tmux pane: message stays queued, to_timestamp null`);
    return 2;
  }
  for (const argv of legs) {
    const result = run("tmux", argv);
    if (!result.ok) {
      console.log(`tmux send-keys failed (${result.status}): ${result.stderr.trim()}`);
      return 2;
    }
  }
  console.log(`injected into tmux ${agent.tmux}`);
  return 0;
}

function sweep(args) {
  const dir = mailDirOf(args);
  const directory = readDirectory(dir);
  const boxes = readBoxes(dir);
  // Stamp current token usage into every live route from the session's own
  // artifact. A live set is required to call a route live; a route whose
  // artifact cannot be read keeps the field absent (no guess, never an error).
  const live = liveSessions();
  if (live !== null) {
    casUpdateJson(join(dir, "registry.json"), (registry) => {
      for (const id of Object.keys(registry)) {
        const route = registry[id];
        if (typeof route !== "object" || route === null) continue;
        const r = route;
        if (typeof r.harness !== "string" || typeof r.cwd !== "string") continue;
        if (typeof r.tmux !== "string" || !live.has(r.tmux)) continue;
        const inTokens = readTokens(r.harness, r.cwd);
        if (inTokens === null) continue;
        registry[id] = { ...r, tokens: { in: inTokens, at: nowIso() } };
      }
      return registry;
    });
  }
  const maxAgeDays = Number(args["max-age-days"] ?? 7);
  const cutoff = Date.now() - maxAgeDays * 86400_000;
  const pending = MailStore.unacked(allMessages(boxes));
  if (!pending.length) {
    console.log("nothing unacked");
    return 0;
  }
  let acked = 0;
  let expired = 0;
  const close = (message) => {
    const box = boxes.find((entry) => entry.messages.some((row) => row.id === message.id));
    append(box?.path ?? join(dir, args.box ?? DEFAULT_BOX), MailStore.ack(message, nowIso()));
    expired += 1;
  };
  for (const message of pending) {
    if (args.agent && message.to !== args.agent) continue;
    // Past the cutoff the lane will never ack; the ack row closes it for good
    // instead of the old print-and-refold-next-sweep behavior.
    if (new Date(message.from_timestamp).getTime() < cutoff) {
      close(message);
      console.log(`expired ${message.id}`);
      continue;
    }
    const agent = MailDirectory.agent(directory, message.to);
    if (!agent) {
      if (args["close-routeless"]) {
        close(message);
        console.log(`expired ${message.id} -> ${message.to}: no registry route`);
      } else {
        console.log(`${message.id} -> ${message.to}: no registry route, cannot scope the cass query (--close-routeless expires these)`);
      }
      continue;
    }
    const search = run("cass", MailLeg.cassSearchArgs(message));
    if (!search.ok) {
      console.log(`${message.id}: cass search failed (${search.status}) ${search.stderr.trim()}`);
      continue;
    }
    const hits = MailLeg.cassHits(agent, search.stdout);
    if (!hits.length) {
      console.log(`${message.id} -> ${message.to}: no transcript hit, still unacked`);
      continue;
    }
    // to_timestamp = when cass proved the read. A hit carries its conversation's
    // created_at, not the message's, so it would sort before from_timestamp.
    const box = boxes.find((entry) => entry.messages.some((row) => row.id === message.id));
    append(box?.path ?? join(dir, args.box ?? DEFAULT_BOX), MailStore.ack(message, nowIso()));
    acked += 1;
    console.log(`${message.id} -> ${message.to}: acked via ${hits[0].source_path}`);
  }
  console.log(`swept ${pending.length} unacked, acked ${acked}, expired ${expired}`);
  return 0;
}

function list(args) {
  const dir = mailDirOf(args);
  const messages = allMessages(readBoxes(dir));
  if (!args.agent) {
    const registry = readRegistryRaw(dir);
    const live = liveSessions();
    for (const [name, route] of Object.entries(registry)) {
      const state = live === null ? "?" : live.has(route.tmux) ? "live" : "dead";
      console.log([
        state.padEnd(4),
        name.padEnd(16),
        (route.harness ?? "-").padEnd(10),
        (route.mode ?? "-").padEnd(6),
        (route.model ?? "-").padEnd(46),
        (route.tmux ?? "-").padEnd(16),
        route.cwd ?? "-",
      ].join(" "));
    }
    const rows = args.all ? MailStore.fold(messages) : MailStore.unacked(messages);
    for (const message of rows) console.log(MailStore.line(message));
    if (!args.all) console.log(`${rows.length} open (closed history: --all)`);
    return 0;
  }
  const inbox = MailStore.inbox(messages, args.agent);
  const outbox = MailStore.outbox(messages, args.agent);
  for (const message of inbox) console.log("in  " + MailStore.line(message));
  for (const message of outbox) console.log("out " + MailStore.line(message));
  console.log(`${args.agent}: ${inbox.length} in, ${outbox.length} out, ` +
    `${MailStore.unacked([...inbox, ...outbox]).length} unacked`);
  return 0;
}

function lane(args) {
  const to = args.name;
  const cwd = args.cwd;
  if (!to || !cwd) {
    console.log("usage: bus.ts lane --cwd <dir> --name <lane-id> [--brief <path>] [--model <id>] [--tmux <name>] [--parent <agent>] [--mail-dir <dir>] [--resolve-wait <seconds>] [--dry-run]");
    return 1;
  }
  const brief = args.brief ?? join(cwd, "brief.md");
  if (!existsSync(brief)) {
    console.log(`brief file not found: ${brief}`);
    return 1;
  }
  const body = readFileSync(brief, "utf8").split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
  const model = args.model ?? "openrouter/deepseek/deepseek-v4-flash-0731";
  const tmux = args.tmux ?? to;
  let cmd = `opencode run -m ${model} --auto "$(cat ${brief})"`;

  if (args.parent) {
    // The wrapped cmd appends a completion hail, never replaces the original
    // opencode cmd. The body is double-quoted so shell expands $__rc and $(pwd)
    // at run time; the trailing `exit $__rc` re-raises the lane's own status.
    const bus = resolvePath(process.argv[1]);
    const hail = `node ${bus} hail --to ${args.parent} --from ${to} --kind result --body "lane ${to} done rc=$__rc cwd=$(pwd)"`;
    cmd = `${cmd}; __rc=$?; ${hail}; exit $__rc`;
  }

  if (args["dry-run"]) {
    console.log(`cmd: ${cmd}`);
    console.log(`to: ${to}`);
    console.log(`cwd: ${cwd}`);
    console.log(`harness: opencode`);
    console.log(`tmux: ${tmux}`);
    console.log(`body: ${body}`);
    console.log(`mail-dir: ${args["mail-dir"] ?? DEFAULT_MAIL_DIR}`);
    console.log(`resolve-wait: ${args["resolve-wait"] ?? 3}`);
    return 0;
  }

  const dispatchArgs = { to, cwd, cmd, harness: "opencode", tmux, body, model, mode: "auto" };
  if (args["mail-dir"]) dispatchArgs["mail-dir"] = args["mail-dir"];
  if (args["resolve-wait"]) dispatchArgs["resolve-wait"] = args["resolve-wait"];
  return dispatch(dispatchArgs);
}

function adopt(args) {
  const name = args.name;
  const tmux = args.tmux;
  if (!name || !tmux) {
    console.log("usage: bus.ts adopt --name <agent> --tmux <session> --harness <h> [--cwd <dir>] [--model <id>] [--mode <m>] [--mail-dir <dir>]");
    return 1;
  }
  // The route is only writable for a session that actually exists right now;
  // a stale name would make bus hail inject into a dead pane.
  const check = run("tmux", ["has-session", "-t", tmux]);
  if (!check.ok) {
    console.log(`refusing adopt ${name}: no such tmux session ${tmux} (${check.status})`);
    return 1;
  }
  const dir = mailDirOf(args);
  mergeRoute(dir, name, {
    harness: args.harness ?? null,
    tmux,
    cwd: args.cwd ?? null,
    model: args.model ?? null,
    mode: args.mode ?? null,
  });
  console.log(`adopted ${name} -> tmux ${tmux}`);
  return 0;
}

function prune(args) {
  const dir = mailDirOf(args);
  const live = liveSessions();
  if (live === null) {
    console.log("refusing prune: tmux unreachable, cannot tell live from dead");
    return 1;
  }
  const registry = readRegistryRaw(dir);
  const dead = Object.keys(registry).filter((name) => !live.has(registry[name]?.tmux));
  casUpdateJson(join(dir, "registry.json"), (current) => {
    for (const name of Object.keys(current)) {
      if (!live.has(current[name]?.tmux)) delete current[name];
    }
    return current;
  });
  console.log(`pruned ${dead.length} dead routes${dead.length ? ": " + dead.join(" ") : ""}`);
  return 0;
}

const [command, ...rest] = process.argv.slice(2);
const args = flags(rest);
const commands = { hail, sweep, list, dispatch, resolve, lane, adopt, prune };
if (!command || !(command in commands)) {
  console.log("usage: bus.ts <hail|sweep|list|dispatch|resolve|lane|adopt|prune> [--mail-dir <path>] ...");
  process.exit(1);
}
try {
  process.exit(commands[command](args));
} catch (error) {
  if (error instanceof CorruptJsonError) {
    console.log(error.message);
    process.exit(1);
  }
  throw error;
}
