// Pure projection from the app-facing RectangleWorkspaceInput seam to the
// @hafley66/react-dock-and-flow Rectangle model shape. No React, no dockview,
// no I/O: deterministic, unit-testable at the pure state boundary.
//
// The package's `Rectangle` requires mutable tuples for graph edges
// (`[string, string][]`) and mutable `lines`, so this boundary converts the
// brief's readonly inputs to the package's mutable shape.

export interface RectangleWorkspaceSession {
  id: string;
  title: string;
  lines: readonly string[];
}

export interface RectangleWorkspaceGraph {
  id: string;
  title: string;
  nodes: readonly string[];
  edges: readonly (readonly [string, string])[];
}

export interface RectangleWorkspaceInput {
  id: string;
  title: string;
  sessions: readonly RectangleWorkspaceSession[];
  graph?: RectangleWorkspaceGraph;
}

export type ProjectedRectangle = {
  id: string;
  title: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  z: number;
  content:
    | { kind: "session"; lines: string[] }
    | { kind: "graph"; nodes: string[]; edges: [string, string][] };
};

const SESSION_WIDTH = 340;
const SESSION_HEIGHT = 240;
const GRAPH_WIDTH = 560;
const GRAPH_HEIGHT = 360;
const COLS = 2;
const GAP = 48;
const OX = 48;
const OY = 48;

// Deterministic initial placement derived from array order: sessions fill a
// fixed 2-column grid at origin (OX, OY); the optional graph occupies the next
// unused grid cell after the last session. z is assigned in array order so the
// last rectangle is topmost when rectangles are clicked.
export function projectRectangles(input: RectangleWorkspaceInput): ProjectedRectangle[] {
  const out: ProjectedRectangle[] = [];

  input.sessions.forEach((session, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    out.push({
      id: session.id,
      title: session.title,
      position: { x: OX + col * (SESSION_WIDTH + GAP), y: OY + row * (SESSION_HEIGHT + GAP) },
      size: { width: SESSION_WIDTH, height: SESSION_HEIGHT },
      z: i + 1,
      content: { kind: "session", lines: [...session.lines] },
    });
  });

  if (input.graph) {
    const col = input.sessions.length % COLS;
    const row = Math.floor(input.sessions.length / COLS);
    out.push({
      id: input.graph.id,
      title: input.graph.title,
      position: { x: OX + col * (SESSION_WIDTH + GAP), y: OY + row * (SESSION_HEIGHT + GAP) },
      size: { width: GRAPH_WIDTH, height: GRAPH_HEIGHT },
      z: input.sessions.length + 1,
      content: {
        kind: "graph",
        nodes: [...input.graph.nodes],
        edges: input.graph.edges.map(([a, b]) => [a, b] as [string, string]),
      },
    });
  }

  return out;
}

// Stable content fingerprint: JSON of the immutable, deterministic projection.
// The panel re-creates its rectangle model only when this signature changes, so
// pure focus/reopen of the same content keeps one model instance per id.
export function rectangleSignature(rectangles: ProjectedRectangle[]): string {
  return JSON.stringify(rectangles);
}
