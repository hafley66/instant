// Pure half of the live-spawn gate (scripts/livespawn.ts). Leaf module: only
// type imports, so node's type stripping can load it straight from the driver
// script (a value import of an extensionless specifier would not resolve).
// The status buckets and the ISO formatter mirror src-tauri/src/harness.rs
// (trace_status / ms_to_iso): the driver reads the same stores the rust seam
// reads, so it must bucket them the same way.
import type { ILiveGate, ILiveSample, ILivePageSeed, SessionStatus } from "./0_types";

const LIVE_MS = 2 * 60 * 1000;
const IDLE_MS = 60 * 60 * 1000;

// HarnessTracePanel reads its ledger from here, and the page seed keys
// list_dir on the same string; one definition so a replay cannot drift.
export const MAIL_DIR = "~/.agent/mail";

export const LiveGate: ILiveGate = {
  status(cwdExists, lastMs, nowMs): SessionStatus {
    if (!cwdExists) return "dead";
    const age = Math.max(0, nowMs - lastMs);
    if (age <= LIVE_MS) return "live";
    if (age <= IDLE_MS) return "idle";
    return "done";
  },

  iso(ms) {
    return ms === 0 ? "" : new Date(ms).toISOString();
  },

  seed(sample): ILivePageSeed {
    return { mailDir: MAIL_DIR, rows: sample.rows, files: sample.files };
  },
};

export function isLiveSample(value: unknown): value is ILiveSample {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return Array.isArray(row.rows) && typeof row.at === "string" && typeof row.atMs === "number";
}
