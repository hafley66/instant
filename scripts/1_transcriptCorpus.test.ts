import { describe, expect, it } from "vitest";
import { inspectTranscriptCorpus } from "./1_transcriptCorpus.mjs";

describe("captured transcript corpus", () => {
  it("contains a parseable record for every declared harness wire kind", () => {
    expect(inspectTranscriptCorpus()).toMatchInlineSnapshot(`
      {
        "fixtures": [
          {
            "harness": "claude",
            "kinds": 25,
            "minimumPerKind": 1,
            "records": 48,
          },
          {
            "harness": "codex",
            "kinds": 14,
            "minimumPerKind": 1,
            "records": 22,
          },
          {
            "harness": "kimi",
            "kinds": 32,
            "minimumPerKind": 1,
            "records": 54,
          },
          {
            "harness": "claude-subagent",
            "kinds": 13,
            "minimumPerKind": 1,
            "records": 21,
          },
        ],
        "kinds": 84,
        "perKind": 2,
        "records": 145,
      }
    `);
  });
});
