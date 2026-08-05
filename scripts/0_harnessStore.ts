import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type HarnessStoreSession = {
  id: string;
  harness: "claude" | "opencode" | "codex" | "kimi";
  cwd: string;
  sourcePath: string | null;
  title: string | null;
  model: string | null;
  inputTokens: number | null;
  parentId: string | null;
  parentKind: "subagent" | null;
  createdAtMs: number;
  lastActivityMs: number;
};

function candidates(): string[] {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return [
    process.env.INSTANT_HARNESS_BIN,
    join(root, "src-tauri/target/debug/instant-harness"),
    join(root, "src-tauri/target/release/instant-harness"),
    join(dirname(process.execPath), "instant-harness"),
  ].filter((path): path is string => typeof path === "string" && path.length > 0);
}

export function harnessStoreBinary(): string | null {
  return candidates().find(existsSync) ?? null;
}

export function parseHarnessSession(output: string): HarnessStoreSession | null {
  return JSON.parse(output) as HarnessStoreSession | null;
}

export function resolveHarnessSession(harness: string, cwd: string): HarnessStoreSession | null {
  const binary = harnessStoreBinary();
  if (!binary) throw new Error("instant-harness binary not found; run `cargo build --manifest-path src-tauri/Cargo.toml --bin instant-harness`");
  const result = spawnSync(binary, ["resolve", "--harness", harness, "--cwd", cwd], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `instant-harness exited ${result.status}`);
  return parseHarnessSession(result.stdout);
}

export function harnessInputTokens(harness: string, cwd: string): number | null {
  try {
    return resolveHarnessSession(harness, cwd)?.inputTokens ?? null;
  } catch {
    return null;
  }
}
