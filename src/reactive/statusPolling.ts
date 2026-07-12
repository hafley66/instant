import { Subject, Subscription, exhaustMap, takeUntil, timer } from "rxjs";
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

export function startStatusPolling(
  bus: ApplicationEventBus,
  probes: () => StatusProbe[],
  pollMs = STATUS_POLL_MS,
): Subscription {
  const stopped = new Subject<void>();
  let sequence = 0;
  const polling = timer(0, pollMs)
    .pipe(
      takeUntil(stopped),
      exhaustMap(async () => {
        const current = ++sequence;
        bus.emit("status.poll.requested", { sequence: current });
        const rows = await checkStatusProbes(probes());
        bus.emit("status.poll.completed", { sequence: current, rows });
      }),
    )
    .subscribe();
  polling.add(() => {
    stopped.next();
    stopped.complete();
  });
  return polling;
}

