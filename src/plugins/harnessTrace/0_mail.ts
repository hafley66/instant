// Pure mail-ledger parsing + session join: no fs, no invoke, so vitest covers
// it directly (the panel reads the files through list_dir/read_text).
// The parse itself now yields ruled envelopes (0_bus.ts, 2026-08-03 bus
// ruling); parseMailNdjson projects them back to the pre-ruling MailEnvelope
// shape the trace panel's join reads, with ts = from_timestamp.
import { MailDirectory, MailStore } from "./0_bus";
import type {
  HarnessTraceRow,
  HarnessTraceSeed,
  IMailMessage,
  MailEnvelope,
  MailRegistry,
} from "./0_types";

export function parseMailLog(text: string): IMailMessage[] {
  return MailStore.parse(text);
}

function legacyView(message: IMailMessage): MailEnvelope {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    ts: message.from_timestamp,
    kind: message.kind,
    reply_to: message.reply_to ?? undefined,
    body: message.body || undefined,
    ref: message.ref ?? undefined,
  };
}

export function parseMailNdjson(text: string): MailEnvelope[] {
  return parseMailLog(text).map(legacyView);
}

export function parseMailRegistry(text: string): MailRegistry {
  const registry: MailRegistry = {};
  for (const [id, agent] of Object.entries(MailDirectory.parse(text))) {
    if (agent.sessionId) registry[id] = agent.sessionId;
  }
  return registry;
}

// Reverse of the registry join: a trace row knows its session id, the mailbox
// addresses the agent name, so a row action opening a queue resolves through
// here. No registry entry = the session id is its own address.
export function mailAgentIdFor(registry: MailRegistry, sessionId: string): string {
  return Object.entries(registry).find(([, id]) => id === sessionId)?.[0] ?? sessionId;
}

// Join envelopes to sessions: `to` resolves through the registry when present,
// else matches a session id directly. The oldest matching envelope is the
// dispatch record; it supplies from/why (body first line) and the row id.
export function enrichRows(
  seeds: HarnessTraceSeed[],
  envelopes: MailEnvelope[],
  registry: MailRegistry,
): HarnessTraceRow[] {
  const dispatchBySession = new Map<string, MailEnvelope>();
  const oldestFirst = [...envelopes].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const envelope of oldestFirst) {
    const sessionId = registry[envelope.to] ?? envelope.to;
    if (!dispatchBySession.has(sessionId)) dispatchBySession.set(sessionId, envelope);
  }
  return seeds.map((seed) => {
    const dispatch = dispatchBySession.get(seed.sessionId);
    if (!dispatch) return { ...seed, from: "user", why: "" };
    return {
      ...seed,
      id: dispatch.id,
      from: dispatch.from || "user",
      why: (dispatch.body ?? "").split("\n")[0] ?? "",
    };
  });
}
