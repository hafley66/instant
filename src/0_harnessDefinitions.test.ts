import { describe, expect, it } from "vitest";
import { harnessDefinitionById } from "./0_harnessDefinitions";

describe("HarnessDefinition.lane", () => {
  it("builds Cass-visible launches through the central harness adapters", () => {
    expect([
      harnessDefinitionById.claude.lane("/tmp/claude.md", "claude-opus-4-1"),
      harnessDefinitionById.codex.lane("/tmp/lane's brief.md", "gpt-5.6-terra"),
      harnessDefinitionById.kimi.lane("/tmp/kimi.md", "kimi-k2.5"),
      harnessDefinitionById.opencode.lane("/tmp/open.md"),
    ]).toMatchInlineSnapshot(`
      [
        {
          "body": "Read and execute the lane brief at /tmp/claude.md",
          "command": "claude -m 'claude-opus-4-1'",
          "mode": "interactive",
          "model": "claude-opus-4-1",
          "ref": "/tmp/claude.md",
        },
        {
          "body": "Read and execute the lane brief at /tmp/lane's brief.md",
          "command": "codex -m 'gpt-5.6-terra'",
          "mode": "interactive",
          "model": "gpt-5.6-terra",
          "ref": "/tmp/lane's brief.md",
        },
        {
          "body": "Read and execute the lane brief at /tmp/kimi.md",
          "command": "kimi -m 'kimi-k2.5'",
          "mode": "interactive",
          "model": "kimi-k2.5",
          "ref": "/tmp/kimi.md",
        },
        {
          "body": "Read and execute the lane brief at /tmp/open.md",
          "command": "opencode run -m 'openrouter/deepseek/deepseek-v4-flash-0731' --auto \"$(cat '/tmp/open.md')\"",
          "mode": "auto",
          "model": "openrouter/deepseek/deepseek-v4-flash-0731",
          "ref": "/tmp/open.md",
        },
      ]
    `);
  });
});
