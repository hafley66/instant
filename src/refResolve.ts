// The renderer half of ⌘-click resolution: a token goes to boop_harness::click,
// which owns every filesystem question.
import { clickRpc, type ClickCell, type ResolveResult } from "./ipc/contract";

export type { ClickCell, RefSource, ResolvedRef, ResolveResult } from "./ipc/contract";

// ⌘-hover fires per token across a wall of output, so identical questions asked
// inside the same second are answered once.
const RESOLVE_TTL_MS = 1_000;
const pending = new Map<string, { at: number; result: Promise<ResolveResult> }>();

export function resolveRef(token: string, cwd: string, sessions: string[] = [], cell?: ClickCell, doc?: string): Promise<ResolveResult> {
  const key = `${cwd} ${sessions.join(",")} ${cell ? `${cell.session}:${cell.col},${cell.row}` : ""} ${doc ?? ""} ${token}`;
  const hit = pending.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.result;
  const result = clickRpc
    .resolveRef({ token, cwd, sessions, cell, doc })
    .catch(() => ({ kind: "miss" }) as ResolveResult);
  pending.set(key, { at: Date.now(), result });
  return result;
}

// Drop the resolver's index, both sides. Called when a preview's watch reports a
// change, so a file created since the last walk resolves immediately.
export function clearRefCaches() {
  pending.clear();
  void clickRpc.clearRefIndex().catch(() => {});
}
