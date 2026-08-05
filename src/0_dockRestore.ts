import { sessionId } from "./0_ids";
import type { OpenTab } from "./state";

export function restoredTerminalSessionIds(openTabs: readonly OpenTab[]): Set<string> {
  return new Set(openTabs.map((tab) => sessionId(tab.name)));
}
