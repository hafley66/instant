import { createRoot } from "react-dom/client";
import {
  BoopAgentExplorerPanel,
  setBoopAgentExplorerRunner,
} from "../src/2_boopAgentExplorerPanel";

const TOTAL = 2_000;
let revision = 0;
(window as Window & { __boopNetworkCalls?: number }).__boopNetworkCalls = 0;

function fixture() {
  const now = Date.now();
  return Array.from({ length: TOTAL }, (_, index) => JSON.stringify({
    event_id: index + 1,
    event_key: `network-event-${index.toString().padStart(4, "0")}`,
    lane: index % 2 === 0 ? "codex-luna-a" : "claude-haiku-b",
    trace: "trace-network-e2e",
    session: `session-${index % 4}`,
    from_lane: index % 3 === 0 ? "coordinator" : "",
    to_lane: index % 3 === 0 ? `worker-${index % 8}` : "",
    kind: index % 3 === 0 ? "delivery" : index % 3 === 1 ? "turn-start" : "turn-finish",
    started_ts: now - index * 10,
    finished_ts: index % 3 === 2 ? now - index * 10 + 7 : null,
    delivery_state: index % 3 === 0 ? "delivered" : "",
    classification: index % 3 === 2 ? "completed" : "started",
    detail: `revision-${revision} event-${index.toString().padStart(4, "0")}`,
    created_ts: now - index * 10,
  })).join("\n");
}

setBoopAgentExplorerRunner(async (query) => {
  (window as Window & { __boopNetworkCalls?: number }).__boopNetworkCalls = revision + 1;
  if (query.limit !== TOTAL) throw new Error(`unexpected limit ${query.limit}`);
  revision += 1;
  return fixture();
});

createRoot(document.getElementById("root")!).render(<BoopAgentExplorerPanel />);
