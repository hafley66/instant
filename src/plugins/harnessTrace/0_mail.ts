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

// One agent, one row (m-17f56e54): a route with no resolved sessionId still
// names a real session when a store seed shares its harness and cwd.
export function resolveRouteSessions(
  directory: IMailDirectory,
  seeds: HarnessTraceSeed[],
  homeDir: string,
): MailRegistry {
  const untildify = (path: string) => (path.startsWith("~") ? homeDir + path.slice(1) : path);
  const resolved: MailRegistry = {};
  for (const [id, agent] of Object.entries(directory)) {
    if (agent.sessionId) {
      resolved[id] = agent.sessionId;
      continue;
    }
    if (agent.harness === null || agent.cwd === null) continue;
    const match = seeds
      .filter((seed) => seed.harness === agent.harness && untildify(seed.cwd) === untildify(agent.cwd!))
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity))[0];
    if (match) resolved[id] = match.sessionId;
  }
  return resolved;
}

// Seeds for the registry routes the harness stores cannot see: a dispatched
// lane with no store (harness "shell", or an unresolved opencode lane whose
// sessionId is still empty) exists only in registry.json, so without a
// synthesized seed it never becomes a row anywhere. The agent id doubles as
// the session id when none is resolved, which is also what the envelope join
// falls back to, so from/why still attach. Store-backed sessions are the
// store's to report; any agent whose sessionId a real seed already carries is
// skipped.
const SEED_LIVE_MS = 2 * 60 * 1000;

export function registrySeeds(
  directory: IMailDirectory,
  seeds: HarnessTraceSeed[],
  liveTmux: Set<string>,
  envelopes: MailEnvelope[],
  nowMs: number,
  resolved: MailRegistry = {},
): HarnessTraceSeed[] {
  const seeded = new Set(seeds.map((seed) => seed.sessionId));
  const lastMailMs = new Map<string, number>();
  for (const envelope of envelopes) {
    const ms = Date.parse(envelope.ts) || 0;
    for (const agentId of [envelope.to, envelope.from]) {
      if (ms > (lastMailMs.get(agentId) ?? 0)) lastMailMs.set(agentId, ms);
    }
  }
  // The oldest envelope whose `from` names a registered agent is the lane's
  // dispatch edge; placeholder froms ("coordinator", "user") cannot parent.
  const dispatchFrom = new Map<string, string>();
  for (const envelope of [...envelopes].sort((a, b) => a.ts.localeCompare(b.ts))) {
    if (envelope.kind !== "dispatch") continue;
    if (!dispatchFrom.has(envelope.to) && directory[envelope.from]) {
      dispatchFrom.set(envelope.to, envelope.from);
    }
  }
  return Object.values(directory)
    .filter((agent) => {
      const sessionId = agent.sessionId || resolved[agent.id] || "";
      return !sessionId || !seeded.has(sessionId);
    })
    .map((agent) => {
      const sessionId = agent.sessionId || agent.id;
      const mailMs = lastMailMs.get(agent.id) ?? 0;
      const alive = agent.tmux !== null && liveTmux.has(agent.tmux);
      // Registry-only lanes have no store mtime, so mail traffic is the only
      // activity signal: live decays to idle, never done while the tmux lives.
      const status = !alive ? "done" : nowMs - mailMs <= SEED_LIVE_MS ? "live" : "idle";
      const dispatcher = directory[dispatchFrom.get(agent.id) ?? ""];
      const parentId = dispatcher
        ? dispatcher.sessionId || resolved[dispatcher.id] || dispatcher.id
        : null;
      return {
        id: sessionId,
        harness: agent.harness ?? "shell",
        sessionId,
        parentId,
        parentKind: parentId === null ? null : ("dispatch" as const),
        ts: "",
        lastActivity: mailMs ? new Date(mailMs).toISOString() : "",
        status: status as HarnessTraceSeed["status"],
        cwd: agent.cwd ?? "",
        tokens: agent.tokens ?? null,
      };
    });
}

// session id -> tmux session name, from the registry routes that carry one.
// The cwd guess (2_join) cannot tell apart tmux sessions sharing a directory;
// a route's recorded tmux name is the dispatcher's own statement and wins.
export function routeTmuxBySession(
  directory: IMailDirectory,
  resolved: MailRegistry = {},
): Map<string, string> {
  const bySession = new Map<string, string>();
  for (const agent of Object.values(directory)) {
    if (agent.tmux !== null) bySession.set(agent.sessionId || resolved[agent.id] || agent.id, agent.tmux);
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
    if (envelope.kind !== "dispatch") continue;
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
