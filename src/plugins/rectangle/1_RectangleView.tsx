// Dockview panel host for a rectangle workspace. Acquires the per-id
// RectangleModel from the workspace registry (creating it from the persisted
// input on first mount), renders the package's RectangleCanvas, and releases
// React + Cytoscape resources on unmount. The input is re-read through the app
// store (useApp) so a same-id update from openRectangleWorkspace re-projects
// deterministically; RectangleCanvas is keyed by the content signature so a
// content change fully remounts (single canvas, no layered duplicate).

import { useEffect, useMemo, useRef } from "react";
import type { IDockviewPanelProps } from "dockview";
import { createRectangleModel, RectangleCanvas, type RectangleModel } from "@hafley66/react-dock-and-flow";
import "@xyflow/react/dist/style.css";
import "@hafley66/react-dock-and-flow/style.css";
import { useApp } from "../../useStore";
import { projectRectangles, type RectangleWorkspaceInput } from "./0_types";
import {
  acquireRectangleModel,
  releaseRectangleModel,
  RECT_PLUGIN_ID,
  RECT_PREFIX,
} from "./2_workspace";

type InputMap = Record<string, Record<string, RectangleWorkspaceInput | undefined>>;

export function RectangleView(props: IDockviewPanelProps) {
  const panelId = String(props.params.panelId ?? "");
  const key = panelId.startsWith(RECT_PREFIX) ? panelId.slice(RECT_PREFIX.length) : panelId;
  const app = useApp();
  const bag = (app.pluginState as InputMap)[RECT_PLUGIN_ID];
  const input = bag?.[key];
  const rectangles = useMemo(() => (input ? projectRectangles(input) : []), [input]);
  const signature = useMemo(() => JSON.stringify(rectangles), [rectangles]);

  const holder = useRef<{ model: RectangleModel; signature: string } | null>(null);
  if (holder.current === null || holder.current.signature !== signature) {
    const model = acquireRectangleModel(key, signature, () => createRectangleModel(rectangles));
    if (holder.current) releaseRectangleModel(key, holder.current.model);
    holder.current = { model, signature };
  }
  const model = holder.current.model;

  useEffect(
    () => () => {
      if (holder.current) releaseRectangleModel(key, holder.current.model);
      holder.current = null;
    },
    [key],
  );

  if (!model) {
    return <div className="rect-workspace" data-testid="rectangle-workspace" style={{ width: "100%", height: "100%" }} />;
  }
  return (
    <div
      className="rect-workspace"
      data-testid="rectangle-workspace"
      style={{ width: "100%", height: "100%" }}
    >
      <RectangleCanvas key={signature} model={model} />
    </div>
  );
}
