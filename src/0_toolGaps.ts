// Frontend half of src-tauri/src/deps.rs. The banner is a one-time-per-gap-set
// notice, not a startup nag: a machine with git/tmux/rg never sees it.
import { invoke } from "./generated/native";

export interface ToolStatus {
  name: string;
  present: boolean;
  purpose: string;
  install: string;
}

export interface ToolGapSummary {
  missing: ToolStatus[];
  /// One line per missing tool, ready to render in a <pre>.
  lines: string[];
  headline: string;
}

const DISMISS_KEY = "instant.toolGaps.dismissed";

/// Pure so the banner copy is testable without a Tauri host.
export function summarizeToolGaps(tools: ToolStatus[]): ToolGapSummary {
  const missing = tools.filter((t) => !t.present).sort((a, b) => a.name.localeCompare(b.name));
  const lines = missing.map((t) => `${t.name} — ${t.purpose}\n    install: ${t.install}`);
  const headline = missing.length
    ? `${missing.map((t) => t.name).join(", ")} not installed`
    : "all mainline tools present";
  return { missing, lines, headline };
}

/// Identity of a gap set. Dismissing "rg" must not silence a later "tmux, rg".
export function gapKey(missing: ToolStatus[]): string {
  return missing
    .map((t) => t.name)
    .sort()
    .join("+");
}

export function shouldNotify(missing: ToolStatus[], dismissed: string | null): boolean {
  return missing.length > 0 && gapKey(missing) !== dismissed;
}

export function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

export function rememberDismissed(missing: ToolStatus[]): void {
  try {
    localStorage.setItem(DISMISS_KEY, gapKey(missing));
  } catch {
    /* private-mode storage; the banner just shows again next boot */
  }
}

export async function probeToolGaps(): Promise<ToolGapSummary> {
  const tools = await invoke<ToolStatus[]>("tool_status");
  return summarizeToolGaps(tools);
}
