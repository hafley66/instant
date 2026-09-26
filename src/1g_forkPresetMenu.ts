import {
  favoriteHomeId,
  orderedGroups,
  withFavorites,
  type NavGroup,
  type NavItem,
} from "./0_navMenu";
import { navMenuStore } from "./0_navMenuStore";
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

/// The submenu's own order and starred presets: keys fork.presets.order and
/// fork.presets.favorites.
export const forkPresetStore = navMenuStore("fork.presets");

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

/// The conversation a fork is taken from. `preset` is set when Instant spawned
/// that pane itself and knows the exact preset; `harness` is what the pane is
/// observed to be running, which is all a hand-started session offers.
export type ForkOrigin = { preset?: string | null; harness?: string | null };

/// What the main row runs and names, most specific source first:
///   1. the preset the forked-from conversation itself runs
///   2. the first preset of that conversation's harness, in the user's order
///   3. the preset last picked here
///   4. the first favourite, else the first in the user's order
///   5. the built-in default
/// A fork continues the conversation it came from, so the pane outranks a
/// preset last picked in some other pane.
export function mainPreset(
  lastPreset: string,
  groups: NavGroup[],
  fallback = FORK_PRESET,
  origin: ForkOrigin = {},
): string {
  const known = new Set(groups.flatMap((group) => group.items.map((item) => favoriteHomeId(item.id))));
  if (origin.preset && known.has(origin.preset)) return origin.preset;
  const harness = origin.harness ? groups.find((group) => group.id === origin.harness) : undefined;
  const first = harness?.items[0]?.id;
  if (first) return favoriteHomeId(first);
  if (lastPreset) return lastPreset;
  return favoriteHomeId(groups[0]?.items[0]?.id ?? fallback);
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
/// whatever `origin` names about the pane being forked, else the last one used,
/// else the first of whatever the last read cached.
export function currentForkPreset(origin: ForkOrigin = {}): string {
  const groups = withFavorites(
    orderedGroups(presetGroups(cachedForkPresets(), () => {}), forkPresetStore.order.$()),
    forkPresetStore.favorites.$(),
  );
  return mainPreset(forkRender.lastPreset.$(), groups, FORK_PRESET, origin);
}
