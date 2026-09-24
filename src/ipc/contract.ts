// The commands the ⌘-click path speaks, both directions typed. Shape matches what
// tauri-specta emits, so generated declarations can replace this file as-is.
import type { Call, Client, Contract } from "./client";
import { createClient } from "./client";
import { invoke } from "../generated/native";

export type RefSource = "touched" | "absolute" | "cwd" | "session" | "repo" | "worktree" | "ancestor" | "ignored" | "sibling" | "search" | "fuzzy";
export type ResolvedRef = { path: string; line?: number; source: RefSource };
export type ResolveResult =
  | { kind: "hit"; ref: ResolvedRef }
  | { kind: "choices"; paths: string[]; line?: number; via: "exact" | "fuzzy" | "worktree"; worktrees?: string[] }
  | { kind: "absent"; repo: string; rev: string; path: string; subject: string }
  | { kind: "miss" };

// The tmux client cell a click landed on (boop_harness::click::ClickCell).
export type ClickCell = { session: string; socket: string | null; col: number; row: number };

export type ClickContract = {
  // boop_harness::click::resolve_click. With a cell, boop finds the pane, its
  // sessions and roots; `cwd` and `sessions` are the fallback without one.
  resolve_ref: Call<{ token: string; cwd: string; sessions?: string[]; cell?: ClickCell }, ResolveResult>;
  clear_ref_index: Call<void, void>;
  read_git_blob: Call<{ repo: string; rev: string; path: string }, string>;
  // src-tauri/src/shell.rs
  run_click: Call<{ command: string; cwd: string }, string>;
};

export const CLICK_METHODS = ["resolve_ref", "clear_ref_index", "read_git_blob", "run_click"] as const;

// The Tauri adapter. A different shell (http, ws, in-process) implements the same
// two-method interface and every caller above is unchanged.
export const nativeRequestClient = {
  request: <T>(method: string, params: Record<string, unknown>) =>
    invoke<T>(method as never, params),
};

export const clickRpc: Client<ClickContract> = createClient<ClickContract>(
  CLICK_METHODS as unknown as (keyof ClickContract & string)[],
  nativeRequestClient,
);

export type { Call, Client, Contract };
