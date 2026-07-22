import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export interface NativeTransport {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const browserE2e =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("e2e");

type E2eWindow = Window & {
  __instantE2eNativeCalls?: string[];
  __instantE2eNativeResults?: Record<string, unknown>;
};

function browserE2eInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const w = window as E2eWindow;
  (w.__instantE2eNativeCalls ??= []).push(command);
  const table = w.__instantE2eNativeResults;
  if (table && command in table) {
    const v = table[command];
    // A fixture may be a function of the invoke args, so an e2e can vary results
    // per call (e.g. resolve a session only for one editor) without per-command
    // branching here.
    return Promise.resolve(
      (typeof v === "function" ? v(args) : v) as T,
    );
  }
  if (command === "read_image") {
    return Promise.resolve(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" as T,
    );
  }
  if (command === "rules_get") return Promise.resolve([] as T);
  if (command === "activity_rule_matches") return Promise.resolve([] as T);
  if (command === "watcher_status") {
    return Promise.resolve({ last_heartbeat: 0, config_revision: 0, rules_count: 0 } as T);
  }
  return Promise.resolve(undefined as T);
}

// The only Tauri IPC edge. Application modules import the generated native
// contract, so replacing the desktop shell means replacing this adapter.
export const nativeTransport: NativeTransport = {
  invoke: (command, args) => browserE2e ? browserE2eInvoke(command, args) : tauriInvoke(command, args),
};
