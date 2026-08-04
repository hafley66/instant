// Shared edges for the live suite: a private tmux socket, the real bus CLI
// against a per-test mail dir, and the page wiring that serves the real files.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

export const SOCKET = "instant-proof";
const HERE = dirname(fileURLToPath(import.meta.url));
const BUS = join(HERE, "..", "scripts", "bus.ts");

export function tmux(args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function hasSession(name: string): boolean {
  return tmux(["has-session", "-t", `=${name}`]).status === 0;
}

export function listSessionNames(): string[] {
  const r = tmux(["list-sessions", "-F", "#{session_name}"]);
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : [];
}

export function clientCount(name: string): number {
  const r = tmux(["list-clients", "-t", `=${name}`, "-F", "#{client_tty}"]);
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean).length : 0;
}

// Every proof lane id carries the proof- prefix so cleanup can target them.
export function proofId(tag: string): string {
  return `proof-${tag}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

export function killSession(name: string): void {
  tmux(["kill-session", "-t", `=${name}`]);
}

export function killProofSessions(): void {
  for (const name of listSessionNames()) {
    if (name.startsWith("proof-")) tmux(["kill-session", "-t", `=${name}`]);
  }
}

export function bus(args: string[], mailDir: string): { status: number; stdout: string } {
  const r = spawnSync("node", [BUS, ...args, "--mail-dir", mailDir], { encoding: "utf8" });
  return { status: r.status ?? 1, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

export function makeMailDir(): string {
  return mkdtempSync(join(tmpdir(), "proof-mail-"));
}

export function dropMailDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function readEnvelopes(mailDir: string): Record<string, unknown>[] {
  const path = join(mailDir, "bus.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function readRegistry(mailDir: string): Record<string, unknown> {
  const path = join(mailDir, "registry.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : {};
}

// A real tmux client attached to a lane, riding `script` for the tty. Killing
// it is what closing a viewer pty does; the lane must survive that.
export function attachClient(name: string): ChildProcess {
  return spawn("script", ["-q", "/dev/null", "tmux", "-L", SOCKET, "attach-session", "-t", `=${name}`], {
    stdio: "ignore",
  });
}

export async function waitFor(check: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// The page's invoke table, served by THIS process: tmux and the mail dir are
// real, only the transport is the exposed binding.
export async function wireRealNative(page: Page, mailDir: string): Promise<void> {
  await page.exposeFunction("__realNative", (command: string, args?: Record<string, unknown>) => {
    const mapPath = (p: string) => p.replace(/^~\/\.agent\/mail/, mailDir);
    if (command === "list_sessions") {
      return listSessionNames().map((name) => ({
        name, windows: 1, attached: false, activity: 0, created: 0, paths: [], commands: [],
      }));
    }
    if (command === "list_dir") {
      const dir = mapPath(String(args?.path ?? ""));
      if (!existsSync(dir)) throw new Error(`no such dir: ${dir}`);
      return {
        entries: readdirSync(dir).map((name) => ({
          name,
          path: `${String(args?.path)}/${name}`,
          is_dir: statSync(join(dir, name)).isDirectory(),
        })),
      };
    }
    if (command === "read_text") return readFileSync(mapPath(String(args?.path ?? "")), "utf8");
    if (command === "kill_session") {
      tmux(["kill-session", "-t", `=${String(args?.name ?? "")}`]);
      return null;
    }
    if (command === "harness_trace_rows") return [];
    return undefined;
  });
  await page.addInitScript(() => {
    const real = (cmd: string) => (args?: Record<string, unknown>) =>
      (window as Window & { __realNative?: (c: string, a?: Record<string, unknown>) => Promise<unknown> })
        .__realNative!(cmd, args);
    (window as Window & { __instantE2eNativeResults?: Record<string, unknown> }).__instantE2eNativeResults = {
      harness_trace_rows: real("harness_trace_rows"),
      list_sessions: real("list_sessions"),
      list_dir: real("list_dir"),
      read_text: real("read_text"),
      kill_session: real("kill_session"),
    };
  });
}
