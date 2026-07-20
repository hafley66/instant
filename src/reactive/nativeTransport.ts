import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export interface NativeTransport {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const browserE2e =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("e2e");

function browserE2eInvoke<T>(command: string): Promise<T> {
  const w = window as Window & { __instantE2eNativeCalls?: string[] };
  (w.__instantE2eNativeCalls ??= []).push(command);
  if (command === "read_image") {
    return Promise.resolve(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" as T,
    );
  }
  return Promise.resolve(undefined as T);
}

// The only Tauri IPC edge. Application modules import the generated native
// contract, so replacing the desktop shell means replacing this adapter.
export const nativeTransport: NativeTransport = {
  invoke: (command, args) => browserE2e ? browserE2eInvoke(command) : tauriInvoke(command, args),
};
