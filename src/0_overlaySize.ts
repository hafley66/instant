export type OverlaySize = "normal" | "mini";

export function overlaySizeTransition(previous: boolean | null, next: boolean): OverlaySize | null {
  if (previous === null) return next ? "mini" : null;
  if (previous === next) return null;
  return next ? "mini" : "normal";
}
