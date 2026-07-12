import { invoke as tauriInvoke } from "@tauri-apps/api/core";

export interface NativeTransport {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

// The only Tauri IPC edge. Application modules import the generated native
// contract, so replacing the desktop shell means replacing this adapter.
export const nativeTransport: NativeTransport = {
  invoke: (command, args) => tauriInvoke(command, args),
};
