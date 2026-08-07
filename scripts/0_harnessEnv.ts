// Harness self-identification from the process env. Pure so vitest covers it;
// scripts/bus.ts shells around it.
import type { HarnessId } from "../src/harnessTypes";

export interface InferredHarness {
  harness: HarnessId;
  sessionId: string | null;
  model: string | null;
}

export function inferHarnessFromEnv(env: NodeJS.ProcessEnv = process.env): InferredHarness | null {
  const stamped = env.INSTANT_HARNESS;
  if (typeof stamped === "string" && stamped.length > 0) {
    return {
      harness: stamped as HarnessId,
      sessionId: env.INSTANT_SESSION_ID || null,
      model: env.INSTANT_MODEL || null,
    };
  }
  // Claude code sets CLAUDECODE + CLAUDE_CODE_SESSION_ID natively.
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_SESSION_ID) {
    return {
      harness: "claude",
      sessionId: env.CLAUDE_CODE_SESSION_ID || null,
      model: env.ANTHROPIC_MODEL || env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_DEFAULT_OPUS_MODEL || null,
    };
  }
  if (env.CODEX_THREAD_ID) {
    return {
      harness: "codex",
      sessionId: env.CODEX_THREAD_ID,
      model: null,
    };
  }
  return null;
}

// Env prefix dispatch stamps into a spawned lane so the pane self-identifies.
export function laneEnvStamp(harness: HarnessId, sessionId?: string | null, model?: string | null): string {
  const parts = [`INSTANT_HARNESS=${harness}`];
  if (sessionId) parts.push(`INSTANT_SESSION_ID=${shellWord(sessionId)}`);
  if (model) parts.push(`INSTANT_MODEL=${shellWord(model)}`);
  return parts.join(" ") + " ";
}

function shellWord(value: string): string {
  return /[^\w@%+=:,./-]/.test(value) ? `"${value.replace(/(["\\$`])/g, "\\$1")}"` : value;
}
