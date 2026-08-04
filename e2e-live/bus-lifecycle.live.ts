import { expect, test } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachClient,
  bus,
  clientCount,
  dropMailDir,
  hasSession,
  killProofSessions,
  killSession,
  makeMailDir,
  proofId,
  readEnvelopes,
  readRegistry,
  SOCKET,
  waitFor,
} from "./0_live";

// Layer A of the live suite: the bus CLI against real tmux on the private
// socket, no browser. Every test tears its proof- sessions down.
test.afterEach(() => killProofSessions());

test("dispatch mints a real tmux session, a registry route, and a dispatch envelope", () => {
  const mailDir = makeMailDir();
  const lane = proofId("mint");
  const cwd = mkdtempSync(join(tmpdir(), "proof-cwd-"));
  try {
    bus(
      ["dispatch", "--to", lane, "--cwd", cwd, "--cmd", "sleep 300", "--harness", "shell", "--socket", SOCKET, "--resolve-wait", "0"],
      mailDir,
    );

    expect(hasSession(lane)).toBe(true);

    const route = readRegistry(mailDir)[lane] as Record<string, unknown>;
    expect(route).toMatchObject({ harness: "shell", tmux: lane, cwd });

    const envelopes = readEnvelopes(mailDir);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({ to: lane, kind: "dispatch", to_timestamp: null });
  } finally {
    dropMailDir(mailDir);
  }
});

test("a second dispatch to a living lane id fails and appends nothing", () => {
  const mailDir = makeMailDir();
  const lane = proofId("dup");
  const cwd = mkdtempSync(join(tmpdir(), "proof-cwd-"));
  try {
    bus(["dispatch", "--to", lane, "--cwd", cwd, "--cmd", "sleep 300", "--harness", "shell", "--socket", SOCKET, "--resolve-wait", "0"], mailDir);
    const second = bus(
      ["dispatch", "--to", lane, "--cwd", cwd, "--cmd", "sleep 300", "--harness", "shell", "--socket", SOCKET, "--resolve-wait", "0"],
      mailDir,
    );

    expect(second.status).toBe(1);
    expect(second.stdout).toContain("tmux new-session failed");
    expect(hasSession(lane)).toBe(true);
    expect(readEnvelopes(mailDir)).toHaveLength(1);
  } finally {
    dropMailDir(mailDir);
  }
});

test("resolve exits 2 while no opencode session exists for the lane cwd", () => {
  const mailDir = makeMailDir();
  const lane = proofId("res");
  const cwd = mkdtempSync(join(tmpdir(), "proof-cwd-"));
  try {
    const dispatch = bus(
      ["dispatch", "--to", lane, "--cwd", cwd, "--cmd", "sleep 300", "--harness", "opencode", "--socket", SOCKET, "--resolve-wait", "0"],
      mailDir,
    );

    expect(dispatch.status).toBe(2);
    expect(dispatch.stdout).toContain(`unresolved ${lane}: no opencode session`);
    const route = readRegistry(mailDir)[lane] as Record<string, unknown>;
    expect(route.sessionId ?? "").toBe("");
  } finally {
    dropMailDir(mailDir);
  }
});

test("sweep leaves an envelope no transcript ever quoted unacked", () => {
  const mailDir = makeMailDir();
  const lane = proofId("ack");
  const cwd = mkdtempSync(join(tmpdir(), "proof-cwd-"));
  try {
    bus(["dispatch", "--to", lane, "--cwd", cwd, "--cmd", "sleep 300", "--harness", "shell", "--socket", SOCKET, "--resolve-wait", "0"], mailDir);
    const sweep = bus(["sweep"], mailDir);

    expect(sweep.stdout).toContain("acked 0");
    expect(readEnvelopes(mailDir).at(-1)).toMatchObject({ to: lane, to_timestamp: null });
  } finally {
    dropMailDir(mailDir);
  }
});

test("a watcher client detaching leaves the lane running (viewer close = detach law)", async () => {
  const mailDir = makeMailDir();
  const lane = proofId("det");
  const cwd = mkdtempSync(join(tmpdir(), "proof-cwd-"));
  try {
    bus(["dispatch", "--to", lane, "--cwd", cwd, "--cmd", "sleep 300", "--harness", "shell", "--socket", SOCKET, "--resolve-wait", "0"], mailDir);
    expect(hasSession(lane)).toBe(true);

    const client = attachClient(lane);
    await waitFor(() => clientCount(lane) === 1, 10_000, "the watcher client to attach");

    client.kill("SIGTERM");
    await waitFor(() => clientCount(lane) === 0, 10_000, "the watcher client to drop");
    expect(hasSession(lane)).toBe(true);
  } finally {
    dropMailDir(mailDir);
  }
});

test("killing the lane's tmux is terminal: has-session refuses and re-dispatch works", () => {
  const mailDir = makeMailDir();
  const lane = proofId("kill");
  const cwd = mkdtempSync(join(tmpdir(), "proof-cwd-"));
  try {
    bus(["dispatch", "--to", lane, "--cwd", cwd, "--cmd", "sleep 300", "--harness", "shell", "--socket", SOCKET, "--resolve-wait", "0"], mailDir);
    expect(hasSession(lane)).toBe(true);

    expect(bus(["dispatch", "--to", lane, "--cwd", cwd, "--cmd", "sleep 300", "--harness", "shell", "--socket", SOCKET, "--resolve-wait", "0"], mailDir).status).toBe(1);

    killSession(lane);
    expect(hasSession(lane)).toBe(false);

    bus(["dispatch", "--to", lane, "--cwd", cwd, "--cmd", "sleep 300", "--harness", "shell", "--socket", SOCKET, "--resolve-wait", "0"], mailDir);
    expect(hasSession(lane)).toBe(true);
    expect(readEnvelopes(mailDir).filter((e) => e.kind === "dispatch")).toHaveLength(2);
  } finally {
    dropMailDir(mailDir);
  }
});
