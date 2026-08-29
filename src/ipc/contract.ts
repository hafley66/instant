// The commands the ⌘-click path speaks, both directions typed. Shape matches what
// tauri-specta emits, so generated declarations can replace this file as-is.
import type { Call, Client, Contract } from "./client";
import { createClient } from "./client";
import { nativeTransport } from "../reactive/nativeTransport";

export type RefSource = "absolute" | "cwd" | "repo" | "ancestor" | "search" | "fuzzy";
export type ResolvedRef = { path: string; line?: number; source: RefSource };
export type ResolveResult =
  | { kind: "hit"; ref: ResolvedRef }
  | { kind: "choices"; paths: string[]; line?: number; via: "exact" | "fuzzy" }
  | { kind: "miss" };

export type ClickContract = {
  // src-tauri/src/refresolve.rs
  resolve_ref: Call<{ token: string; cwd: string }, ResolveResult>;
  clear_ref_index: Call<void, void>;
  // src-tauri/src/shell.rs
  run_click: Call<{ command: string; cwd: string }, string>;
};

export const CLICK_METHODS = ["resolve_ref", "clear_ref_index", "run_click"] as const;

// The Tauri adapter. A different shell (http, ws, in-process) implements the same
// two-method interface and every caller above is unchanged.
export const tauriTransport = {
  request: <T>(method: string, params: Record<string, unknown>) =>
    nativeTransport.invoke<T>(method as never, params),
};

export const clickRpc: Client<ClickContract> = createClient<ClickContract>(
  CLICK_METHODS as unknown as (keyof ClickContract & string)[],
  tauriTransport,
);

export type { Call, Client, Contract };
