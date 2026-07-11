import { Subscription } from "rxjs";
import { statusProbes } from "../plugin";
import { createEventBus } from "./eventBus";
import type { AppEvents } from "./events";
import { runtimePorts, type RuntimePorts } from "./ports";
import { aggregateHealth, statusRows } from "./statusModel";
import { startStatusPolling } from "./statusPolling";

let runtime: Subscription | undefined;

export function startReactiveRuntime(ports: RuntimePorts = runtimePorts): () => void {
  runtime?.unsubscribe();
  const bus = createEventBus<AppEvents>();
  const owned = new Subscription();
  owned.add(startStatusPolling(bus, statusProbes));
  owned.add(bus.on("status.poll.completed").subscribe(({ rows }) => statusRows.$(rows)));
  owned.add(aggregateHealth.$.subscribe((health) => ports.setRailHealth(health)));
  owned.add(() => bus.close());
  runtime = owned;
  return () => {
    owned.unsubscribe();
    if (runtime === owned) runtime = undefined;
  };
}
// todo(lifecycle): add per-stream error isolation and runtime diagnostics
// todo(boundary): move remaining recurring application work into runtime-owned subscriptions
