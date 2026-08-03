// Pure mail-ledger parsing + session join: no fs, no invoke, so vitest covers
// it directly (the panel reads the files through list_dir/read_text).
import type { HarnessTraceRow, HarnessTraceSeed, MailEnvelope, MailRegistry } from "./0_types";

export function parseMailNdjson(text: string): MailEnvelope[] {
  const out: MailEnvelope[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue; // malformed line: skip it, keep the rest
    }
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.to !== "string") continue;
    out.push({
      id: record.id,
      from: typeof record.from === "string" ? record.from : "",
      to: record.to,
      ts: typeof record.ts === "string" ? record.ts : "",
      kind: typeof record.kind === "string" ? record.kind : "",
      reply_to: typeof record.reply_to === "string" ? record.reply_to : undefined,
      body: typeof record.body === "string" ? record.body : undefined,
      ref: typeof record.ref === "string" ? record.ref : undefined,
    });
  }
  return out;
}

export function parseMailRegistry(text: string): MailRegistry {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const registry: MailRegistry = {};
  for (const [name, sessionId] of Object.entries(value)) {
    if (typeof sessionId === "string") registry[name] = sessionId;
  }
  return registry;
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
