import type { CassSwarmRow, CassSwarmStatus } from "./0_types";

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(", ");
  return JSON.stringify(value);
}

function field(row: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = text(row[name]);
    if (value) return value;
  }
  return "";
}

function detail(row: Record<string, unknown>, omitted: string[]): string {
  return Object.entries(row)
    .filter(([key, value]) => !omitted.includes(key) && text(value))
    .map(([key, value]) => `${key}=${text(value)}`)
    .join(" · ");
}

function records(kind: CassSwarmRow["kind"], status: string, input: Record<string, unknown>[]): CassSwarmRow[] {
  return input.map((row, index) => {
    const title = field(row, ["title", "name", "agent", "agent_id", "id", "bead_id", "task_id"]) || `${kind} ${index + 1}`;
    const rowStatus = field(row, ["status", "state", "phase"]) || status;
    return {
      id: `${kind}:${title}:${index}`,
      kind,
      status: rowStatus,
      title,
      detail: detail(row, ["title", "name", "agent", "agent_id", "id", "bead_id", "task_id", "status", "state", "phase"]),
    };
  });
}

function agentChildren(agent: Record<string, unknown>, agentId: string): CassSwarmRow[] {
  const groups: Array<{ key: "messages" | "calls"; kind: "message" | "call"; fallback: string }> = [
    { key: "messages", kind: "message", fallback: "message" },
    { key: "calls", kind: "call", fallback: "call" },
  ];
  return groups.flatMap(({ key, kind, fallback }) => {
    const records = Array.isArray(agent[key]) ? agent[key].filter((value): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)) : [];
    return records.map((record, index) => {
      const title = field(record, kind === "message"
        ? ["summary", "text", "content", "subject", "id"]
        : ["tool", "command", "name", "summary", "id"]) || `${fallback} ${index + 1}`;
      const rowStatus = field(record, ["status", "state", "role", "phase"]) || fallback;
      return {
        id: `${agentId}:${kind}:${index}`,
        kind,
        status: rowStatus,
        title,
        detail: detail(record, ["summary", "text", "content", "subject", "tool", "command", "name", "id", "status", "state", "role", "phase"]),
      };
    });
  });
}

function agentRows(agents: Record<string, unknown>[]): CassSwarmRow[] {
  return agents.map((agent, index) => {
    const title = field(agent, ["agent", "agent_id", "name", "id"]) || `agent ${index + 1}`;
    const children = agentChildren(agent, title);
    return {
      id: `agent:${title}:${index}`,
      kind: "agent",
      status: field(agent, ["status", "state", "phase"]) || "unknown",
      title,
      detail: detail(agent, ["agent", "agent_id", "name", "id", "status", "state", "phase", "messages", "calls"]),
      ...(children.length ? { children } : {}),
    };
  });
}

export function swarmRows(snapshot: CassSwarmStatus, kind: CassSwarmRow["kind"]): CassSwarmRow[] {
  if (kind === "provider") {
    return (snapshot.providers ?? []).map((provider) => ({
      id: `provider:${provider.name}`,
      kind,
      status: provider.status ?? "unknown",
      title: provider.name,
      detail: [provider.source, provider.error_kind, provider.warning].filter(Boolean).join(" · "),
    }));
  }
  if (kind === "agent") return agentRows(snapshot.agents ?? []);
  if (kind === "reservation") return records(kind, "unknown", snapshot.reservations ?? []);
  const beads = snapshot.beads ?? {};
  return [
    ...records(kind, "ready", beads.ready ?? []),
    ...records(kind, "in progress", beads.in_progress ?? []),
    ...records(kind, "blocked", beads.blocked ?? []),
  ];
}
