import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "./generated/native";
import { defer, finalize, from, Subject, switchMap, type Observable } from "rxjs";

export interface FsWatchEvent {
  claimId: string;
  path: string;
  kind: string;
}

export async function claimFsWatch(
  path: string,
  onChange: (event: FsWatchEvent) => void,
  recursive = false,
  signal?: AbortSignal,
): Promise<() => void> {
  if (new URLSearchParams(window.location.search).has("e2e")) return () => {};
  const claimId = crypto.randomUUID();
  let unlisten: UnlistenFn | undefined;
  try {
    unlisten = await listen<FsWatchEvent>("fs-watch", ({ payload }) => {
      if (payload.claimId === claimId) onChange(payload);
    });
    await invoke("fs_watch_claim", { claimId, path, recursive });
  } catch (error) {
    unlisten?.();
    throw error;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    signal?.removeEventListener("abort", release);
    unlisten?.();
    void invoke("fs_watch_release", { claimId }).catch(console.error);
  };
  if (signal?.aborted) release();
  else signal?.addEventListener("abort", release, { once: true });
  return release;
}

export function fsWatch$(path: string, recursive = false): Observable<FsWatchEvent> {
  return defer(() => {
    const controller = new AbortController();
    const events = new Subject<FsWatchEvent>();
    return from(claimFsWatch(path, (event) => events.next(event), recursive, controller.signal)).pipe(
      switchMap(() => events),
      finalize(() => {
        controller.abort();
        events.complete();
      }),
    );
  });
}
