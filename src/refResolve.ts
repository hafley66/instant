// Turning a clicked token into a real file on disk. Agent output rarely hands
// over a path that is complete from the terminal's cwd: it prints repo-relative
// paths (`src/main.ts` while the shell sits in a subdirectory), bare filenames
// (`MdPanel.tsx`), or a partial tail (`mdview/MdPanel.tsx`). This walks the
// candidates in order of confidence, then falls back to a gitignore-aware
// filename search under the repo root and offers the matches.
import { invoke } from "./generated/native";
import { splitLineRef } from "./termTokens";
import { crawlCandidates, fuzzyPathHits, uniqueDirNamed, withDirectories } from "./0_pathLadder";

export type RefSource = "absolute" | "cwd" | "repo" | "ancestor" | "search" | "fuzzy";
export type ResolvedRef = { path: string; line?: number; source: RefSource };
export type ResolveResult =
  | { kind: "hit"; ref: ResolvedRef }
  | { kind: "choices"; paths: string[]; line?: number; via: "exact" | "fuzzy" }
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

// $HOME stops the ancestor crawl. Loaded lazily: core pulls the whole app state
// graph, and this module is imported by node-env unit tests.
async function crawlBoundary(): Promise<string> {
  try {
    return (await import("./core")).getHomeDir();
  } catch {
    return "";
  }
}

// The index the fuzzy rung ranks: the gitignore-aware file list plus the
// directories it implies. Shares searchEntries' cache window.
const indexCache = new Map<string, { source: Promise<Entry[]>; built: Promise<Entry[]> }>();

function searchIndex(root: string): Promise<Entry[]> {
  const source = searchEntries(root);
  const hit = indexCache.get(root);
  if (hit && hit.source === source) return hit.built;
  const built = source.then((rows) => withDirectories(rows, root));
  indexCache.set(root, { source, built });
  return built;
}

// Resolve a clicked token. `hit` is a path that exists; `choices` is a token that
// matched several paths (the caller offers them); `miss` hands it to ripgrep.
export async function resolveRef(token: string, cwd: string): Promise<ResolveResult> {
  const clean = token.trim().replace(/^['"`]|['"`]$/g, "");
  const { path: rel, line } = splitLineRef(clean);
  if (!clean || !rel) return { kind: "miss" };

  if (rel.startsWith("/") || rel.startsWith("~/")) {
    return { kind: "hit", ref: { path: rel, line, source: "absolute" } };
  }

  const root = await repoRootFor(cwd);
  const searchRoot = root || cwd;
  // The line suffix is off before the shape test, so `main.ts:214` is a path.
  if (!looksLikePath(rel)) return resolveBareWord(rel, searchRoot);

  for (const candidate of crawlCandidates(rel, cwd, root, await crawlBoundary())) {
    if (await exists(candidate.path)) {
      return { kind: "hit", ref: { path: candidate.path, line, source: candidate.step as RefSource } };
    }
  }

  if (!searchRoot) return { kind: "miss" };
  const entries = await searchEntries(searchRoot);
  const hits = rankSearchHits(rel, entries);
  if (hits.length === 1) return { kind: "hit", ref: { path: hits[0], line, source: "search" } };
  if (hits.length > 1) return { kind: "choices", paths: hits.slice(0, 50), line, via: "exact" };

  const fuzzy = fuzzyPathHits(rel, await searchIndex(searchRoot), 20);
  if (fuzzy.length) return { kind: "choices", paths: fuzzy.map((f) => f.path), line, via: "fuzzy" };
  return { kind: "miss" };
}

// A bare word (no separator, no extension) is a symbol nine times in ten, so it
// only leaves ripgrep when it names exactly one directory in the index.
async function resolveBareWord(token: string, searchRoot: string): Promise<ResolveResult> {
  if (!searchRoot) return { kind: "miss" };
  const dir = uniqueDirNamed(token, await searchIndex(searchRoot));
  return dir ? { kind: "hit", ref: { path: dir, source: "fuzzy" } } : { kind: "miss" };
}

// Drop the caches. Called when a preview's watch reports a change, so a file
// created since the last listing resolves without waiting out the TTL.
export function clearRefCaches() {
  dirCache.clear();
  searchCache.clear();
  rootCache.clear();
  indexCache.clear();
}
