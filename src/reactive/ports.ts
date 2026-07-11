import { invoke } from "../generated/native";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { StatusLink, StatusState } from "../plugin";

export interface RuntimePorts {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  abortSignal(ms: number): AbortSignal;
  open(link: StatusLink): Promise<void>;
  setRailHealth(state: StatusState): void;
}

export const runtimePorts: RuntimePorts = {
  invoke,
  abortSignal: (ms) => AbortSignal.timeout(ms),
  open: (link) => (link.reveal ? revealItemInDir(link.path) : openPath(link.path)),
  setRailHealth: (state) => {
    const button = document.getElementById("status-toggle");
    if (button) button.dataset.health = state;
  },
};
