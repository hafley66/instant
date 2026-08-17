import type { OpenTab } from "./state";

export interface ExternalShellTarget {
  name: string;
  tmuxTarget: string;
  viewer: true;
}

export interface ExternalShellOpenSessionArgs {
  [key: string]: unknown;
  id: string;
  name: string;
  tmuxTarget: string;
  command: null;
  cwd: null;
  cols: number;
  rows: number;
  graphics: false;
  attachOnly: true;
  cellW?: number;
  cellH?: number;
}

export function externalViewerTarget(name: string, tmuxTarget: string): ExternalShellTarget {
  return { name, tmuxTarget, viewer: true };
}

export function externalShellOpenSessionArgs(
  target: ExternalShellTarget,
  input: Pick<ExternalShellOpenSessionArgs, "id" | "cols" | "rows"> & Partial<Pick<ExternalShellOpenSessionArgs, "cellW" | "cellH">>,
): ExternalShellOpenSessionArgs {
  return {
    id: input.id,
    name: target.name,
    tmuxTarget: target.tmuxTarget,
    command: null,
    cwd: null,
    cols: input.cols,
    rows: input.rows,
    graphics: false,
    attachOnly: true,
    ...(input.cellW == null ? {} : { cellW: input.cellW }),
    ...(input.cellH == null ? {} : { cellH: input.cellH }),
  };
}

export function viewerFailureAction(viewer: boolean): "remove" | "retain" {
  return viewer ? "remove" : "retain";
}

export function persistedViewerTarget(target: ExternalShellTarget): Pick<OpenTab, "name" | "tmuxTarget" | "viewer"> {
  return { name: target.name, tmuxTarget: target.tmuxTarget, viewer: true };
}
