import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// End-to-end over the real boop binary: the exact verbs the Agents panel shells
// out. Runs on a uniquely-named tmux session (killed after each case) and a
// throwaway --mail-dir, and skips cleanly when tmux is absent. Deviation from
// the busDispatch private-socket pattern: `beep lane patch` has no --socket
// flag (it always talks to the default tmux server), so the pane lives there
// under a unique name instead of a private socket; only that session is torn
// down, never the server. A `beep lane create --dry-run` asserts the documented
// private-socket spawn contract without launching a real harness.
const BOOP =
  process.env.BOOP_BIN ??
  "/Users/chrishafley/projects/sprefa/.boop-worktrees/lane/boop-rows/v6/boop/target/release/boop";

const HAVE_TMUX = (() => {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const NAME = `booptest-${process.pid}`;
const SESSION = `${NAME}-sess`;

let mailDir: string | null = null;

beforeAll(() => {
  mailDir = mkdtempSync(join(tmpdir(), "boop-e2e-"));
});

afterEach(() => {
  // kill only our uniquely-named session; leave the running server alone
  try {
    execFileSync("tmux", ["kill-session", "-t", SESSION], { stdio: "ignore" });
  } catch {
    // already gone
  }
});

afterAll(() => {
  if (mailDir) rmSync(mailDir, { recursive: true, force: true });
});

describe.skipIf(!HAVE_TMUX)("boop lane spawn + hail e2e", () => {
  it("dry-run lane create prints the literal spawn contract", () => {
    const socket = `booptest-sock-${process.pid}`;
    const r = spawnSync(
      BOOP,
      [
        "beep", "lane", "create",
        "--lane", NAME,
        "--cwd", tmpdir(),
        "--tmux", NAME,
        "--socket", socket,
        "--dry-run",
        "--mail-dir", mailDir!,
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    // dry-run surfaces the harness launch line + route identity, not the socket
    expect(r.stdout).toContain("cmd: opencode run");
    expect(r.stdout).toContain(`to: ${NAME}`);

  });

  it("patches a route, reads get/route/ps, and hails", () => {
    execFileSync("tmux", ["new-session", "-d", "-s", SESSION, "sleep 30"], {
      stdio: "ignore",
    });
    // LANE is positional after the flags in `lane patch`
    const patched = spawnSync(
      BOOP,
      ["beep", "lane", "patch", "--tmux", SESSION, "--harness", "opencode", NAME, "--mail-dir", mailDir!],
      { encoding: "utf8" },
    );
    expect(patched.status).toBe(0);

    const got = spawnSync(BOOP, ["beep", "lane", "get", NAME, "--mail-dir", mailDir!], {
      encoding: "utf8",
    });
    expect(got.status).toBe(0);
    const route = JSON.parse(got.stdout);
    expect(route.lane).toBe(NAME);
    expect(route.harness).toBe("opencode");

    const ps = spawnSync(BOOP, ["beep", "ps", NAME, "--mail-dir", mailDir!], {
      encoding: "utf8",
    });
    expect(ps.status).toBe(0);
    expect(ps.stdout).toContain(NAME);

    const hailed = spawnSync(
      BOOP,
      ["beep", "hail", NAME, "--body", "hello from instant e2e", "--mail-dir", mailDir!],
      { encoding: "utf8" },
    );
    expect(hailed.status).toBe(0);
    expect(hailed.stdout).toMatch(/queued .+ -> /);
  });
});
