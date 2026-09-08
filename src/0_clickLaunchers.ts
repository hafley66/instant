// Programs whose whole job is to hand a token to another app. They print
// nothing on success, and the receipt is the app that came forward, so a
// click rule built on one of them opens no results panel.
const LAUNCHERS = new Set(["open", "xdg-open", "code", "cursor", "subl", "zed", "idea"]);

/// The launcher a rule's command starts with, or null for a command whose
/// stdout is the answer (rg, grep, fzf).
export function launcherOf(command: string): string | null {
  const program = command.trim().split(/\s+/)[0] ?? "";
  const name = program.split("/").pop() ?? program;
  return LAUNCHERS.has(name) ? name : null;
}
