// Rectangle workspace instance lifecycle + the exported opening seam. One
// RectangleModel per open workspace id; the model content is projected from the
// persisted input and replaced deterministically when the input changes. No
// second global store: the input lives in pluginState (readPluginState/
// savePluginState) and the model in a per-id module registry keyed by the
// encoded instance id.

import { type RectangleModel } from "@hafley66/react-dock-and-flow";
import { registerPlugin } from "../../plugin";
import { openPanelInstance } from "../../reactdock";
import { readPluginState, savePluginState } from "../../pluginState";
import { RectangleView } from "./1_RectangleView";
import { type RectangleWorkspaceInput } from "./0_types";

export const RECT_PLUGIN_ID = "rectangle";
export const RECT_PREFIX = "rect:";
const RECT_INSTANCE_KIND = "rectangle";
const RECT_INSTANCE_COMPONENT = "rectangle-instance";

// Instance panel id for a workspace id: `rect:<encoded id>`. Mirrors
// openPanelInstance's `prefix + encodeURIComponent(key)`.
export const workspaceId = (id: string) => RECT_PREFIX + encodeURIComponent(id);
// Reverse of workspaceId: full panel id -> encoded workspace key.
export const workspaceKey = (panelId: string) => panelId.slice(RECT_PREFIX.length);

export function readWorkspaceInput(key: string): RectangleWorkspaceInput | undefined {
  const bag = readPluginState<Record<string, RectangleWorkspaceInput>>(RECT_PLUGIN_ID, {});
  return bag[key];
}

function saveWorkspaceInput(input: RectangleWorkspaceInput): void {
  const bag = readPluginState<Record<string, RectangleWorkspaceInput>>(RECT_PLUGIN_ID, {});
  savePluginState(RECT_PLUGIN_ID, { ...bag, [encodeURIComponent(input.id)]: input });
}

type Live = { model: RectangleModel; signature: string };
const liveModels = new Map<string, Live>();

// Mount creates or acquires. Reuses the registered model while its content
// signature is unchanged (one model per open workspace id); replaces it with a
// freshly built model the moment the input changes, so the projection updates
// deterministically. Undo/redo journal is deliberately dropped on content
// replacement, matching the package (events replay over a fixed `initial`).
export function acquireRectangleModel(
  key: string,
  signature: string,
  build: () => RectangleModel,
): RectangleModel {
  const current = liveModels.get(key);
  if (current && current.signature === signature) return current.model;
  const model = build();
  liveModels.set(key, { model, signature });
  return model;
}

export function releaseRectangleModel(key: string, model: RectangleModel): void {
  const current = liveModels.get(key);
  if (current && current.model === model) liveModels.delete(key);
}

export function rectangleModel(key: string): RectangleModel | undefined {
  return liveModels.get(key)?.model;
}

export function openRectangleWorkspace(input: RectangleWorkspaceInput): void {
  saveWorkspaceInput(input);
  openPanelInstance(RECT_INSTANCE_KIND, input.id, input.title, {});
}

export function registerRectangle(): void {
  registerPlugin({
    id: RECT_PLUGIN_ID,
    panels: [],
    instances: [
      {
        id: RECT_INSTANCE_KIND,
        prefix: RECT_PREFIX,
        componentName: RECT_INSTANCE_COMPONENT,
        component: RectangleView,
        restorable: true,
      },
    ],
  });
}
