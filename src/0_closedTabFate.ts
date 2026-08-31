// "kill" ends the tmux session (agent tab, frees claude/opencode RAM);
// "detach" leaves it running for reattach. Pure so the close path is testable.
export function closedTabFate(o: {
  isViewer: boolean;
  isAgentProc: boolean; // live foreground looks like an agent
  launchNamesAgent: boolean; // launch command's binary has a resume flag
  proc: string; // first non-shell foreground command, "" when none
  sessionListed: boolean; // the sessions poll had a row for this session name
  onDiskSessions: number; // agent jsonl sessions resolved in the tab's cwds
}): "kill" | "detach" {
  if (o.isViewer) return "detach";
  if (o.isAgentProc) return "kill";
  // proc "" with a listed session means every pane sat at a shell: no agent
  // resident, so old jsonl in the cwd or an agent launch must not kill it.
  if (o.sessionListed && o.proc === "") return "detach";
  if (o.launchNamesAgent) return "kill";
  // Unlisted session (stale poll) with unknown foreground: the on-disk probe
  // breaks the tie so a missed poll can't leave an agent resident.
  return o.proc === "" && o.onDiskSessions > 0 ? "kill" : "detach";
}
