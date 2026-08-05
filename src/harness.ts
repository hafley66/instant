// Harness integration boundary for terminal panels. Product-specific pure
// behavior is shared with CLI consumers; durable ledger operations bind here.
import { invoke } from "./generated/native";
import type { AiMessage } from "./state";
import type { HarnessId, HarnessObservation } from "./harnessTypes";
import {
  harnessDefinitions,
  harnessIds,
  type HarnessDefinition,
} from "./0_harnessDefinitions";

export type { HarnessId, HarnessObservation } from "./harnessTypes";
export type { HarnessLaneLaunch } from "./0_harnessDefinitions";
export { harnessIds } from "./0_harnessDefinitions";

export type HarnessAdapter = HarnessDefinition & {
  sessions(cwd: string): Promise<string[]>;
  resolve(cwd: string): Promise<string | null>;
  read(sessionId: string, cwd: string, afterSeq?: number): Promise<AiMessage[]>;
  latest(sessionId: string, cwd: string): Promise<AiMessage | null>;
};

const adapters = harnessDefinitions.map((definition): HarnessAdapter => ({
  ...definition,
  sessions: (cwd) => invoke<string[]>("harness_sessions", { tool: definition.id, cwd }),
  resolve: (cwd) => invoke<string | null>("harness_session", { tool: definition.id, cwd }),
  read: (sessionId, cwd, afterSeq = 0) => invoke<AiMessage[]>("read_ai_messages", {
    editor: definition.id, sessionId, cwd, afterSeq: afterSeq || null,
  }),
  latest: (sessionId, cwd) => invoke<AiMessage | null>("latest_ai_message", {
    editor: definition.id, sessionId, cwd,
  }),
}));

export const harnessAdapters = Object.fromEntries(
  adapters.map((adapter) => [adapter.id, adapter]),
) as Record<HarnessId, HarnessAdapter>;

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
  const hit = harnessDefinitions.find((adapter) => adapter.matchesCommand(command ?? ""));
  return hit ? [hit.id, ...harnessIds.filter((id) => id !== hit.id)] : [...harnessIds];
}

export function harnessForCommand(command: string | null | undefined): HarnessAdapter | null {
  const definition = harnessDefinitions.find((adapter) => adapter.matchesCommand(command ?? ""));
  return definition ? harnessAdapters[definition.id] : null;
}

export function isHarnessProcess(process: string): boolean {
  return harnessDefinitions.some((adapter) => adapter.isAgentProcess(process));
}

export function trimOutputTail(previous: string, chunk: string, cap = 16_384): string {
  const next = previous + chunk;
  return next.length <= cap ? next : next.slice(-cap);
}
