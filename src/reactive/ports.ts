import { invoke } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import type { StatusLink, StatusState } from "../plugin";

export interface RuntimePorts {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  open(link: StatusLink): Promise<void>;
  setRailHealth(state: StatusState): void;
}

export const runtimePorts: RuntimePorts = {
  invoke,
  fetch: (input, init) => fetch(input, init),
  open: (link) => (link.reveal ? revealItemInDir(link.path) : openPath(link.path)),
  setRailHealth: (state) => {
    const button = document.getElementById("status-toggle");
    if (button) button.dataset.health = state;
  },
};

