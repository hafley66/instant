/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ calls: 0, rows: [] as unknown[] }));
vi.mock("./generated/native", () => ({
  commands: { boop: { boopConfigPresets: "boop_config_presets" } },
  invoke: async () => {
    native.calls++;
    return native.rows;
  },
}));

import { orderedGroups, empty_nav_order, withFavorites } from "./0_navMenu";
import {
  forkPresets,
  livePresets,
  mainPreset,
  presetGroups,
  presetSubtext,
  resetForkPresetCache,
  type BoopPreset,
} from "./1g_forkPresetMenu";

const preset = (over: Partial<BoopPreset> = {}): BoopPreset => ({
  name: "flash4",
  harness: "opencode",
  model: "openrouter/deepseek/deepseek-v4-flash-0731",
  effort: null,
  variant: null,
  bin: null,
  status: "ok *",
  default: true,
  ...over,
});

const rows = (): BoopPreset[] => [
  preset(),
  preset({ name: "pro4", model: "openrouter/deepseek/deepseek-v4-pro-0813", status: "ok", default: false }),
  preset({ name: "opus", harness: "claude", model: "claude-opus-5", effort: "high", status: "ok", default: false }),
  preset({ name: "gone", harness: "claude", model: "claude-3", status: "DEAD model retired", default: false }),
];

beforeEach(() => {
  native.calls = 0;
  native.rows = rows();
  resetForkPresetCache();
});

describe("presets to menu groups", () => {
  it("drops a preset the config marks DEAD", () => {
    expect(livePresets(rows()).map((row) => row.name)).toEqual(["flash4", "pro4", "opus"]);
  });

  it("labels a row with its model, and its effort when the preset sets one", () => {
    expect(presetSubtext(preset())).toBe("openrouter/deepseek/deepseek-v4-flash-0731");
    expect(presetSubtext(preset({ effort: "high", model: "claude-opus-5" }))).toBe("claude-opus-5 @high");
  });

  it("groups by harness, one item per preset, each running its own name", () => {
    const run = vi.fn();
    const groups = presetGroups(rows(), run);
    expect(groups.map((group) => group.id)).toEqual(["opencode", "claude"]);
    expect(groups[0].items.map((item) => item.id)).toEqual(["flash4", "pro4"]);
    expect(groups[1].items.map((item) => item.id)).toEqual(["opus"]);
    groups[1].items[0].run!();
    expect(run).toHaveBeenCalledWith("opus");
  });

  it("never lets an item claim a harness it is not in", () => {
    for (const group of presetGroups(rows(), () => {})) {
      for (const item of group.items) expect(item.group).toBe(group.id);
    }
  });
});

describe("the preset the main row runs", () => {
  it("repeats the last one picked", () => {
    expect(mainPreset("opus", presetGroups(rows(), () => {}))).toBe("opus");
  });

  it("falls back to the first preset in the user's own order", () => {
    const groups = orderedGroups(presetGroups(rows(), () => {}), { groups: ["claude"], items: {} });
    expect(mainPreset("", groups)).toBe("opus");
  });

  it("falls back to the built-in preset when nothing has been read yet", () => {
    expect(mainPreset("", [], "flash4")).toBe("flash4");
  });

  it("takes the first favourite when nothing has run yet, by its home id", () => {
    const pinned = withFavorites(presetGroups(rows(), () => {}), ["opus"]);
    expect(mainPreset("", pinned)).toBe("opus");
    expect(mainPreset("pro4", pinned)).toBe("pro4");
  });
});

describe("the read behind the submenu", () => {
  it("reads once and serves the cache inside the window", async () => {
    const now = 1_000_000;
    expect((await forkPresets(now)).map((row) => row.name)).toContain("flash4");
    await forkPresets(now + 1_000);
    expect(native.calls).toBe(1);
    await forkPresets(now + 61_000);
    expect(native.calls).toBe(2);
  });

  it("keeps the last good rows when the read fails", async () => {
    await forkPresets(1_000_000);
    native.rows = [];
    expect((await forkPresets(2_000_000)).length).toBe(4);
  });

  it("applies the persisted order to the groups it hands the menu", () => {
    const groups = presetGroups(rows(), () => {});
    const ordered = orderedGroups(groups, { groups: [], items: { opencode: ["pro4", "flash4"] } });
    expect(ordered[0].items.map((item) => item.id)).toEqual(["pro4", "flash4"]);
    expect(orderedGroups(groups, empty_nav_order)[0].items.map((item) => item.id))
      .toEqual(["flash4", "pro4"]);
  });
});
