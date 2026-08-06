import { describe, expect, it } from "vitest";
import { d2SiblingPaths, resolveD2Preview } from "./0_d2Preview";

describe("d2 file preview", () => {
  it("resolves adjacent renders in SVG then PNG order", () => {
    expect(d2SiblingPaths("/tmp/architecture.d2")).toMatchInlineSnapshot(`
      [
        "/tmp/architecture.svg",
        "/tmp/architecture.png",
      ]
    `);
  });

  it("renders source SVG before accepting an adjacent PNG", async () => {
    const calls: string[] = [];
    const preview = await resolveD2Preview(
      "/tmp/architecture.d2",
      async (path) => {
        calls.push(`svg:${path}`);
        throw new Error("missing");
      },
      async (path) => {
        calls.push(`image:${path}`);
        return "png-data";
      },
      async (path) => {
        calls.push(`render:${path}`);
        return { source: "a -> b", svg: "<svg>a to b</svg>" };
      },
    );

    expect({ calls, preview }).toMatchInlineSnapshot(`
      {
        "calls": [
          "svg:/tmp/architecture.svg",
          "render:/tmp/architecture.d2",
        ],
        "preview": {
          "format": "svg-rendered",
          "path": "/tmp/architecture.d2",
          "source": "a -> b",
          "svg": "<svg>a to b</svg>",
        },
      }
    `);
  });
});
