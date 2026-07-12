// Harness integration boundary for terminal panels. Detection is cheap and
// side-effect free; durable ledger operations live behind these adapters.
import { invoke } from "./generated/native";
import type { AiMessage } from "./state";
import type { HarnessId, HarnessObservation } from "./harnessTypes";
export type { HarnessId, HarnessObservation } from "./harnessTypes";
export type HarnessAdapter = {
  id: HarnessId;
  label: string;
  matchesCommand(command: string): boolean;
  matchesProcess(process: string): boolean;
  matchesOutput(output: string): boolean;
  isAgentProcess(process: string): boolean;
  resumeFlag: string;
  stableSessionIdFlag?: string;
  hasExplicitSession(command: string): boolean;
  sessions(cwd: string): Promise<string[]>;
  resolve(cwd: string): Promise<string | null>;
  read(sessionId: string, cwd: string, afterSeq?: number): Promise<AiMessage[]>;
  latest(sessionId: string, cwd: string): Promise<AiMessage | null>;
  resume(sessionId: string): string;
};

const adapters: HarnessAdapter[] = [
  {
    id: "claude", label: "Claude Code",
    matchesCommand: (s) => /(?:^|[\\/\s])claude(?:\s|$)/i.test(s),
    matchesProcess: (s) => /^(?:claude|\d+\.\d+)$/.test(s),
    isAgentProcess: (s) => /^(?:claude|\d+\.\d+)$/.test(s),
    resumeFlag: "--resume", stableSessionIdFlag: "--session-id",
    hasExplicitSession: (s) => /\s--(?:resume|session-id|continue|from-pr)\b/.test(s),
    // Do not key on the product name alone: a shell command, chat response, or
    // error can mention "Claude Code" while the pane is just zsh. These are
    // visual chrome markers emitted by the full-screen client.
    matchesOutput: (s) => /(?:^|\n)\s*╭─[^\n]*Claude|(?:^|\n)\s*⏺\s+(?:I'll|I|Let|We)\b/.test(s),
    sessions: (cwd) => invoke<string[]>("harness_sessions", { tool: "claude", cwd }),
    resolve: (cwd) => invoke<string | null>("harness_session", { tool: "claude", cwd }),
    read: (sessionId, cwd, afterSeq = 0) => invoke<AiMessage[]>("read_ai_messages", { editor: "claude", sessionId, cwd, afterSeq: afterSeq || null }),
    latest: (sessionId, cwd) => invoke<AiMessage | null>("latest_ai_message", { editor: "claude", sessionId, cwd }),
    resume: (sessionId) => `claude --resume ${sessionId}`,
  },
  {
    id: "opencode", label: "OpenCode",
    matchesCommand: (s) => /(?:^|[\\/\s])opencode(?:\.exe)?(?:\s|$)/i.test(s),
    // node/bun are launch shims and are valid close-time agent processes, but
    // too generic to identify a live harness from tmux metadata alone.
    matchesProcess: (s) => /^opencode(?:\.exe)?$/.test(s),
    isAgentProcess: (s) => /^(?:opencode(?:\.exe)?|node|bun)$/.test(s),
    resumeFlag: "--session",
    hasExplicitSession: (s) => /\s--session\b/.test(s),
    // A bare `opencode` token is common in logs and prompts; require the
    // bordered TUI header instead.
    matchesOutput: (s) => /(?:^|\n)\s*╭─[^\n]*(?:OpenCode|Open Code)|(?:^|\n)\s*┃[^\n]*(?:OpenCode|Open Code)/.test(s),
    sessions: (cwd) => invoke<string[]>("harness_sessions", { tool: "opencode", cwd }),
    resolve: (cwd) => invoke<string | null>("harness_session", { tool: "opencode", cwd }),
    read: (sessionId, cwd, afterSeq = 0) => invoke<AiMessage[]>("read_ai_messages", { editor: "opencode", sessionId, cwd, afterSeq: afterSeq || null }),
    latest: (sessionId, cwd) => invoke<AiMessage | null>("latest_ai_message", { editor: "opencode", sessionId, cwd }),
    resume: (sessionId) => `opencode --session ${sessionId}`,
  },
  {
    id: "codex", label: "Codex",
    matchesCommand: (s) => /(?:^|[\\/\s])codex(?:\.exe)?(?:\s|$)/i.test(s),
    matchesProcess: (s) => /^codex(?:\.exe)?$/.test(s),
    isAgentProcess: (s) => /^(?:codex(?:\.exe)?|node|bun)$/.test(s),
    resumeFlag: "resume",
    hasExplicitSession: (s) => /\s+resume(?:\s|$)/.test(s),
    sessions: (cwd) => invoke<string[]>("harness_sessions", { tool: "codex", cwd }),
    resolve: (cwd) => invoke<string | null>("harness_session", { tool: "codex", cwd }),
    read: (sessionId, cwd, afterSeq = 0) => invoke<AiMessage[]>("read_ai_messages", { editor: "codex", sessionId, cwd, afterSeq: afterSeq || null }),
    latest: (sessionId, cwd) => invoke<AiMessage | null>("latest_ai_message", { editor: "codex", sessionId, cwd }),
    resume: (sessionId) => `codex resume ${sessionId}`,
    matchesOutput: (s) => /(?:^|\n)\s*(?:OpenAI Codex|╭─[^\n]*Codex)/.test(s),
  },
];

export const harnessAdapters = Object.fromEntries(adapters.map((a) => [a.id, a])) as Record<HarnessId, HarnessAdapter>;
export const harnessIds = adapters.map((a) => a.id) as HarnessId[];
export const harnessAdapter = (id: HarnessId) => harnessAdapters[id];

export function detectHarness(command: string | null | undefined, foreground: string | null | undefined, outputTail = ""): HarnessObservation {
  const evidence: string[] = [];
  const scores = new Map<HarnessId, number>();
  for (const adapter of adapters) {
    let score = 0;
    if (adapter.matchesCommand(command ?? "")) { score += 3; evidence.push(`${adapter.id}:command`); }
    if (adapter.matchesProcess(foreground ?? "")) { score += 3; evidence.push(`${adapter.id}:process`); }
    if (adapter.matchesOutput(outputTail)) { score += 2; evidence.push(`${adapter.id}:output`); }
    scores.set(adapter.id, score);
  }
  const [id, score] = [...scores.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return { id: score ? id : null, confidence: score >= 5 ? "high" : score >= 3 ? "medium" : score ? "low" : "none", evidence, outputTail };
}

export function harnessesForCommand(command: string | null | undefined): HarnessId[] {
  const hit = adapters.find((a) => a.matchesCommand(command ?? ""));
  return hit ? [hit.id, ...adapters.filter((a) => a.id !== hit.id).map((a) => a.id)] : adapters.map((a) => a.id);
}

export function harnessForCommand(command: string | null | undefined): HarnessAdapter | null {
  return adapters.find((a) => a.matchesCommand(command ?? "")) ?? null;
}

export function isHarnessProcess(process: string): boolean {
  return adapters.some((a) => a.isAgentProcess(process));
}

export function trimOutputTail(previous: string, chunk: string, cap = 16_384): string {
  const next = previous + chunk;
  return next.length <= cap ? next : next.slice(-cap);
}
