import { describe, expect, it } from "vitest";
import { parseHarnessSession } from "./0_harnessStore";

describe("parseHarnessSession", () => {
  it("retains the normalized cross-harness session contract", () => {
    expect(parseHarnessSession(JSON.stringify({
      id: "thread-7",
      harness: "codex",
      cwd: "/repo",
      sourcePath: "/store/rollout.jsonl",
      title: "Fixture",
      model: "gpt-test",
      inputTokens: 321,
      parentId: "thread-1",
      parentKind: "subagent",
      createdAtMs: 100,
      lastActivityMs: 200,
    }))).toMatchInlineSnapshot(`
      {
        "createdAtMs": 100,
        "cwd": "/repo",
        "harness": "codex",
        "id": "thread-7",
        "inputTokens": 321,
        "lastActivityMs": 200,
        "model": "gpt-test",
        "parentId": "thread-1",
        "parentKind": "subagent",
        "sourcePath": "/store/rollout.jsonl",
        "title": "Fixture",
      }
    `);
  });

  it("retains an empty resolution", () => {
    expect(parseHarnessSession("null")).toMatchInlineSnapshot(`null`);
  });
});
