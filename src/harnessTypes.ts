// Product-neutral harness identity shared by state, terminal observation, and
// adapter consumers. Product names belong in the adapter registry only.
export type HarnessId = "claude" | "opencode" | "codex" | "kimi";
export type HarnessObservation = {
  id: HarnessId | null;
  confidence: "high" | "medium" | "low" | "none";
  evidence: string[];
  outputTail: string;
};
