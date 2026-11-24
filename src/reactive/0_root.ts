import {
  EMPTY,
  Subject,
  catchError,
  map,
  mergeAll,
  takeUntil,
  tap,
  type MonoTypeOperatorFunction,
  type Observable,
  type Subscription,
} from "rxjs";

// Dataflow hop 9/10 — owned subscription runtime (src/reactive/0_root.ts).
// A flow pushed before startRoot subscribes is dropped: startRoot runs first in main().
export const root = new Subject<Observable<unknown>>();

// A flow that errors is reported and ends alone; its siblings keep running.
export function startRoot(until: Observable<unknown>): Subscription {
  return root
    .pipe(
      map((flow) =>
        flow.pipe(
          catchError((error: unknown) => {
            console.error("root flow:", error);
            return EMPTY;
          }),
        ),
      ),
      mergeAll(),
      takeUntil(until),
    )
    .subscribe();
}

// A throwing effect must not end its flow: the throw is re-raised on a later
// tick for the window error handler, as a throwing `.subscribe(fn)` callback was.
export function sink<T>(effect: (value: T) => void): MonoTypeOperatorFunction<T> {
  return tap((value) => {
    try {
      effect(value);
    } catch (error) {
      setTimeout(() => {
        throw error;
      });
    }
  });
}
