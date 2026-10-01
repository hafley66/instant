// File resolution is click-driven. Hover reads completed results without starting
// filesystem walks or subprocesses while the pointer crosses terminal output.
import { clickRpc, type ClickCell, type ResolveResult } from "./ipc/contract";

export type { ClickCell, RefSource, ResolvedRef, ResolveResult } from "./ipc/contract";

const RESOLVE_TTL_MS = 10_000;
const pending = new Map<string, Promise<ResolveResult>>();
const completed = new Map<string, { at: number; result: ResolveResult }>();
const keyOf = (token: string, cwd: string, sessions: string[], cell?: ClickCell, doc?: string) =>
  JSON.stringify([token, cwd, sessions, cell, doc]);

export function cachedRef(token: string, cwd: string, sessions: string[] = [], cell?: ClickCell, doc?: string): ResolveResult {
  const hit = completed.get(keyOf(token, cwd, sessions, cell, doc));
  return hit && Date.now() - hit.at < RESOLVE_TTL_MS ? hit.result : { kind: "miss" };
}

export function resolveRef(token: string, cwd: string, sessions: string[] = [], cell?: ClickCell, doc?: string): Promise<ResolveResult> {
  const key = keyOf(token, cwd, sessions, cell, doc);
  const running = pending.get(key);
  if (running) return running;
  const hit = completed.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return Promise.resolve(hit.result);
  const result = clickRpc.resolveRef({ token, cwd, sessions, cell, doc }).then((result) => {
    // An invalidation during the request prevents an obsolete cache insertion.
    if (pending.get(key) === promise) {
      completed.delete(key);
      completed.set(key, { at: Date.now(), result });
      if (completed.size > 256) completed.delete(completed.keys().next().value!);
    }
    return result;
  });
  const promise = result.finally(() => {
    if (pending.get(key) === promise) pending.delete(key);
  });
  pending.set(key, promise);
  return promise;
}

export function clearRefCaches() {
  pending.clear();
  completed.clear();
  void clickRpc.clearRefIndex().catch(() => {});
}
