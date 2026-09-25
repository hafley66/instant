import { beforeEach, describe, expect, it, vi } from "vitest";
import { firstValueFrom, toArray } from "rxjs";
import type { MdFenceCommand } from "@hafley66/md/plugins";
import { defaultMdPlugins } from "@hafley66/md/plugins";

const { invoke, configured } = vi.hoisted(() => ({
  invoke: vi.fn(async (command: string, request: unknown) => ({
    stdout: JSON.stringify({ command, request }), stderr: "", code: 0,
  })),
  configured: { value: null as MdFenceCommand[] | null },
}));
vi.mock("./generated/native", () => ({ invoke }));
vi.mock("./0_settings", () => ({ settings: { fenceCommands: { $: () => configured.value } } }));
vi.stubGlobal("location", { search: "", hash: "" });
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });

const { DEFAULT_FENCE_COMMANDS } = await import("./state");
const { fenceCommandHost } = await import("./1_fenceCommandHost");

beforeEach(() => {
  configured.value = null;
  invoke.mockClear();
});

describe("fence command host", () => {
  it("places configured commands before the four default plugins", () => {
    const command: MdFenceCommand = { match: "^sql$", command: "sqlfmt $1", as: "replace" };
    configured.value = [command, { match: "^txt$", command: "wc $1", as: "annotate" }];
    expect(fenceCommandHost.mdPlugins.map((plugin) => plugin.command ?? plugin.name)).toEqual([
      command,
      configured.value[1],
      ...defaultMdPlugins.map((plugin) => plugin.name),
    ]);
    configured.value = [command];
    expect(fenceCommandHost.mdPlugins).toHaveLength(1 + defaultMdPlugins.length);
  });

  it("returns the same plugin array until the setting changes, so md keeps renderer identity", () => {
    const first = fenceCommandHost.mdPlugins;
    const again = fenceCommandHost.mdPlugins;
    configured.value = [{ match: "^sql$", command: "sqlfmt $1", as: "replace" }];
    const changed = fenceCommandHost.mdPlugins;
    expect({ stable: first === again, changed: changed !== first, changedStable: changed === fenceCommandHost.mdPlugins }).toEqual({
      stable: true, changed: true, changedStable: true,
    });
  });

  it("uses the default commands when the setting is null", () => {
    expect(fenceCommandHost.mdPlugins.map((plugin) => plugin.command ?? plugin.name)).toEqual([
      ...DEFAULT_FENCE_COMMANDS,
      ...defaultMdPlugins.map((plugin) => plugin.name),
    ]);
  });

  it("emits one native result and completes", async () => {
    const request = { command: "fmt $1", language: "ts", text: "let x=1", columns: 72 };
    await expect(firstValueFrom(fenceCommandHost.runFenceCommand(request).pipe(toArray()))).resolves.toEqual([
      { stdout: JSON.stringify({ command: "run_fence_command", request }), stderr: "", code: 0 },
    ]);
  });
});
