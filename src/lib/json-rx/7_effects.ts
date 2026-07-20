import { Subject, catchError, concatMap, from, of, share, type Subscription } from "rxjs";
import { runMachine } from "./2_machine";
import type {
  Effect,
  EffectInterpreter,
  EffectMachineRuntime,
  Event,
  JsonValue,
  Machine,
} from "./0_types";

function interpreterError(effect: Effect, cause: Event, error: unknown): Event {
  return {
    type: "effect.error",
    causationId: effect.id ?? cause.id,
    data: { effectId: effect.id ?? null, op: effect.op, error: String(error) } as JsonValue,
  };
}

export function createEffectMachineRuntime(
  machine: Machine,
  interpret: EffectInterpreter,
): EffectMachineRuntime {
  const input$ = new Subject<Event>();
  const emissions$ = runMachine(input$, machine).pipe(share());
  let effectSubscription: Subscription | undefined;

  effectSubscription = emissions$.pipe(
    concatMap((emission) => from(emission.effects).pipe(
      concatMap((effect) => from(interpret(effect, emission.event)).pipe(
        catchError((error) => of(interpreterError(effect, emission.event, error))),
      )),
    )),
  ).subscribe((event) => input$.next(event));

  return {
    emissions$,
    dispatch: (event) => input$.next(event),
    close: () => {
      effectSubscription?.unsubscribe();
      effectSubscription = undefined;
      input$.complete();
    },
  };
}
