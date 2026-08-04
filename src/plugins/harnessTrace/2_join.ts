// Pure tmux join for the dock strip: cwd -> pane, one going session per pane
// so the bar count equals distinct live panes (m-17f56e54). No fs, no invoke.
export interface JoinTmuxRow {
  name: string;
  pwd: string; // untildified first pane path
  chipPaths: string[]; // untildified worktree chip paths
  proc: string; // foreground process (bash/claude/opencode/codex/kimi…)
}

export interface PaneClaimant {
  id: string;
  harness: string;
  cwd: string; // untildified
  lastActivity: string;
  routedTmux: string | null; // registry route's recorded tmux name
  going: boolean; // live/idle non-subagent: only these claim panes
}

const HARNESS_BINS = new Set(["claude", "opencode", "codex", "kimi"]);

// Which harness a pane's foreground proc names, or null for plain shells.
// The claude TUI renames its proc to a bare version string ("2.1.221").
export function procHarness(proc: string): string | null {
  const trimmed = proc.trim();
  if (!trimmed) return null;
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1).toLowerCase();
  if (HARNESS_BINS.has(base)) return base;
  return /^\d+(\.\d+)+$/.test(base) ? "claude" : null;
}

// Every tmux session whose join row matched this cwd, in row order. A repo
// directory hosts more than one running tmux session (e.g. "sprefa" and
// "sprefa-3"), so the related scope needs the full list, not the single guess.
export function joinTmuxSessions(untildifiedCwd: string, rows: JoinTmuxRow[]): string[] {
  if (!untildifiedCwd) return [];
  return rows
    .filter((r) => r.pwd === untildifiedCwd || r.chipPaths.includes(untildifiedCwd))
    .map((r) => r.name);
}

// One pane hosts one live harness process: routes pin first, then newest
// activity claims; losers stay pane-less, non-going rows match without claiming.
export function assignTmuxPanes(
  claimants: PaneClaimant[],
  rows: JoinTmuxRow[],
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const claimed = new Set<string>();
  const eligible = (c: PaneClaimant, r: JoinTmuxRow) => {
    if (!c.cwd || (r.pwd !== c.cwd && !r.chipPaths.includes(c.cwd))) return false;
    const paneHarness = procHarness(r.proc);
    return paneHarness === c.harness || paneHarness === null;
  };
  const pick = (c: PaneClaimant, taken: Set<string> | null) => {
    const matches = rows.filter((r) => eligible(c, r) && !taken?.has(r.name));
    return (matches.find((r) => procHarness(r.proc) === c.harness) ?? matches[0])?.name ?? null;
  };
  const going = claimants.filter((c) => c.going);
  for (const c of going) {
    if (c.routedTmux === null) continue;
    out.set(c.id, c.routedTmux);
    claimed.add(c.routedTmux);
  }
  const walkins = going
    .filter((c) => !out.has(c.id))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
  for (const c of walkins) {
    const name = pick(c, claimed);
    out.set(c.id, name);
    if (name !== null) claimed.add(name);
  }
  for (const c of claimants) {
    if (!out.has(c.id)) out.set(c.id, c.routedTmux ?? pick(c, null));
  }
  return out;
}
