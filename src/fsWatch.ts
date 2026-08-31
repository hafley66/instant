import { invoke } from "./generated/native";
import { listenNativeEvent, type NativeUnlistenFn } from "./reactive/nativeTransport";

export interface FsWatchEvent {
  claimId: string;
  path: string;
  kind: string;
}

export async function claimFsWatch(
  path: string,
  onChange: (event: FsWatchEvent) => void,
  recursive = false,
): Promise<() => void> {
  if (new URLSearchParams(window.location.search).has("e2e")) return () => {};
  const claimId = crypto.randomUUID();
  let unlisten: NativeUnlistenFn | undefined;
  try {
    unlisten = await listenNativeEvent<FsWatchEvent>("fs-watch", ({ payload }) => {
      if (payload.claimId === claimId) onChange(payload);
    });
    await invoke("fs_watch_claim", { claimId, path, recursive });
  } catch (error) {
    unlisten?.();
    throw error;
  }
  return () => {
    unlisten?.();
    void invoke("fs_watch_release", { claimId }).catch(console.error);
  };
}
