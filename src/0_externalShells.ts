import type { OpenTab } from "./state";

export interface ExternalShellTarget {
  name: string;
  tmuxTarget: string;
  viewer: true;
}

export function externalViewerTarget(name: string, tmuxTarget: string): ExternalShellTarget {
  return { name, tmuxTarget, viewer: true };
}

export function viewerFailureAction(viewer: boolean): "remove" | "retain" {
  return viewer ? "remove" : "retain";
}

export function persistedViewerTarget(target: ExternalShellTarget): Pick<OpenTab, "name" | "tmuxTarget" | "viewer"> {
  return { name: target.name, tmuxTarget: target.tmuxTarget, viewer: true };
}
