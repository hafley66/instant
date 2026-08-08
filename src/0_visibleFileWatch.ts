import type { Observable, Subscription } from "rxjs";

export interface VisibleFileWatch {
  dispose(): void;
}

export function visibleFileWatch(
  visibility$: Observable<boolean>,
  claim: () => Promise<() => void>,
  onError: (error: unknown) => void = console.error,
): VisibleFileWatch {
  let release: (() => void) | undefined;
  let claiming = false;
  let visible = false;
  let disposed = false;
  let generation = 0;

  const ensureClaim = () => {
    if (disposed || !visible || claiming || release) return;
    claiming = true;
    const claimedAt = generation;
    claim()
      .then((stop) => {
        claiming = false;
        if (disposed || !visible || claimedAt !== generation) stop();
        else release = stop;
        ensureClaim();
      })
      .catch((error) => {
        claiming = false;
        onError(error);
      });
  };

  const visibility: Subscription = visibility$.subscribe((nextVisible) => {
    if (visible === nextVisible) return;
    visible = nextVisible;
    generation++;
    if (visible) {
      ensureClaim();
      return;
    }
    release?.();
    release = undefined;
  });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      visibility.unsubscribe();
      release?.();
      release = undefined;
    },
  };
}
