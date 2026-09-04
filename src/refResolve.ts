// The renderer half of ⌘-click resolution: a token goes to Rust
// (src-tauri/src/refresolve.rs), which owns every filesystem question.
import { clickRpc, type ResolveResult } from "./ipc/contract";

export type { RefSource, ResolvedRef, ResolveResult } from "./ipc/contract";

// A token worth resolving at all: it has a path separator or an extension-looking
// tail. Pure string shape, used by the hover card before any resolution runs.
export function looksLikePath(token: string): boolean {
  if (/^(?:https?:\/\/|www\.)/i.test(token)) return false;
  return /[/~]/.test(token) || /\.[A-Za-z0-9]{1,16}$/.test(token);
}

// ⌘-hover fires per token across a wall of output, so identical questions asked
// inside the same second are answered once.
const RESOLVE_TTL_MS = 1_000;
const pending = new Map<string, { at: number; result: Promise<ResolveResult> }>();

export function resolveRef(token: string, cwd: string, sessions: string[] = []): Promise<ResolveResult> {
  const key = `${cwd} ${sessions.join(",")} ${token}`;
  const hit = pending.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.result;
  const result = clickRpc
    .resolveRef({ token, cwd, sessions })
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
