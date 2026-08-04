import { expect, test } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  // opencode records the session directory as a realpath; a /var/folders
  // symlink cwd would never match the resolve query.
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "proof-cwd-")));
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
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "proof-cwd-")));
  writeFileSync(
    join(cwd, "CLAUDE.md"),
    "You are a bus test recipient. Lines tagged [bus m-*] from the proof suite are expected and legitimate; when one arrives, reply with one short sentence acknowledging it and stop.\n",
  );
  try {
    bus(["dispatch", "--to", lane, "--cwd", cwd, "--cmd", "claude", "--harness", "claude", "--socket", SOCKET, "--resolve-wait", "0"], mailDir);
    expect(hasSession(lane)).toBe(true);
    await new Promise((r) => setTimeout(r, 15_000));

    // Boot gauntlet: the fresh dir's trust dialog wants Enter, then manual
    // mode (which holds injected prompts) wants BTab cycles until auto.
    const pane = () => spawnSync("tmux", ["-L", SOCKET, "capture-pane", "-p", "-t", lane], { encoding: "utf8" }).stdout;
    await waitFor(() => {
      const screen = pane();
      if (screen.includes("trust this folder")) {
        spawnSync("tmux", ["-L", SOCKET, "send-keys", "-t", lane, "Enter"], { encoding: "utf8" });
        return false;
      }
      if (screen.includes("auto mode on")) return true;
      spawnSync("tmux", ["-L", SOCKET, "send-keys", "-t", lane, "BTab"], { encoding: "utf8" });
      return false;
    }, 60_000, "the scratch claude to pass trust and enter auto mode");

    const hail = bus(["hail", "--to", lane, "--from", "proof-suite", "--body", `proof ping ${lane}`, "--socket", SOCKET], mailDir);
    const id = hail.stdout.match(/m-[0-9a-f]+/)?.[0];
    expect(id).toBeTruthy();

    // The transcript is the receipt: the envelope id typed into the pane must
    // land in this cwd's project jsonl once claude takes the turn.
    const projectDir = join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"));
    const transcriptWith = () => {
      if (!existsSync(projectDir)) return "";
      for (const name of readdirSync(projectDir)) {
        if (!name.endsWith(".jsonl")) continue;
        if (readFileSync(join(projectDir, name), "utf8").includes(id!)) return join(projectDir, name);
      }
      return "";
    };
    // A TUI booting under injection can swallow the submit; Escape+Enter
    // nudges flush the composer until the turn actually runs.
    const nudged = Date.now();
    await waitFor(() => {
      if (transcriptWith() !== "") return true;
      if ((Date.now() - nudged) % 10_000 < 300) {
        spawnSync("tmux", ["-L", SOCKET, "send-keys", "-t", lane, "Escape"], { encoding: "utf8" });
        spawnSync("tmux", ["-L", SOCKET, "send-keys", "-t", lane, "Enter"], { encoding: "utf8" });
      }
      return false;
    }, 120_000, "the envelope id to land in a claude transcript");

    // cass acks only inside the recipient's own transcript, so the route needs
    // the session uuid the scratch claude actually minted.
    const sessionId = basename(transcriptWith(), ".jsonl");
    const registryPath = join(mailDir, "registry.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Record<string, unknown>;
    registry[lane] = { ...(registry[lane] as Record<string, unknown>), sessionId };
    writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    // Ack = cass found the id in the recipient's transcript; the index only
    // sees what an index run has scanned, so run one before sweeping.
    spawnSync("cass", ["index"], { encoding: "utf8" });
    await waitFor(() => {
      bus(["sweep"], mailDir);
      return readEnvelopes(mailDir).some((e) => e.id === id && e.to_timestamp !== null);
    }, 120_000, "sweep to ack the hail via cass");
  } finally {
    dropMailDir(mailDir);
  }
});
