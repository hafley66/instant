import {
  EMPTY,
  Observable,
  Subject,
  catchError,
  defer,
  exhaustMap,
  filter,
  finalize,
  from,
  merge,
  share,
  takeUntil,
} from "rxjs";
import { settings } from "./0_settings";
import { paths as apiPaths } from "./generated/api";
import { invoke } from "./generated/native";
import {
  applyWorktreeDeltaRows,
  queryWorktreeSnapshot,
  type WorktreeDelta,
} from "./ghcacheSnapshot";
import { sink } from "./reactive/0_root";
import { store, type WorktreeRow } from "./state";

export const worktreeScanRequested = new Subject<void>();
export const worktreePanelShown = new Subject<void>();
export const worktreeScanSettled = new Subject<void>();

// Drop auto-discovered rows a real scan now covers: left in autoWorktrees they
// become stale duplicates whose branch and dirty state no longer update.
function pruneAutoWorktrees(scanned: WorktreeRow[]) {
  const found = new Set(scanned.map((w) => w.worktree));
  const cur = settings.autoWorktrees.$();
  if (cur.some((w) => found.has(w.worktree))) {
    settings.autoWorktrees.$(cur.filter((w) => !found.has(w.worktree)));
  }
}

// ghcacher's SSE stream, filtered to worktree deltas. A hard error completes it,
// so the next ghcache snapshot reconnects.
function worktreeDeltas(): Observable<WorktreeDelta> {
  return new Observable<WorktreeDelta>((subscriber) => {
    const es = apiPaths.events.connect();
    es.onmessage = (ev) => {
      let msg: WorktreeDelta & { entity_type?: string };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.entity_type === "worktree") subscriber.next(msg);
    };
    es.onerror = () => subscriber.complete();
    return () => es.close();
  }).pipe(catchError(() => EMPTY));
}

// Rows come from the ghcacher daemon (HTTP snapshot, then SSE deltas) when it is
// running, else from the local Rust git scan. A scan in flight swallows requests.
export function worktreeScanFlow(): Observable<unknown> {
  return defer(() => {
    const snapshots = merge(
      worktreeScanRequested,
      worktreePanelShown.pipe(takeUntil(worktreeScanSettled)),
    ).pipe(
      exhaustMap(() => {
        const root = settings.scanRoot.$().trim();
        return from(
          queryWorktreeSnapshot(() =>
            invoke<WorktreeRow[]>("scan_worktrees", { roots: root ? [root] : [], maxDepth: null }),
          ),
        ).pipe(
          sink((snapshot) => {
            store.set({ worktrees: snapshot.rows });
            pruneAutoWorktrees(snapshot.rows);
          }),
          catchError((error: unknown) => {
            console.error("scan_worktrees:", error);
            return EMPTY;
          }),
          finalize(() => worktreeScanSettled.next()),
        );
      }),
      share(),
    );
    return merge(
      snapshots,
      snapshots.pipe(
        filter((snapshot) => snapshot.source === "ghcache"),
        exhaustMap(() => worktreeDeltas()),
        sink((delta) => store.set({ worktrees: applyWorktreeDeltaRows(store.get().worktrees, delta) })),
      ),
    );
  });
}
