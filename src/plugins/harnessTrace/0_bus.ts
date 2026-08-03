// Pure message-bus store over the mailbox NDJSON log (2026-08-03 bus ruling).
// The file is the log: a send appends a row, an ack appends the same envelope
// again with to_timestamp filled. No fs, no invoke, no clock here — the caller
// passes ids and timestamps in, so vitest covers the whole fold directly.
import type {
  Harness,
  IMailDirectory,
  IMailDirectoryReader,
  IMailMessage,
  IMailStore,
} from "./0_types";

const HARNESSES: Harness[] = ["claude", "opencode", "codex", "kimi"];

function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function harnessOf(value: string | null): Harness | null {
  return HARNESSES.find((h) => h === value) ?? null;
}

// A row's own timestamp for ordering. `ts` is the pre-ruling field name.
function sentAt(row: Record<string, unknown>): string {
  return str(row, "from_timestamp") ?? str(row, "ts") ?? "";
}

function byFromTimestamp(a: IMailMessage, b: IMailMessage): number {
  return a.from_timestamp.localeCompare(b.from_timestamp);
}

export const MailStore: IMailStore = {
  parse(text) {
    const out: IMailMessage[] = [];
    for (const rawLine of text.split("\n")) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        continue; // malformed line: skip it, keep the rest
      }
      const row = record(value);
      if (!row) continue;
      const id = str(row, "id");
      const to = str(row, "to");
      if (!id || !to) continue;
      out.push({
        id,
        from: str(row, "from") ?? "",
        to,
        from_timestamp: sentAt(row),
        to_timestamp: str(row, "to_timestamp"),
        kind: str(row, "kind") ?? "note",
        reply_to: str(row, "reply_to"),
        body: str(row, "body") ?? "",
        ref: str(row, "ref"),
      });
    }
    return out;
  },

  line(message) {
    return JSON.stringify({
      id: message.id,
      from: message.from,
      to: message.to,
      from_timestamp: message.from_timestamp,
      to_timestamp: message.to_timestamp,
      kind: message.kind,
      reply_to: message.reply_to,
      body: message.body,
      ref: message.ref,
    });
  },

  fold(rows) {
    const latest = new Map<string, IMailMessage>();
    for (const row of rows) {
      const prior = latest.get(row.id);
      // An ack is a fact about the recipient's transcript, so it survives a
      // later at-least-once resend of the same envelope.
      latest.set(row.id, { ...row, to_timestamp: prior?.to_timestamp ?? row.to_timestamp });
    }
    return [...latest.values()];
  },

  inbox(rows, agentId) {
    return MailStore.fold(rows)
      .filter((row) => row.to === agentId)
      .sort(byFromTimestamp);
  },

  outbox(rows, agentId) {
    return MailStore.fold(rows)
      .filter((row) => row.from === agentId)
      .sort(byFromTimestamp);
  },

  unacked(rows) {
    return MailStore.fold(rows).filter((row) => row.to_timestamp === null);
  },

  thread(rows, id) {
    const folded = MailStore.fold(rows);
    const root = rootOf(folded, id);
    if (root === null) return [];
    return folded.filter((row) => rootOf(folded, row.id) === root).sort(byFromTimestamp);
  },

  replyDepth(rows, id) {
    const byId = index(MailStore.fold(rows));
    let depth = 0;
    let cursor = byId.get(id);
    const seen = new Set<string>();
    while (cursor?.reply_to && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const parent = byId.get(cursor.reply_to);
      if (!parent) break;
      depth += 1;
      cursor = parent;
    }
    return depth;
  },

  queue(rows, agentId) {
    const inbox = MailStore.inbox(rows, agentId);
    const outbox = MailStore.outbox(rows, agentId);
    return [
      ...inbox.map((message) => ({ message, direction: "in" as const, depth: 0 })),
      ...outbox.map((message) => ({ message, direction: "out" as const, depth: 0 })),
    ]
      .sort((a, b) => byFromTimestamp(a.message, b.message))
      .map((row) => ({ ...row, depth: MailStore.replyDepth(rows, row.message.id) }));
  },

  send(input) {
    return {
      id: input.id,
      from: input.from,
      to: input.to,
      from_timestamp: input.from_timestamp,
      to_timestamp: null,
      kind: input.kind,
      reply_to: input.reply_to ?? null,
      body: input.body,
      ref: input.ref ?? null,
    };
  },

  ack(message, toTimestamp) {
    return { ...message, to_timestamp: toTimestamp };
  },
};

function index(rows: IMailMessage[]): Map<string, IMailMessage> {
  return new Map(rows.map((row) => [row.id, row]));
}

// Walk reply_to up to the thread root. A reply_to pointing at a row this log
// does not hold roots on the last row reached.
function rootOf(rows: IMailMessage[], id: string): string | null {
  const byId = index(rows);
  let cursor = byId.get(id);
  if (!cursor) return null;
  const seen = new Set<string>();
  while (cursor.reply_to) {
    // A cycle has no root, so its smallest id stands in: every row in the cycle
    // then groups into one thread whichever row the walk entered from.
    if (seen.has(cursor.id)) return [...seen].sort()[0];
    seen.add(cursor.id);
    const parent = byId.get(cursor.reply_to);
    if (!parent) break;
    cursor = parent;
  }
  return cursor.id;
}

export const MailDirectory: IMailDirectoryReader = {
  parse(text) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return {};
    }
    const rows = record(value);
    if (!rows) return {};
    const directory: IMailDirectory = {};
    for (const [id, entry] of Object.entries(rows)) {
      if (typeof entry === "string") {
        directory[id] = { id, sessionId: entry, harness: null, tmux: null, sourcePath: null };
        continue;
      }
      const fields = record(entry);
      if (!fields) continue; // "version": 1 and friends are not routes
      const sessionId = str(fields, "sessionId") ?? str(fields, "session_id") ?? "";
      directory[id] = {
        id,
        sessionId,
        harness: harnessOf(str(fields, "harness")),
        tmux: str(fields, "tmux"),
        sourcePath: str(fields, "sourcePath") ?? str(fields, "source_path"),
      };
    }
    return directory;
  },

  agent(directory, agentId) {
    return directory[agentId] ?? null;
  },
};
