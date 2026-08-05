import { describe, expect, it } from "vitest";
import { inferHarnessFromEnv, laneEnvStamp } from "./0_harnessEnv";

describe("inferHarnessFromEnv", () => {
  it("recognizes claude code from CLAUDECODE + session id and lifts model", () => {
    const got = inferHarnessFromEnv({
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "abc-123",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2[1m]",
    });
    expect(got).toEqual({ harness: "claude", sessionId: "abc-123", model: "glm-5.2[1m]" });
  });

  it("recognizes claude code from the session id alone", () => {
    expect(inferHarnessFromEnv({ CLAUDE_CODE_SESSION_ID: "x" })).toEqual({
      harness: "claude",
      sessionId: "x",
      model: null,
    });
  });

  it("prefers our INSTANT_HARNESS stamp over the claude native marker", () => {
    const got = inferHarnessFromEnv({
      INSTANT_HARNESS: "opencode",
      INSTANT_SESSION_ID: "ses_1",
      INSTANT_MODEL: "deepseek-v4-flash",
      CLAUDECODE: "1",
    });
    expect(got).toEqual({ harness: "opencode", sessionId: "ses_1", model: "deepseek-v4-flash" });
  });

  it("returns null when no marker is present", () => {
    expect(inferHarnessFromEnv({ PATH: "/usr/bin" })).toBeNull();
  });
});

describe("laneEnvStamp", () => {
  it("prefixes the harness id only when nothing else is known", () => {
    expect(laneEnvStamp("kimi")).toBe("INSTANT_HARNESS=kimi ");
  });

  it("adds session id and model when known", () => {
    expect(laneEnvStamp("codex", "sess-9", "gpt-5")).toBe("INSTANT_HARNESS=codex INSTANT_SESSION_ID=sess-9 INSTANT_MODEL=gpt-5 ");
  });

  it("shell-quotes a value with a shell metacharacter", () => {
    expect(laneEnvStamp("opencode", null, 'weird"model')).toBe('INSTANT_HARNESS=opencode INSTANT_MODEL="weird\\"model" ');
  });
});
