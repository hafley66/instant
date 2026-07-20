import type { Observable } from "rxjs";
import type { Event, FlowDefinition, FlowRef, Machine, MachineDefinition } from "./0_types";

export type JsonRxCatalog = {
  machine(ref: FlowRef): Machine;
  flow(ref: FlowRef, events$: Observable<Event>): Observable<Event>;
};

export function createJsonRxCatalog(
  machines: MachineDefinition[] = [],
  flows: FlowDefinition[] = [],
): JsonRxCatalog {
  const machineDefinitions = new Map(machines.map((definition) => [definition.id, definition]));
  const flowDefinitions = new Map(flows.map((definition) => [definition.id, definition]));

  return {
    machine: (ref) => {
      const definition = machineDefinitions.get(ref.ref);
      if (!definition) throw new Error(`Unknown json-rx machine: ${ref.ref}`);
      return definition.create();
    },
    flow: (ref, events$) => {
      const definition = flowDefinitions.get(ref.ref);
      if (!definition) throw new Error(`Unknown json-rx flow: ${ref.ref}`);
      return definition.run(events$);
    },
  };
}
