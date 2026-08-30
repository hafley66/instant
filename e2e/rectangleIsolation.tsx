// Isolation harness for the rectangle adapter lab: mounts the REAL
// @hafley66/react-dock-and-flow RectangleCanvas (not a stub) with one session
// rectangle and one Cytoscape graph rectangle, and drives move/undo/redo
// through the package model. Exposed on window.__rectTest for the Playwright
// spec to assert positions and dispatch undo/redo.

import { createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  createRectangleModel,
  RectangleCanvas,
  type Rectangle,
} from "@hafley66/react-dock-and-flow";
import "@xyflow/react/dist/style.css";
import "@hafley66/react-dock-and-flow/style.css";

const initialState: Rectangle[] = [
  {
    id: "session-a",
    title: "agent session",
    position: { x: 120, y: 120 },
    size: { width: 340, height: 240 },
    z: 1,
    content: { kind: "session", lines: ["src/index.ts", "READ ME", "node_modules/"] },
  },
  {
    id: "graph-a",
    title: "query graph",
    position: { x: 520, y: 120 },
    size: { width: 560, height: 360 },
    z: 2,
    content: {
      kind: "graph",
      nodes: ["source", "compile", "run"],
      edges: [
        ["source", "compile"],
        ["compile", "run"],
      ],
    },
  },
];

const model = createRectangleModel(initialState);

declare global {
  interface Window {
    __rectTest?: {
      model: typeof model;
      rects: () => Rectangle[];
      undo: () => void;
      redo: () => void;
      move: (id: string, position: Rectangle["position"]) => void;
      raise: (id: string) => void;
    };
  }
}

window.__rectTest = {
  model,
  rects: () => model.rectangles.$(),
  undo: () => model.events.$({ type: "undo" }),
  redo: () => model.events.$({ type: "redo" }),
  move: (id, position) => model.events.$({ type: "moved", id, position }),
  raise: (id) => model.events.$({ type: "raised", id }),
};

createRoot(document.getElementById("isolation")!).render(
  createElement(RectangleCanvas, { model }),
);
