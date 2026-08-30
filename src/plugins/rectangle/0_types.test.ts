import { describe, expect, it } from "vitest";
import {
  projectRectangles,
  rectangleSignature,
  type RectangleWorkspaceInput,
} from "./0_types";

const input: RectangleWorkspaceInput = {
  id: "wk-1",
  title: "Adapters",
  sessions: [
    { id: "s1", title: "session one", lines: ["src/index.ts", "README.md"] },
    { id: "s2", title: "session two", lines: ["src/main.ts"] },
    { id: "s3", title: "session three", lines: ["a.ts", "b.ts", "c.ts"] },
  ],
  graph: {
    id: "g1",
    title: "build graph",
    nodes: ["source", "compile", "run"],
    edges: [
      ["source", "compile"],
      ["compile", "run"],
    ],
  },
};

describe("projectRectangles", () => {
  it("projects sessions and graph into positioned, sized package rectangles", () => {
    expect(projectRectangles(input)).toMatchInlineSnapshot(`
      [
        {
          "content": {
            "kind": "session",
            "lines": [
              "src/index.ts",
              "README.md",
            ],
          },
          "id": "s1",
          "position": {
            "x": 48,
            "y": 48,
          },
          "size": {
            "height": 240,
            "width": 340,
          },
          "title": "session one",
          "z": 1,
        },
        {
          "content": {
            "kind": "session",
            "lines": [
              "src/main.ts",
            ],
          },
          "id": "s2",
          "position": {
            "x": 436,
            "y": 48,
          },
          "size": {
            "height": 240,
            "width": 340,
          },
          "title": "session two",
          "z": 2,
        },
        {
          "content": {
            "kind": "session",
            "lines": [
              "a.ts",
              "b.ts",
              "c.ts",
            ],
          },
          "id": "s3",
          "position": {
            "x": 48,
            "y": 336,
          },
          "size": {
            "height": 240,
            "width": 340,
          },
          "title": "session three",
          "z": 3,
        },
        {
          "content": {
            "edges": [
              [
                "source",
                "compile",
              ],
              [
                "compile",
                "run",
              ],
            ],
            "kind": "graph",
            "nodes": [
              "source",
              "compile",
              "run",
            ],
          },
          "id": "g1",
          "position": {
            "x": 436,
            "y": 336,
          },
          "size": {
            "height": 360,
            "width": 560,
          },
          "title": "build graph",
          "z": 4,
        },
      ]
    `);
  });

  it("encodes readonly inputs into the package's mutable tuple/lines shape", () => {
    const projected = projectRectangles(input);
    expect(projected[3].content).toMatchObject({
      kind: "graph",
      nodes: ["source", "compile", "run"],
      edges: [
        ["source", "compile"],
        ["compile", "run"],
      ],
    });
  });

  it("is deterministic: same input projects to identical rectangles and signature", () => {
    expect(rectangleSignature(projectRectangles(input))).toBe(
      rectangleSignature(projectRectangles({ ...input, sessions: [...input.sessions] })),
    );
  });
});

describe("same-id update / dedup at the pure boundary", () => {
  it("projects a changed input for the same id to a new, deterministic signature", () => {
    const updated: RectangleWorkspaceInput = {
      ...input,
      sessions: [
        { id: "s1", title: "session one", lines: ["src/index.ts", "README.md"] },
        { id: "s2", title: "session two", lines: ["src/main.ts", "src/reactdock.tsx"] },
      ],
    };
    const before = rectangleSignature(projectRectangles(input));
    const after = rectangleSignature(projectRectangles(updated));
    expect(after).not.toBe(before);
    expect(after).toMatchInlineSnapshot(`"[{"id":"s1","title":"session one","position":{"x":48,"y":48},"size":{"width":340,"height":240},"z":1,"content":{"kind":"session","lines":["src/index.ts","README.md"]}},{"id":"s2","title":"session two","position":{"x":436,"y":48},"size":{"width":340,"height":240},"z":2,"content":{"kind":"session","lines":["src/main.ts","src/reactdock.tsx"]}},{"id":"g1","title":"build graph","position":{"x":48,"y":336},"size":{"width":560,"height":360},"z":3,"content":{"kind":"graph","nodes":["source","compile","run"],"edges":[["source","compile"],["compile","run"]]}}]"`);
  });
});
