import { groupBy, mergeMap, map, type Observable } from "rxjs";
import { runMachine } from "./2_machine";
import type { Event, FlowRef, Machine, MachineEmission } from "./0_types";
import type { JsonRxCatalog } from "./6_catalog";

export function runPartitionedMachine(
  events$: Observable<Event>,
  key: (event: Event) => string,
  machine: Machine,
): Observable<MachineEmission & { partitionKey: string }> {
  return events$.pipe(
    groupBy(key),
    mergeMap((partition$) => runMachine(partition$, machine).pipe(
      map((emission) => ({ ...emission, partitionKey: partition$.key })),
    )),
  );
}

export function runReferencedPartitionedMachine(
  events$: Observable<Event>,
  key: (event: Event) => string,
  ref: FlowRef,
  catalog: JsonRxCatalog,
): Observable<MachineEmission & { partitionKey: string }> {
  return events$.pipe(
    groupBy(key),
    mergeMap((partition$) => runMachine(partition$, catalog.machine(ref)).pipe(
      map((emission) => ({ ...emission, partitionKey: partition$.key })),
    )),
  );
}
