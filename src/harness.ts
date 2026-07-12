// Harness integration boundary for terminal panels. Detection is cheap and
// side-effect free; durable ledger operations live behind these adapters.
import { invoke } from "./generated/native";
import type { AiMessage } from "./state";

export type HarnessId = "claude" | "opencode";
export type HarnessObservation = {
  id: HarnessId | null;
  confidence: "high" | "medium" | "low" | "none";
  evidence: string[];
  outputTail: string;
};
export type HarnessAdapter = {
  id: HarnessId;
  label: string;
  matchesCommand(command: string): boolean;
  matchesOutput(output: string): boolean;
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
    matchesOutput: (s) => /Claude Code|╭─.*Claude|⏺/.test(s),
    sessions: (cwd) => invoke<string[]>("harness_sessions", { tool: "claude", cwd }),
    resolve: (cwd) => invoke<string | null>("harness_session", { tool: "claude", cwd }),
    read: (sessionId, cwd, afterSeq = 0) => invoke<AiMessage[]>("read_ai_messages", { editor: "claude", sessionId, cwd, afterSeq: afterSeq || null }),
    latest: (sessionId, cwd) => invoke<AiMessage | null>("latest_ai_message", { editor: "claude", sessionId, cwd }),
    resume: (sessionId) => `claude --resume ${sessionId}`,
  },
  {
    id: "opencode", label: "OpenCode",
    matchesCommand: (s) => /(?:^|[\\/\s])opencode(?:\.exe)?(?:\s|$)/i.test(s),
    matchesOutput: (s) => /OpenCode|opencode|╭─.*Open/.test(s),
    sessions: (cwd) => invoke<string[]>("harness_sessions", { tool: "opencode", cwd }),
    resolve: (cwd) => invoke<string | null>("harness_session", { tool: "opencode", cwd }),
    read: (sessionId, cwd, afterSeq = 0) => invoke<AiMessage[]>("read_ai_messages", { editor: "opencode", sessionId, cwd, afterSeq: afterSeq || null }),
    latest: (sessionId, cwd) => invoke<AiMessage | null>("latest_ai_message", { editor: "opencode", sessionId, cwd }),
    resume: (sessionId) => `opencode --session ${sessionId}`,
  },
];

export const harnessAdapters = Object.fromEntries(adapters.map((a) => [a.id, a])) as Record<HarnessId, HarnessAdapter>;
export const harnessAdapter = (id: HarnessId) => harnessAdapters[id];

export function detectHarness(command: string | null | undefined, foreground: string | null | undefined, outputTail = ""): HarnessObservation {
  const evidence: string[] = [];
  const scores = new Map<HarnessId, number>();
  for (const adapter of adapters) {
    let score = 0;
    if (adapter.matchesCommand(command ?? "")) { score += 3; evidence.push(`${adapter.id}:command`); }
    if (adapter.matchesCommand(foreground ?? "")) { score += 3; evidence.push(`${adapter.id}:process`); }
    if (adapter.matchesOutput(outputTail)) { score += 2; evidence.push(`${adapter.id}:output`); }
    scores.set(adapter.id, score);
  }
  const [id, score] = [...scores.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return { id: score ? id : null, confidence: score >= 5 ? "high" : score >= 3 ? "medium" : score ? "low" : "none", evidence, outputTail };
}

export function trimOutputTail(previous: string, chunk: string, cap = 16_384): string {
  const next = previous + chunk;
  return next.length <= cap ? next : next.slice(-cap);
}
