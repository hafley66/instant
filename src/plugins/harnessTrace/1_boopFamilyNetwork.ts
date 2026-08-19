// Pure focused-family scoping for Boop trace events. The focused strip must
// show only the events whose session/lane evidence belongs to the focused
// tmux family, so an unrelated family's lanes never leak into the Marbler or
// the table. No fs, no invoke: vitest covers these directly.
import type { BoopNetworkEvent } from "../../1_boopNetwork";
import type { AgentSessionNode } from "./0_types";

// Every identity the focused family owns: session ids AND lane ids. A family
// node's `id` is the session id when one exists, else the shell lane id, so
// the set below covers both session and lane evidence in one pass.
export function familyIdsOf(nodes: AgentSessionNode[]): Set<string> {
  return new Set(nodes.map((node) => node.id));
}

// Include an event when its `session` matches a family session id, or any of
// its lane/from/to evidence matches a family session or lane identity. Events
// whose only references are to unrelated families are dropped.
export function scopeEventsToFamily(events: BoopNetworkEvent[], familyIds: Set<string>): BoopNetworkEvent[] {
  if (familyIds.size === 0) return [];
  return events.filter(
    (event) =>
      familyIds.has(event.session) ||
      familyIds.has(event.lane) ||
      familyIds.has(event.from_lane) ||
      familyIds.has(event.to_lane),
  );
}
