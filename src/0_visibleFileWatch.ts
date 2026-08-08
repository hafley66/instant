import { distinctUntilChanged, EMPTY, Observable, switchMap } from "rxjs";

function claimedFileWatch$(claim: () => Promise<() => void>): Observable<void> {
  return new Observable<void>((subscriber) => {
    let release: (() => void) | undefined;
    let disposed = false;
    claim()
      .then((stop) => {
        if (disposed) stop();
        else {
          release = stop;
          subscriber.next();
        }
      })
      .catch((error) => subscriber.error(error));
    return () => {
      disposed = true;
      release?.();
    };
  });
}

export function visibleFileWatch$(
  visibility$: Observable<boolean>,
  claim: () => Promise<() => void>,
): Observable<void> {
  return visibility$.pipe(
    distinctUntilChanged(),
    switchMap((visible) => (visible ? claimedFileWatch$(claim) : EMPTY)),
  );
}
