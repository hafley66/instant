import { navOrder, orderedGroups, type NavGroup, type NavItem } from "./0_navMenu";
import { forkRender } from "./0_forkRenderSettings";
import { FORK_PRESET } from "./1e_terminalForkMarks";
import { commands, invoke } from "./generated/native";

/// One row of `boop config presets --format json`.
export type BoopPreset = {
  name: string;
  harness: string;
  model: string;
  effort: string | null;
  variant: string | null;
  bin: string | null;
  status: string;
  default: boolean;
};

/// The user's own order of the preset submenu, groups and items alike.
export const forkPresetOrder = navOrder("fork.presetOrder");

/// A preset the config marks DEAD cannot spawn a lane.
export function livePresets(presets: BoopPreset[]): BoopPreset[] {
  return presets.filter((preset) => !preset.status.trim().toUpperCase().startsWith("DEAD"));
}

export function presetSubtext(preset: BoopPreset): string {
  return preset.effort ? `${preset.model} @${preset.effort}` : preset.model;
}

/// Presets grouped by harness, harnesses in the order they first appear.
export function presetGroups(presets: BoopPreset[], run: (name: string) => void): NavGroup[] {
  const byHarness = new Map<string, NavItem[]>();
  for (const preset of livePresets(presets)) {
    const items = byHarness.get(preset.harness) ?? [];
    items.push({
      id: preset.name,
      label: preset.name,
      subtext: presetSubtext(preset),
      group: preset.harness,
      run: () => run(preset.name),
    });
    byHarness.set(preset.harness, items);
  }
  return [...byHarness].map(([harness, items]) => ({ id: harness, label: harness, items }));
}

/// What the main row runs and names: the preset last picked here, else the
/// first one in the user's own order, else the built-in default.
export function mainPreset(lastPreset: string, groups: NavGroup[], fallback = FORK_PRESET): string {
  if (lastPreset) return lastPreset;
  return groups[0]?.items[0]?.id ?? fallback;
}

/// One read per menu open at most.
export const preset_cache_ms = 60_000;
let cached: BoopPreset[] = [];
let cachedAt = 0;

export async function forkPresets(now = Date.now()): Promise<BoopPreset[]> {
  if (cached.length && now - cachedAt < preset_cache_ms) return cached;
  const rows = await invoke<BoopPreset[]>(commands.boop.boopConfigPresets, {}).catch(() => null);
  if (rows?.length) {
    cached = rows;
    cachedAt = now;
  }
  return cached;
}

export function cachedForkPresets(): BoopPreset[] {
  return cached;
}

export function resetForkPresetCache() {
  cached = [];
  cachedAt = 0;
}

/// The preset a click on the main row runs, read without waiting on the store:
/// the last one used, else the first of whatever the last read cached.
export function currentForkPreset(): string {
  const groups = orderedGroups(presetGroups(cachedForkPresets(), () => {}), forkPresetOrder.$());
  return mainPreset(forkRender.lastPreset.$(), groups);
}
