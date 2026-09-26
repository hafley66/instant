// Product-neutral harness identity shared by state, terminal observation, and
// adapter consumers. Product names belong in the adapter registry only.
import type { HarnessId } from "@hafley66/boop-xterm";
export type { HarnessId } from "@hafley66/boop-xterm";
export type HarnessObservation = {
  id: HarnessId | null;
  confidence: "high" | "medium" | "low" | "none";
  evidence: string[];
  outputTail: string;
};
