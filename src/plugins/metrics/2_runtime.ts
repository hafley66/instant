import {
  catchError,
  exhaustMap,
  from,
  map,
  of,
  shareReplay,
  timer,
  type Observable,
} from "rxjs";
import { runMachine } from "../../lib/json-rx/2_machine";
import type { Event, JsonObject, JsonValue, Machine, State } from "../../lib/json-rx/0_types";
import type { MetricMatch } from "./0_types";

const dashboardMachine: Machine = {
  initial: { value: "loading", rows: [], error: null },
  transition: (_state, event) => {
    if (event.type === "metrics.matches.loaded") {
      const rows = (event.data as JsonObject).rows ?? [];
      return {
        updates: [
          { op: "set", path: "/value", value: Array.isArray(rows) && rows.length ? "ready" : "empty" },
          { op: "set", path: "/rows", value: rows },
          { op: "set", path: "/error", value: null },
        ],
      };
    }
    if (event.type === "metrics.matches.failed") {
      const error = (event.data as JsonObject).error ?? "unknown dashboard error";
      return {
        updates: [
          { op: "set", path: "/value", value: "error" },
          { op: "set", path: "/error", value: error },
        ],
      };
    }
    return {};
  },
};

function loaded(rows: MetricMatch[]): Event {
  return { type: "metrics.matches.loaded", data: { rows: rows as unknown as JsonValue } };
}

function failed(error: unknown): Event {
  return { type: "metrics.matches.failed", data: { error: String(error) } };
}

export function createMetricsDashboardState(
  load: () => Promise<MetricMatch[]>,
  pollMs = 5_000,
): Observable<State> {
  const events$ = timer(0, pollMs).pipe(
    exhaustMap(() => from(load()).pipe(map(loaded), catchError((error) => of(failed(error))))),
  );
  return runMachine(events$, dashboardMachine).pipe(
    map((emission) => emission.state),
    shareReplay({ bufferSize: 1, refCount: true }),
  );
}
