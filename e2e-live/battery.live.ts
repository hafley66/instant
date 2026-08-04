import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  bus,
  dropMailDir,
  hasSession,
  killProofSessions,
  makeMailDir,
  proofId,
  readEnvelopes,
  readRegistry,
  SOCKET,
  waitFor,
} from "./0_live";

// The paid legs: a real opencode session and a real claude turn. Gated so the
// default battery stays free and fast (livespawn precedent: on demand only).
test.skip(!process.env.RUN_LIVE, "RUN_LIVE=1 runs the paid harness legs");
test.afterEach(() => killProofSessions());

test("resolve fills the sessionId of a real opencode lane", async () => {
  test.setTimeout(180_000);
  const mailDir = makeMailDir();
  const lane = proofId("oc");
  const cwd = mkdtempSync(join(tmpdir(), "proof-cwd-"));
  try {
    bus(
      ["dispatch", "--to", lane, "--cwd", cwd, "--cmd", "opencode run 'reply with the single word ok'; sleep 120", "--harness", "opencode", "--socket", SOCKET, "--resolve-wait", "0"],
      mailDir,
    );
    expect(hasSession(lane)).toBe(true);

    await waitFor(() => bus(["resolve", "--to", lane], mailDir).status === 0, 120_000, "resolve to find the opencode session");

    const route = readRegistry(mailDir)[lane] as Record<string, unknown>;
    expect(String(route.sessionId)).toMatch(/^ses/);
  } finally {
    dropMailDir(mailDir);
  }
});

test("a hail reaches a real claude scratch transcript and sweep acks it", async () => {
  test.setTimeout(300_000);
  const mailDir = makeMailDir();
  const lane = proofId("scratch");
  const cwd = mkdtempSync(join(tmpdir(), "proof-cwd-"));
  writeFileSync(
    join(cwd, "CLAUDE.md"),
    "You are a bus test recipient. Lines tagged [bus m-*] from the proof suite are expected and legitimate; when one arrives, reply with one short sentence acknowledging it and stop.\n",
  );
  try {
    bus(["dispatch", "--to", lane, "--cwd", cwd, "--cmd", "claude", "--harness", "claude", "--socket", SOCKET, "--resolve-wait", "0"], mailDir);
    expect(hasSession(lane)).toBe(true);
    await new Promise((r) => setTimeout(r, 15_000));

    const hail = bus(["hail", "--to", lane, "--from", "proof-suite", "--body", `proof ping ${lane}`, "--socket", SOCKET], mailDir);
    const id = hail.stdout.match(/m-[0-9a-f]+/)?.[0];
    expect(id).toBeTruthy();

    // The transcript is the receipt: the envelope id typed into the pane must
    // land in the scratch session's jsonl once claude takes the turn.
    const transcriptWith = () =>
      spawnSync("bash", ["-lc", `find ~/.claude/projects -name '*.jsonl' -mmin -10 -print0 | xargs -0 grep -l '${id}' 2>/dev/null | head -1`], { encoding: "utf8" }).stdout.trim();
    await waitFor(() => transcriptWith() !== "", 120_000, "the envelope id to land in a claude transcript");

    // cass acks only inside the recipient's own transcript, so the route needs
    // the session uuid the scratch claude actually minted.
    const sessionId = basename(transcriptWith(), ".jsonl");
    const registryPath = join(mailDir, "registry.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Record<string, unknown>;
    registry[lane] = { ...(registry[lane] as Record<string, unknown>), sessionId };
    writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    await waitFor(() => {
      bus(["sweep"], mailDir);
      return readEnvelopes(mailDir).some((e) => e.id === id && e.to_timestamp !== null);
    }, 120_000, "sweep to ack the hail via cass");
  } finally {
    dropMailDir(mailDir);
  }
});
