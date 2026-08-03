// Live-spawn gate assertions, run over the recorded run that
// scripts/livespawn.ts writes (<scratch>/run.json, path via LIVESPAWN_RUN).
// Its own vitest config keeps it out of `vitest run`: the run it reads costs
// minutes of wall clock and real tokens (10-second law, user-named exception).
//
//   node scripts/livespawn.ts --scratch <dir>
//   LIVESPAWN_RUN=<dir>/run.json npx vitest run --config vitest.livespawn.config.ts
//
// Structure and state transitions only. No assertion reads a prompt or a body:
// the bodies are recorded in run.json for a human, never compared here.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it } from "vitest";
import { LiveState } from "../../src/plugins/harnessTrace/2_liveState";
import type { ILiveSample, ILiveSampleState } from "../../src/plugins/harnessTrace/0_types";

const RUN_PATH = process.env.LIVESPAWN_RUN ?? join(tmpdir(), "livespawn-gate", "run.json");

interface GateRun {
  claudeSessionId: string;
  childSessionId: string;
  hailId: string;
  spawnCommand: string;
  compliance: "direct" | "challenged";
  confirmations: number;
  model: { claude: string; opencode: string };
  samples: ILiveSample[];
  transcript: { step: string; exit: number | null; stdout: string; stderr: string }[];
}

let run: GateRun;
let states: ILiveSampleState[];

function stepNamed(name: string) {
  const entry = run.transcript.find((row) => row.step === name);
  if (!entry) throw new Error(`no transcript step ${name}`);
  return entry;
}

function sessionNames(lsOutput: string): string[] {
  return lsOutput
    .split("\n")
    .map((line) => line.split(":")[0].trim())
    .filter(Boolean)
    .sort();
}

beforeAll(() => {
  if (!existsSync(RUN_PATH)) {
    throw new Error(`no recorded run at ${RUN_PATH}; run scripts/livespawn.ts first`);
  }
  run = JSON.parse(readFileSync(RUN_PATH, "utf8"));
  states = run.samples.map((sample) => LiveState.read(sample));
});

describe("the run happened", () => {
  it("started claude on sonnet and opencode on the pinned cheap model", () => {
    expect(run.model.claude).toBe("sonnet");
    expect(run.model.opencode).toBe("openrouter/deepseek/deepseek-v4-flash-0731");
  });

  it("resolved both session ids and one hail id", () => {
    expect(run.claudeSessionId).toMatch(/^[0-9a-f-]{16,}$/);
    expect(run.childSessionId).toMatch(/^ses_/);
    expect(run.hailId).toMatch(/^m-/);
  });

  it("sampled the stores at least three times", () => {
    expect(run.samples.length).toBeGreaterThanOrEqual(3);
  });

  it("rendered one non-empty PNG per sample", () => {
    for (const sample of run.samples) {
      expect(existsSync(sample.png), sample.png).toBe(true);
      expect(statSync(sample.png).size).toBeGreaterThan(1000);
    }
  });
});

describe("session rows", () => {
  it("holds the hailed claude session in every sample", () => {
    for (const state of states) expect(state.parentId).toBe(run.claudeSessionId);
  });

  it("sees the parent live while it works", () => {
    expect(states.some((state) => state.parentStatus === "live")).toBe(true);
  });

  it("opens with the parent alone, no child row yet", () => {
    expect(states[0].childId).toBeNull();
    expect(states[0].sessionCount).toBe(1);
    expect(states[0].rootCount).toBe(1);
  });

  it("gains the spawned opencode session part-way through", () => {
    const first = states.findIndex((state) => state.childId !== null);
    expect(first).toBeGreaterThan(0);
    expect(states[first].childId).toBe(run.childSessionId);
    expect(states[first].sessionCount).toBe(2);
  });
});

// A claude recipient may refuse a bus hail as a suspected prompt injection: an
// unverified external instruction demanding an exact command and a one-word
// reply is the shape it is told to distrust. The gate treats that as a recorded
// outcome, not a failure, and requires the spawn either way.
describe("compliance", () => {
  it("records how the recipient answered the hail", () => {
    expect(["direct", "challenged"]).toContain(run.compliance);
  });

  it("spawns the child whichever way the hail was answered", () => {
    expect(run.childSessionId).toMatch(/^ses_/);
    expect(states[states.length - 1].childId).toBe(run.childSessionId);
  });

  it("sends at most one confirmation, and only after a challenge", () => {
    expect(run.confirmations).toBeLessThanOrEqual(1);
    expect(run.confirmations).toBe(run.compliance === "challenged" ? 1 : 0);
    const sent = run.transcript.filter((row) => row.step === "confirm-1");
    expect(sent.length).toBe(run.confirmations);
    for (const row of sent) expect(row.exit).toBe(0);
  });
});

describe("tree shape", () => {
  it("hangs the child under the parent by dispatch, never as a second root", () => {
    const withChild = states.filter((state) => state.childId !== null);
    expect(withChild.length).toBeGreaterThan(0);
    for (const state of withChild) {
      expect(state.childParentId).toBe(run.claudeSessionId);
      expect(state.childParentKind).toBe("dispatch");
      expect(state.rootCount).toBe(1);
    }
  });

  it("attributes the parent to its hailer, not to a session", () => {
    expect(states[0].parentFrom).toBe("coordinator");
  });
});

describe("state transitions", () => {
  it("moves the child from live to a settled bucket", () => {
    const child = states.filter((state) => state.childId !== null).map((state) => state.childStatus);
    expect(child[0]).toBe("live");
    expect(child[child.length - 1]).not.toBe("live");
    expect(["idle", "done"]).toContain(child[child.length - 1]);
  });

  it("fills the hail's ack after a sweep, and never unfills it", () => {
    const acked = states.map((state) => state.acked);
    expect(acked[0]).toBe(0);
    expect(acked[acked.length - 1]).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < acked.length; i += 1) expect(acked[i]).toBeGreaterThanOrEqual(acked[i - 1]);
  });

  it("acks only after a targeted cass index, and reports it", () => {
    expect(stepNamed("cass-index-1").exit).toBe(0);
    const sweeps = run.transcript.filter((row) => row.step.startsWith("sweep-"));
    expect(sweeps.length).toBeGreaterThanOrEqual(1);
    expect(sweeps.some((row) => /acked [1-9]/.test(row.stdout))).toBe(true);
  });

  it("never loses a session row once it appears", () => {
    const counts = states.map((state) => state.sessionCount);
    for (let i = 1; i < counts.length; i += 1) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
  });
});

describe("teardown", () => {
  it("killed the gate's own tmux server", () => {
    expect(stepNamed("kill-gate").exit).toBe(0);
    const after = stepNamed("gate-socket-after");
    expect(after.exit).not.toBe(0);
    expect(`${after.stdout}${after.stderr}`).toMatch(/no server running/);
  });

  it("left the default socket's sessions exactly as it found them", () => {
    const before = sessionNames(stepNamed("default-socket-before").stdout);
    const after = sessionNames(stepNamed("default-socket-after").stdout);
    expect(before.length).toBeGreaterThan(0);
    expect(after).toEqual(before);
  });
});
