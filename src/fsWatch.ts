import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "./generated/native";

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
  return () => {
    unlisten?.();
    void invoke("fs_watch_release", { claimId }).catch(console.error);
  };
}
