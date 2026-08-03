// Frozen CONTRACT2 state model plus the seam types shared by the two panels of
// the harness-trace plugin (the flat trace panel and the dock strip tree).
export type Harness = "claude" | "opencode" | "codex" | "kimi";
export type ParentKind = "subagent" | "dispatch";
export type SessionStatus = "live" | "idle" | "done" | "dead";

// Frozen CONTRACT2 row model: what the dock strip renders as a tree.
// parentId points at the session that caused this one (null = top-level);
// parentKind says how: "subagent" (claude nested store, from rust) or
// "dispatch" (cross-harness, attached on the frontend from the mail ledger).
export interface AgentSessionNode {
  id: string;                 // session id
  harness: Harness;
  parentId: string | null;
  parentKind: ParentKind | null;
  from: string;               // dispatcher agent name ("user" when none)
  why: string;                // envelope body first line ("" when none)
  ts: string;                 // start time, ISO
  lastActivity: string;       // ISO, from session store mtime/db
  status: SessionStatus;
  cwd: string;                // tildified, display-ready
  // The instant tmux session this agent runs in, joined by cwd/chip-path match
  // against the store's tmux rows (null = none; row is dimmed, click is a no-op).
  tmuxSession: string | null;
}

// The flat trace panel's row: the frozen model plus the display session id
// (the harness-trace panel keys on it; the strip dedupes on AgentSessionNode.id).
export interface HarnessTraceRow {
  id: string; // session id (or dispatch envelope id when known)
  harness: Harness;
  sessionId: string;
  parentId: string | null;
  parentKind: ParentKind | null;
  from: string; // who dispatched it ("user" when unknown)
  why: string; // dispatch reason / brief first line ("" when unknown)
  ts: string;
  lastActivity: string;
  status: SessionStatus;
  cwd: string;
}

// The rust command harness_trace_rows returns HarnessTraceRow minus from/why;
// the mail-ledger join (0_mail.ts) fills those two in. parentId/parentKind ride
// the seam from rust (subagent children); "dispatch" is attached later.
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

// registry.json beside the mail files: envelope name -> session id.
export type MailRegistry = Record<string, string>;

// Per-tab internal router view (CONTRACT3). One kind today (agent-session); the
// union exists so more kinds (a file, a diff) can join later with no call-site
// churn.
export type TermView = {
  kind: "agent-session";
  agentSessionId: string;
};

// Per-terminal stack of views. A terminal's in-tab strip pushes when a row is
// clicked and pops on the back button; the top is what the tab is "viewing".
export interface ITermRouter {
  // Push a view onto a terminal's stack.
  push(sid: string, view: TermView): void;
  // Pop the top view off a terminal's stack; null when the stack is empty.
  back(sid: string): TermView | null;
  // The top of a terminal's stack (the view being shown); null when empty.
  current(sid: string): TermView | null;
  // Whether a terminal's stack has anything to pop.
  canGoBack(sid: string): boolean;
  // React subscription: fires after any push/back mutates a stack.
  subscribe(listener: () => void): () => void;
}
