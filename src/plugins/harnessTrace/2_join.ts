// Pure tmux join for the dock strip: an AgentSessionNode's untildified cwd maps
// to the instant tmux session running it. Matches the store tmux row whose pwd
// (first pane path) or any chip path equals the cwd; when several match, prefers
// the one whose foreground proc names the harness binary. No match = null.
// No fs, no invoke, so vitest covers it directly (see 2_join.test.ts).
export interface JoinTmuxRow {
  name: string;
  pwd: string; // untildified first pane path
  chipPaths: string[]; // untildified worktree chip paths
  proc: string; // foreground process (bash/claude/opencode/codex/kimi…)
}

const HARNESS_BINS = new Set(["claude", "opencode", "codex", "kimi"]);

// Does this foreground proc name a harness binary? Basename compare so both
// "claude" and "/usr/local/bin/claude" count.
function namesHarness(proc: string): boolean {
  const trimmed = proc.trim();
  if (!trimmed) return false;
  const base = trimmed.slice(trimmed.lastIndexOf("/") + 1).toLowerCase();
  return HARNESS_BINS.has(base);
}

export function joinTmuxSession(untildifiedCwd: string, rows: JoinTmuxRow[]): string | null {
  if (!untildifiedCwd) return null;
  const matches = rows.filter(
    (r) => r.pwd === untildifiedCwd || r.chipPaths.includes(untildifiedCwd),
  );
  if (!matches.length) return null;
  return (matches.find((r) => namesHarness(r.proc)) ?? matches[0]).name;
}
