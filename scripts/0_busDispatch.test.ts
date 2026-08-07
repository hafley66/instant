import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// dispatch spawns a real tmux session, so these run against a private socket and
// tear it down; without tmux on PATH they skip rather than fail.
const BUS = join(import.meta.dirname, "bus.ts");
const HAVE_TMUX = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let socket: string | null = null;

function dispatch(mailDir: string, name: string, env: Record<string, string>) {
  socket = `bustest-${process.pid}-${name}`;
  // Exit 2 is the documented "appended but not resolved" code, which is what a
  // fresh temp cwd with no opencode session yields; the route is the assertion.
  const result = spawnSync(
    process.execPath,
    [
      BUS, "dispatch",
      "--to", name,
      "--cwd", tmpdir(),
      "--harness", "opencode",
      "--tmux", name,
      "--socket", socket,
      "--cmd", "sleep 30",
      "--resolve-wait", "0",
      "--mail-dir", mailDir,
    ],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
  return result.stdout;
}

function routeOf(mailDir: string, name: string) {
  return JSON.parse(readFileSync(join(mailDir, "registry.json"), "utf8"))[name];
}

afterEach(() => {
  if (socket) {
    try {
      execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
    } catch {
      // already gone
    }
    socket = null;
  }
});

describe.skipIf(!HAVE_TMUX)("bus dispatch route identity", () => {
  it("leaves the lane's sessionId unset when the CALLER is a claude session", () => {
    const mailDir = mkdtempSync(join(tmpdir(), "bus-dispatch-"));
    try {
      dispatch(mailDir, "lane_a", {
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "coordinator-session-id",
      });
      const route = routeOf(mailDir, "lane_a");
      expect(route.harness).toBe("opencode");
      expect(route.sessionId).toBeUndefined();
    } finally {
      rmSync(mailDir, { recursive: true, force: true });
    }
  });

  it("keeps an explicitly passed --session-id", () => {
    const mailDir = mkdtempSync(join(tmpdir(), "bus-dispatch-"));
    try {
      const args = [
        BUS, "dispatch", "--to", "lane_b", "--cwd", tmpdir(), "--harness", "opencode",
        "--tmux", "lane_b", "--socket", `bustest-${process.pid}-lane_b`,
        "--cmd", "sleep 30", "--resolve-wait", "0", "--session-id", "ses_explicit",
        "--mail-dir", mailDir,
      ];
      socket = `bustest-${process.pid}-lane_b`;
      spawnSync(process.execPath, args, { encoding: "utf8" });
      expect(routeOf(mailDir, "lane_b").sessionId).toBe("ses_explicit");
    } finally {
      rmSync(mailDir, { recursive: true, force: true });
    }
  });

  it("does not stamp the caller's session id into the lane's own env", () => {
    const mailDir = mkdtempSync(join(tmpdir(), "bus-dispatch-"));
    try {
      dispatch(mailDir, "lane_c", {
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "coordinator-session-id",
      });
      const pane = execFileSync(
        "tmux",
        ["-L", socket!, "list-panes", "-t", "lane_c", "-F", "#{pane_start_command}"],
        { encoding: "utf8" },
      );
      expect(pane).toContain("INSTANT_HARNESS=opencode");
      expect(pane).not.toContain("coordinator-session-id");
    } finally {
      rmSync(mailDir, { recursive: true, force: true });
    }
  });
});
