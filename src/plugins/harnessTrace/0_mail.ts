// Pure mail-ledger parsing + session join: no fs, no invoke, so vitest covers
// it directly (the panel reads the files through list_dir/read_text).
// The parse itself now yields ruled envelopes (0_bus.ts, 2026-08-03 bus
// ruling); parseMailNdjson projects them back to the pre-ruling MailEnvelope
// shape the trace panel's join reads, with ts = from_timestamp.
import { MailDirectory, MailStore } from "./0_bus";
import type {
  AgentSessionNode,
  HarnessTraceRow,
  HarnessTraceSeed,
  IMailDirectory,
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

// Seeds for the registry routes the harness stores cannot see: a dispatched
// lane with no store (harness "shell", or an unresolved opencode lane whose
// sessionId is still empty) exists only in registry.json, so without a
// synthesized seed it never becomes a row anywhere. The agent id doubles as
// the session id when none is resolved, which is also what the envelope join
// falls back to, so from/why still attach. Store-backed sessions are the
// store's to report; any agent whose sessionId a real seed already carries is
// skipped.
export function registrySeeds(
  directory: IMailDirectory,
  seeds: HarnessTraceSeed[],
  liveTmux: Set<string>,
): HarnessTraceSeed[] {
  const seeded = new Set(seeds.map((seed) => seed.sessionId));
  return Object.values(directory)
    .filter((agent) => !agent.sessionId || !seeded.has(agent.sessionId))
    .map((agent) => {
      const sessionId = agent.sessionId || agent.id;
      return {
        id: sessionId,
        harness: agent.harness ?? "shell",
        sessionId,
        parentId: null,
        parentKind: null,
        ts: "",
        lastActivity: "",
        status: agent.tmux !== null && liveTmux.has(agent.tmux) ? ("live" as const) : ("done" as const),
        cwd: agent.cwd ?? "",
      };
    });
}

// session id -> tmux session name, from the registry routes that carry one.
// The cwd guess (2_join) cannot tell apart tmux sessions sharing a directory;
// a route's recorded tmux name is the dispatcher's own statement and wins.
export function routeTmuxBySession(directory: IMailDirectory): Map<string, string> {
  const bySession = new Map<string, string>();
  for (const agent of Object.values(directory)) {
    if (agent.tmux !== null) bySession.set(agent.sessionId || agent.id, agent.tmux);
  }
  return bySession;
}

// The tmux names in a list_sessions answer, or null when the host has no real
// list to give (an e2e page's stub resolves undefined). null means "I learned
// nothing", which is NOT the same as an empty list: the caller keeps whatever
// liveness it already had instead of grading every routed lane done.
export function tmuxLiveNames(sessions: unknown): string[] | null {
  if (!Array.isArray(sessions)) return null;
  return sessions
    .map((session) => (session as { name?: unknown } | null)?.name)
    .filter((name): name is string => typeof name === "string");
}

// A dispatched lane lives inside its registry-recorded tmux session, so that
// session vanishing means the lane is done NOW; without this the store's
// mtime decay keeps a finished lane "idle" for an hour.
export function settleRoutedStatus(
  nodes: AgentSessionNode[],
  routeTmux: Map<string, string>,
  liveTmux: Set<string>,
): AgentSessionNode[] {
  return nodes.map((node) => {
    const tmux = routeTmux.get(node.id);
    if (tmux === undefined || liveTmux.has(tmux)) return node;
    return node.status === "dead" ? node : { ...node, status: "done" };
  });
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
