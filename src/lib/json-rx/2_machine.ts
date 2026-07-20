import { filter, map, scan, type Observable, type OperatorFunction } from "rxjs";
import { applyStateUpdates } from "./1_state";
import type { Event, Machine, MachineEmission } from "./0_types";

type Accumulator = {
  event?: Event;
  state: Machine["initial"];
  events: Event[];
  effects: MachineEmission["effects"];
};

export function runMachine(events$: Observable<Event>, machine: Machine): Observable<MachineEmission> {
  return events$.pipe(
    scan< Event, Accumulator>((accumulator, event) => {
      const transition = machine.transition(accumulator.state, event);
      return {
        event,
        state: applyStateUpdates(accumulator.state, transition.updates),
        events: transition.events ?? [],
        effects: transition.effects ?? [],
      };
    }, {
      state: machine.initial,
      events: [],
      effects: [],
    }),
    filter((result): result is MachineEmission => result.event !== undefined),
    map((result) => ({
      event: result.event,
      state: result.state,
      events: result.events,
      effects: result.effects,
    })),
  );
}

export function machineOperator(machine: Machine): OperatorFunction<Event, MachineEmission> {
  return (events$) => runMachine(events$, machine);
}
