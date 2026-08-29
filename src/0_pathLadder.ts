// Rungs between a ⌘-clicked token and ripgrep: cwd, repo root, every ancestor up
// to $HOME, then fzf over the repo index. No filesystem or DOM access here.
import { Fzf, byLengthAsc, byStartAsc } from "fzf";

export type LadderStep = "absolute" | "cwd" | "repo" | "ancestor" | "search" | "fuzzy";
export type IndexEntry = { path: string; name: string; is_dir: boolean };
export type Candidate = { path: string; step: LadderStep };
export type FuzzyHit = { path: string; name: string; is_dir: boolean; score: number };

const trimSlash = (p: string) => p.replace(/\/+$/, "") || "/";
const joinUnder = (dir: string, rel: string) => `${trimSlash(dir)}/${rel.replace(/^\.\//, "")}`.replace(/^\/\//, "/");

// fzf v2 pays 16/char for an exact run plus boundary bonuses; below 12/char the
// match is a coincidental subsequence and the click belongs to ripgrep.
export const MIN_FUZZY_SCORE_PER_CHAR = 12;
export const MIN_FUZZY_QUERY = 4;

// Directories from cwd up to and including `boundary`, nearest first. A cwd
// outside the boundary walks toward `/` instead. `max` caps the probe fan-out.
export function ancestorsOf(cwd: string, boundary: string, max = 8): string[] {
  const start = trimSlash(cwd);
  if (!start || start === "/") return [];
  const stop = boundary ? trimSlash(boundary) : "/";
  const inside = start === stop || start.startsWith(`${stop}/`);
  const out: string[] = [];
  let dir = start;
  while (out.length < max) {
    out.push(dir);
    if (inside && dir === stop) break;
    const parent = dir.slice(0, dir.lastIndexOf("/")) || "/";
    if (parent === dir || parent === "/") break;
    dir = parent;
  }
  return out;
}

// Full paths to stat, best guess first. `step` records which rung produced the
// candidate; the hover card and the tests read it.
export function crawlCandidates(
  rel: string,
  cwd: string,
  repoRoot: string | null,
  boundary: string,
  max = 8,
): Candidate[] {
  if (rel.startsWith("/") || rel.startsWith("~/")) return [{ path: rel, step: "absolute" }];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const push = (dir: string, step: LadderStep) => {
    if (!dir) return;
    const path = joinUnder(dir, rel);
    if (seen.has(path)) return;
    seen.add(path);
    out.push({ path, step });
  };
  if (cwd) push(cwd, "cwd");
  if (repoRoot) push(repoRoot, "repo");
  for (const dir of ancestorsOf(cwd, boundary, max)) push(dir, "ancestor");
  if (!out.length) out.push({ path: rel.replace(/^\.\//, ""), step: "cwd" });
  return out;
}

// search_files returns files only; a clicked token is as often a folder, so the
// ancestors of every indexed file are folded back in, capped at `root`.
export function withDirectories(entries: IndexEntry[], root: string): IndexEntry[] {
  const base = trimSlash(root);
  const dirs = new Map<string, IndexEntry>();
  for (const entry of entries) {
    if (entry.is_dir) continue;
    let dir = entry.path.slice(0, entry.path.lastIndexOf("/"));
    while (dir && dir !== base && dir !== "/" && !dirs.has(dir)) {
      dirs.set(dir, { path: dir, name: dir.slice(dir.lastIndexOf("/") + 1), is_dir: true });
      dir = dir.slice(0, dir.lastIndexOf("/"));
    }
  }
  return [...entries, ...dirs.values()];
}

// A token carrying a separator is matched against the whole path; a bare
// filename against the basename, so a deep folder chain cannot out-score it.
export function fuzzyPathHits(query: string, entries: IndexEntry[], limit = 20): FuzzyHit[] {
  const clean = query.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (clean.length < MIN_FUZZY_QUERY || entries.length === 0) return [];
  const scoped = clean.includes("/");
  const selector = (entry: IndexEntry) => (scoped ? entry.path : entry.name);
  const fzf = new Fzf(entries, {
    selector,
    limit,
    casing: "case-insensitive",
    tiebreakers: [byLengthAsc, byStartAsc],
  });
  const floor = MIN_FUZZY_SCORE_PER_CHAR * clean.replace(/\//g, "").length;
  return fzf
    .find(clean)
    .filter((result) => result.score >= floor)
    .map((result) => ({ ...result.item, score: result.score }));
}

// Exactly one directory named `token` opens that folder. Anything looser stays
// with ripgrep, which is what a bare word usually wants.
export function uniqueDirNamed(token: string, entries: IndexEntry[]): string | null {
  const want = token.trim().toLowerCase();
  if (want.length < MIN_FUZZY_QUERY) return null;
  const hits = entries.filter((e) => e.is_dir && e.name.toLowerCase() === want);
  return hits.length === 1 ? hits[0].path : null;
}
