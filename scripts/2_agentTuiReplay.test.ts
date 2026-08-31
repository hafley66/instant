import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { liveAgentAdapters } from "./2_agentTuiReplay";

describe("live agent TUI launch contracts", () => {
  it("isolates every harness behind the loopback provider without an env file", () => {
    const root = mkdtempSync(join(tmpdir(), "instant-agent-contract-"));
    const physicalRoot = realpathSync(root);
    const normalize = (value: string) => value
      .replaceAll(physicalRoot, "$ROOT")
      .replaceAll(root, "$ROOT");
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    try {
      const contracts = liveAgentAdapters.map((adapter) => {
        const home = join(root, adapter.harness);
        const launch = adapter.writeLaunch(`/bin/${adapter.harness}`, home, workspace, 43891);
        return {
          harness: adapter.harness,
          executable: launch.executable,
          args: launch.args.map(normalize),
          providerVariables: Object.keys(launch.env)
            .filter((name) => /^(ANTHROPIC|CLAUDE|CODEX|KIMI|OPENAI|OPENCODE)/.test(name))
            .sort(),
          configs: launch.configPaths.map((path) => ({
            path: normalize(path),
            content: normalize(readFileSync(path, "utf8")),
          })),
        };
      });
      expect(contracts).toMatchSnapshot();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
