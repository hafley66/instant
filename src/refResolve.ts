// Turning a clicked token into a real file on disk. Agent output rarely hands
// over a path that is complete from the terminal's cwd: it prints repo-relative
// paths (`src/main.ts` while the shell sits in a subdirectory), bare filenames
// (`MdPanel.tsx`), or a partial tail (`mdview/MdPanel.tsx`). This walks the
// candidates in order of confidence, then falls back to a gitignore-aware
// filename search under the repo root and offers the matches.
import { invoke } from "./generated/native";
import { splitLineRef } from "./termTokens";

export type RefSource = "absolute" | "cwd" | "repo" | "search";
export type ResolvedRef = { path: string; line?: number; source: RefSource };
export type ResolveResult =
  | { kind: "hit"; ref: ResolvedRef }
  | { kind: "choices"; paths: string[]; line?: number }
  | { kind: "miss" };

type Entry = { name: string; path: string; is_dir: boolean };
type DirListing = { entries: Entry[] };
type WorktreeRow = { worktree: string };

const trimSlash = (p: string) => p.replace(/\/+$/, "");
const join = (dir: string, rel: string) => `${trimSlash(dir)}/${rel.replace(/^\.\//, "")}`;

// A token worth resolving against the filesystem: it has a path separator, or
// an extension-looking tail. Bare words are left to the search rule, which is
// what finds a symbol.
export function looksLikePath(token: string): boolean {
  if (/^(?:https?:\/\/|www\.)/i.test(token)) return false;
  return /[/~]/.test(token) || /\.[A-Za-z0-9]{1,16}$/.test(token);
}

// Where to look for `rel`, best guess first. An absolute or home-relative path
// is its own only candidate; everything else is tried against the terminal cwd
// before the repo root, since a path printed by a program in that directory is
// more often relative to it.
export function candidatePaths(rel: string, cwd: string, repoRoot: string | null): string[] {
  if (rel.startsWith("/") || rel.startsWith("~/")) return [rel];
  const out: string[] = [];
  if (cwd) out.push(join(cwd, rel));
  if (repoRoot && trimSlash(repoRoot) !== trimSlash(cwd)) out.push(join(repoRoot, rel));
  if (!out.length) out.push(rel);
  return out;
}

// Search hits for `rel`, best first. A hit whose path ends with the whole token
// beats one that only shares the filename, and a shallower path beats a deeper
// one (the top-level `src/main.ts` over some fixture copy buried in a test dir).
export function rankSearchHits(rel: string, entries: Entry[]): string[] {
  const tail = rel.replace(/^\.?\//, "");
  const base = tail.split("/").pop() ?? tail;
  const scored: Array<{ path: string; score: number; depth: number }> = [];
  for (const e of entries) {
    if (e.is_dir) continue;
    const suffix = e.path.endsWith(`/${tail}`) || e.path === tail;
    const named = e.name === base;
    if (!suffix && !named) continue;
    scored.push({ path: e.path, score: suffix ? 0 : 1, depth: e.path.split("/").length });
  }
  scored.sort((a, b) => a.score - b.score || a.depth - b.depth || a.path.localeCompare(b.path));
  return scored.map((s) => s.path);
}

// Directory listings and repo roots are read repeatedly while the pointer moves
// across a wall of agent output, so both are cached. Listings expire, since a
// build writing files under the cursor is normal here.
const DIR_TTL_MS = 5_000;
const dirCache = new Map<string, { at: number; names: Set<string> }>();
const rootCache = new Map<string, Promise<string | null>>();
const searchCache = new Map<string, { at: number; entries: Promise<Entry[]> }>();
const SEARCH_TTL_MS = 30_000;

async function dirNames(dir: string): Promise<Set<string>> {
  const hit = dirCache.get(dir);
  if (hit && Date.now() - hit.at < DIR_TTL_MS) return hit.names;
  let names = new Set<string>();
  try {
    const listing = await invoke<DirListing>("list_dir", { path: dir });
    names = new Set((listing?.entries ?? []).map((e) => e.name));
  } catch {
    /* unreadable directory: treat as empty, the candidate just misses */
  }
  dirCache.set(dir, { at: Date.now(), names });
  return names;
}

async function exists(path: string): Promise<boolean> {
  const at = path.lastIndexOf("/");
  if (at <= 0) return false;
  const names = await dirNames(path.slice(0, at));
  return names.has(path.slice(at + 1));
}

export async function repoRootFor(cwd: string): Promise<string | null> {
  if (!cwd) return null;
  const cached = rootCache.get(cwd);
  if (cached) return cached;
  const pending = invoke<WorktreeRow | null>("worktree_at", { path: cwd })
    .then((row) => row?.worktree ?? null)
    .catch(() => null);
  rootCache.set(cwd, pending);
  return pending;
}

function searchEntries(root: string): Promise<Entry[]> {
  const hit = searchCache.get(root);
  if (hit && Date.now() - hit.at < SEARCH_TTL_MS) return hit.entries;
  const entries = invoke<Entry[]>("search_files", { path: root, maxFiles: 20_000 })
    .then((rows) => rows ?? [])
    .catch(() => [] as Entry[]);
  searchCache.set(root, { at: Date.now(), entries });
  return entries;
}

// Resolve a clicked token. `hit` is a file that exists; `choices` is a filename
// that matched several files (the caller offers them); `miss` means nothing on
// disk matched, so the token belongs to the search rule.
export async function resolveRef(token: string, cwd: string): Promise<ResolveResult> {
  const clean = token.trim().replace(/^['"`]|['"`]$/g, "");
  if (!clean || !looksLikePath(clean)) return { kind: "miss" };
  const { path: rel, line } = splitLineRef(clean);
  if (!rel) return { kind: "miss" };

  if (rel.startsWith("/") || rel.startsWith("~/")) {
    return { kind: "hit", ref: { path: rel, line, source: "absolute" } };
  }

  const root = await repoRootFor(cwd);
  const candidates = candidatePaths(rel, cwd, root);
  for (const [i, candidate] of candidates.entries()) {
    if (await exists(candidate)) {
      return { kind: "hit", ref: { path: candidate, line, source: i === 0 ? "cwd" : "repo" } };
    }
  }

  const searchRoot = root || cwd;
  if (!searchRoot) return { kind: "miss" };
  const hits = rankSearchHits(rel, await searchEntries(searchRoot));
  if (hits.length === 1) return { kind: "hit", ref: { path: hits[0], line, source: "search" } };
  if (hits.length > 1) return { kind: "choices", paths: hits.slice(0, 50), line };
  return { kind: "miss" };
}

// Drop the caches. Called when a preview's watch reports a change, so a file
// created since the last listing resolves without waiting out the TTL.
export function clearRefCaches() {
  dirCache.clear();
  searchCache.clear();
  rootCache.clear();
}
