// A fork spawns a lane in tmux; without this the only thing the user sees is a
// toast, so a fork that worked and a fork that silently did nothing look the
// same. Opening the lane's own terminal to the RIGHT of the pane it was forked
// from is the whole point: both conversations on screen, side by side.
//
// Its own module because src/terminal.ts is what opens terminals, and the fork
// path lives in there too; keeping the call here lets a test of forkSelection
// mock it instead of constructing a real xterm.
import { openTab, tabs } from "./terminal";
import { sessionId } from "./core";

/// `boop beep lane list` names a lane's tmux session with the lane's own name,
/// so the lane name attaches the pane directly.
export function openForkPanel(lane: string, preset: string) {
  openTab(lane, { split: true });
  const tab = tabs.get(sessionId(lane));
  // The pane now IS a conversation running `preset`. Forking again from inside
  // it defaults to the same preset rather than to whatever was picked last in
  // some unrelated pane (1g_forkPresetMenu.mainPreset reads this).
  if (tab) tab.forkPreset = preset;
}
