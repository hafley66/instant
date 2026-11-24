import { finalize, merge, type Observable } from "rxjs";
import { statusProbes } from "../plugin";
import { sink } from "./0_root";
import { createEventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { runtimePorts, type RuntimePorts } from "./ports";
import { aggregateHealth, statusRows } from "./statusModel";
import { statusPolling } from "./statusPolling";

export function statusFlow(ports: RuntimePorts = runtimePorts): Observable<unknown> {
  const bus = createEventBus<AppEvents>();
  return merge(
    bus.on("status.poll.completed").pipe(sink(({ rows }) => statusRows.$(rows))),
    aggregateHealth.$.pipe(sink((health) => ports.setRailHealth(health))),
    statusPolling(bus, statusProbes),
  ).pipe(finalize(() => bus.close()));
}
// todo(boundary): move per-terminal, per-panel, and per-component subscriptions into root-owned flows
