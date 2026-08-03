// Frozen row model from the harness-trace contract. The rust command
// harness_trace_rows returns HarnessTraceSeed (the row minus from/why); the
// mail-ledger join (0_mail.ts) fills those two in.
export interface HarnessTraceRow {
  id: string; // session id (or dispatch envelope id when known)
  harness: "claude" | "opencode" | "codex" | "kimi";
  sessionId: string;
  from: string; // who dispatched it ("user" when unknown)
  why: string; // dispatch reason / brief first line ("" when unknown)
  ts: string; // start time, ISO
  lastActivity: string; // ISO, from session store mtime/db
  status: "live" | "idle" | "done" | "dead";
  cwd: string; // tildified, display-ready
}

export type HarnessTraceSeed = Omit<HarnessTraceRow, "from" | "why">;

// One dispatch-bus envelope (~/.agent/mail/*.ndjson). The bus is designed, not
// built yet, so every field is validated on the wire.
export interface MailEnvelope {
  id: string;
  from: string;
  to: string;
  ts: string;
  kind: string;
  reply_to?: string;
  body?: string;
  ref?: string;
}

// registry.json beside the mail files: envelope `to` name -> session id.
export type MailRegistry = Record<string, string>;
