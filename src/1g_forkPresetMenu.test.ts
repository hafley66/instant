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

/// The built-in fallback the fork row lands on when nothing else names one.
const FORK_FALLBACK = "flash4";
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

// The defect this pins: the row defaulted to the preset last picked in ANY
// pane, so forking a claude conversation offered whatever an unrelated opencode
// pane ran last. A fork continues one conversation; that conversation decides.
describe("the preset the pane being forked decides", () => {
  const groups = () => presetGroups(rows(), () => {});

  it("repeats the pane's own preset over the last one picked elsewhere", () => {
    expect(mainPreset("flash4", groups(), FORK_FALLBACK, { preset: "opus" })).toBe("opus");
  });

  it("ignores a stale preset the presets no longer carry", () => {
    expect(mainPreset("flash4", groups(), FORK_FALLBACK, { preset: "retired" })).toBe("flash4");
  });

  it("takes the pane's own preset through a favourite's prefixed id", () => {
    const pinned = withFavorites(groups(), ["opus"]);
    expect(mainPreset("flash4", pinned, FORK_FALLBACK, { preset: "opus" })).toBe("opus");
  });

  it("falls to the first preset of the pane's harness when only that is known", () => {
    expect(mainPreset("flash4", groups(), FORK_FALLBACK, { harness: "claude" })).toBe("opus");
    expect(mainPreset("opus", groups(), FORK_FALLBACK, { harness: "opencode" })).toBe("flash4");
  });

  it("reads the harness group in the user's own order", () => {
    const ordered = orderedGroups(groups(), { groups: [], items: { opencode: ["pro4"] } });
    expect(mainPreset("opus", ordered, FORK_FALLBACK, { harness: "opencode" })).toBe("pro4");
  });

  it("keeps the old behaviour for a harness no preset covers", () => {
    expect(mainPreset("flash4", groups(), FORK_FALLBACK, { harness: "kimi" })).toBe("flash4");
    expect(mainPreset("", groups(), FORK_FALLBACK, { harness: null, preset: null })).toBe("flash4");
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
