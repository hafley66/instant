// Pure geometry helpers for the meme panel's react-resizable-panels layout.
// No React/DOM imports here on purpose: react-resizable-panels is
// percentage-only, but the sizes we used to persist (sidebarWidth,
// layersHeight from the old hand-rolled sashes) were absolute pixels. These
// functions convert between the two so existing pluginState survives the
// migration, and derive percentage min/max bounds from a measured container
// size so the resize feel stays close to the old 120-400px / 80-400px clamps.

export const SIDEBAR_MIN_PX = 120;
export const SIDEBAR_MAX_PX = 400;
export const LAYERS_MIN_PX = 80;
export const LAYERS_MAX_PX = 400;

// Used only when there's neither a persisted percentage layout nor a legacy
// px value to migrate (fresh install).
export const DEFAULT_SIDEBAR_PCT = 20;
export const DEFAULT_LAYERS_PCT = 25;

export interface LegacyMemeUi {
  sidebarWidth?: number;
  layersHeight?: number;
}

export interface MemeLayout {
  outer: [number, number]; // [sidebarPct, mainPct]
  inner: [number, number]; // [stagePct, layersPct]
}

export function clampPercent(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

export function pxToPercent(px: number, containerPx: number): number {
  if (!containerPx || containerPx <= 0) return 0;
  return clampPercent((px / containerPx) * 100);
}

// One-time migration: convert the old absolute-pixel sidebar/layers sizes
// into the [outer, inner] percentage layout react-resizable-panels expects.
// Falls back to a fixed default split when there's nothing to migrate.
export function migrateLegacyLayout(
  legacy: LegacyMemeUi,
  containerWidthPx: number,
  containerHeightPx: number,
): MemeLayout {
  const sidebarPct =
    legacy.sidebarWidth != null
      ? clampPercent(pxToPercent(legacy.sidebarWidth, containerWidthPx))
      : DEFAULT_SIDEBAR_PCT;
  const layersPct =
    legacy.layersHeight != null
      ? clampPercent(pxToPercent(legacy.layersHeight, containerHeightPx))
      : DEFAULT_LAYERS_PCT;
  return {
    outer: [sidebarPct, 100 - sidebarPct],
    inner: [100 - layersPct, layersPct],
  };
}

export function sidebarBoundsPct(containerWidthPx: number): { min: number; max: number } {
  return {
    min: pxToPercent(SIDEBAR_MIN_PX, containerWidthPx),
    max: pxToPercent(SIDEBAR_MAX_PX, containerWidthPx),
  };
}

export function layersBoundsPct(containerHeightPx: number): { min: number; max: number } {
  return {
    min: pxToPercent(LAYERS_MIN_PX, containerHeightPx),
    max: pxToPercent(LAYERS_MAX_PX, containerHeightPx),
  };
}
