import { distinctUntilChanged, Observable } from "rxjs";

export interface VisiblePanelApi {
  readonly isVisible: boolean;
  onDidVisibilityChange(listener: (event: { isVisible: boolean }) => void): { dispose(): void };
}

export function panelApiVisibility$(panel: VisiblePanelApi | null | undefined): Observable<boolean> {
  return new Observable<boolean>((subscriber) => {
    if (!panel) {
      subscriber.next(false);
      subscriber.complete();
      return;
    }
    subscriber.next(panel.isVisible);
    const visibility = panel.onDidVisibilityChange(({ isVisible }) => subscriber.next(isVisible));
    return () => visibility.dispose();
  }).pipe(distinctUntilChanged());
}
