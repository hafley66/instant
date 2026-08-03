// Message-bus edge CLI (2026-08-03 bus ruling): the queue is an NDJSON file on
// the OS filesystem, tmux is the injection transport, cass is the ack reader.
// Every decision lives in the pure modules this shells around
// (src/plugins/harnessTrace/0_bus.ts, 1_leg.ts); here there is only fs and
// spawn. Run with node's type stripping:
//   node scripts/bus.ts hail --to <agent> --body "..."
//   node scripts/bus.ts sweep
//   node scripts/bus.ts list --agent <agent>
// Exit codes: 0 ok, 1 usage/route error, 2 appended but not injected.
import { existsSync, appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MailDirectory, MailStore } from "../src/plugins/harnessTrace/0_bus.ts";
import { MailLeg, injectedLine } from "../src/plugins/harnessTrace/1_leg.ts";

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
  const pending = MailStore.unacked(allMessages(boxes));
  if (!pending.length) {
    console.log("nothing unacked");
    return 0;
  }
  let acked = 0;
  for (const message of pending) {
    if (args.agent && message.to !== args.agent) continue;
    const agent = MailDirectory.agent(directory, message.to);
    if (!agent) {
      console.log(`${message.id} -> ${message.to}: no registry route, cannot scope the cass query`);
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
  console.log(`swept ${pending.length} unacked, acked ${acked}`);
  return 0;
}

function list(args) {
  const dir = mailDirOf(args);
  const messages = allMessages(readBoxes(dir));
  if (!args.agent) {
    for (const message of MailStore.fold(messages)) console.log(MailStore.line(message));
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

const [command, ...rest] = process.argv.slice(2);
const args = flags(rest);
const commands = { hail, sweep, list };
if (!command || !(command in commands)) {
  console.log("usage: bus.ts <hail|sweep|list> [--mail-dir <path>] ...");
  process.exit(1);
}
process.exit(commands[command](args));
