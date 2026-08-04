import { describe, it, expect } from "vitest";
import { renderD2 } from "./d2";

describe("renderD2", () => {
  it("renders a valid d2 fence into an svg-bearing string", async () => {
    const svg = await renderD2("a -> b", false);
    expect(svg).toContain("<svg");
  });

  it("renders the dark theme for dark mode", async () => {
    const light = await renderD2("a -> b", false);
    const dark = await renderD2("a -> b", true);
    expect(light).toContain("<svg");
    expect(dark).toContain("<svg");
    expect(dark).not.toBe(light);
  });

  it("renders labeled horizontal terminal output", async () => {
    const svg = await renderD2([
      "direction: right",
      'source: "Codex / Claude"',
      "source -> tmux",
      "tmux -> xterm",
      'xterm -> inline: "render"',
    ].join("\n"), true);

    expect({
      type: typeof svg,
      labels: ["Codex / Claude", "tmux", "xterm", "render"].map((label) => svg.includes(label)),
      hasSvg: svg.includes("<svg"),
    }).toMatchInlineSnapshot(`
      {
        "hasSvg": true,
        "labels": [
          true,
          true,
          true,
          true,
        ],
        "type": "string",
      }
    `);
  });

  it("renders concurrent diagrams through the shared instance", async () => {
    const rendered = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      renderD2(`node-${index} -> result-${index}`, true),
    ));

    expect(rendered.map((svg, index) => [
      typeof svg,
      svg.includes("<svg"),
      svg.includes(`node-${index}`),
    ])).toMatchInlineSnapshot(`
      [
        [
          "string",
          true,
          true,
        ],
        [
          "string",
          true,
          true,
        ],
        [
          "string",
          true,
          true,
        ],
        [
          "string",
          true,
          true,
        ],
        [
          "string",
          true,
          true,
        ],
        [
          "string",
          true,
          true,
        ],
        [
          "string",
          true,
          true,
        ],
        [
          "string",
          true,
          true,
        ],
      ]
    `);
  });

  it("rejects on broken d2 source instead of throwing synchronously", async () => {
    let rejection: string | null = null;
    try {
      await renderD2("a: {", false);
    } catch (error) {
      rejection = error instanceof Error ? error.message : "unknown error";
    }
    expect(rejection).toBeTruthy();
  });
});
