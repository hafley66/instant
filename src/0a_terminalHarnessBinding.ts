import { harnessIds } from "./0_harnessDefinitions";
import type { HarnessId, HarnessObservation } from "./harnessTypes";

export type PaneSessionBinding = {
  session: string;
  harness: string | null;
};

export function harnessFromPaneSession(binding: PaneSessionBinding | null): HarnessObservation | null {
  const harness = binding?.harness;
  if (!harness || !harnessIds.includes(harness as HarnessId)) return null;
  return {
    id: harness as HarnessId,
    confidence: "high",
    evidence: ["boop:session"],
    outputTail: "",
  };
}

export function resolvedTerminalHarness(
  observed: HarnessObservation,
  binding: PaneSessionBinding | null,
): HarnessObservation {
  return harnessFromPaneSession(binding) ?? observed;
}
