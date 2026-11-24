import { defer, exhaustMap, from, map, timer, type Observable } from "rxjs";
import type { StatusProbe } from "../plugin";
import type { ApplicationEventBus } from "./eventBus";
import type { StatusRow } from "./statusModel";

export const STATUS_POLL_MS = 4000;

export async function checkStatusProbes(probes: StatusProbe[]): Promise<StatusRow[]> {
  return Promise.all(
    probes.map(async (probe): Promise<StatusRow> => {
      try {
        return { id: probe.id, label: probe.label, report: await probe.check() };
      } catch (error) {
        return {
          id: probe.id,
          label: probe.label,
          report: { state: "down", detail: String(error) },
        };
      }
    }),
  );
}

// Polls on a fixed interval and never overlaps: a poll still in flight swallows
// the ticks behind it. Unsubscribing drops a late response before it is emitted.
export function statusPolling(
  bus: ApplicationEventBus,
  probes: () => StatusProbe[],
  pollMs = STATUS_POLL_MS,
): Observable<void> {
  return defer(() => {
    let sequence = 0;
    return timer(0, pollMs).pipe(
      exhaustMap(() => {
        const current = ++sequence;
        bus.emit("status.poll.requested", { sequence: current });
        return from(checkStatusProbes(probes())).pipe(
          map((rows) => bus.emit("status.poll.completed", { sequence: current, rows })),
        );
      }),
    );
  });
}
