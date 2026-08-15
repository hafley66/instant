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

  it("renders rich staged D2 output", async () => {
    const svg = await renderD2(`direction: right

classes: {
  ok: {
    style.fill: "#d3f9d8"
    style.stroke: "#2f9e44"
    style.font-color: "#1b1b1b"
  }
  gap: {
    style.fill: "#ffe3e3"
    style.stroke: "#e03131"
    style.stroke-dash: 4
    style.font-color: "#1b1b1b"
  }
  store: {
    shape: cylinder
    style.fill: "#d3f9d8"
    style.stroke: "#2f9e44"
  }
  stage: {
    style.fill: "#f8f9fa"
    style.stroke: "#868e96"
  }
}

IN: 1 inputs { class: stage
  SRC: entry .dl6 text { class: ok }
  DIG: 'source_digest\\n0_compile.ts:99' { class: ok }
}

RES: 2 resolve { class: stage
  USE: 'expand_uses/6\\nuse_resolve.pl:43' { class: ok }
}

CMP: 3 compile - swipl { class: stage
  SWI: compile_dl6/3 { class: ok }
  EMT: 'emitted .ts + __rel\\nh_id . h_schema . h_rule' { class: ok }
}

DEC: 4 decide { class: stage
  PLN: 'ReloadPlanner.plan\\nreloadPlan.ts:31' { class: ok }
}

SWP: 5 swap { class: stage
  SW: 'switchMap\\n4_http.ts:508' { class: ok }
  DB: 'SQLite\\nddl replay' { class: store }
}

RUN: 6 run { class: stage
  TCK: 'IncrementalRuntime\\ntick loop' { class: ok }
  CH: 'channels: tick effect\\nbind watch rule' { class: ok }
}

IN.SRC -> IN.DIG -> CMP.SWI -> CMP.EMT -> DEC.PLN -> SWP.SW -> SWP.DB -> RUN.TCK -> RUN.CH
RES.USE -> CMP.SWI: 'A5 - never called' { style.stroke-dash: 4; style.stroke: "#e03131" }

G8: '8. digest keys WHOLE entry\\none edit rebuilds all' { class: gap }
G8 -> IN.DIG`, true);

    expect({
      hasSvg: svg.includes("<svg"),
      hasInputs: svg.includes("1 inputs"),
      hasDigestGap: svg.includes("digest keys WHOLE entry"),
    }).toMatchInlineSnapshot(`
      {
        "hasDigestGap": true,
        "hasInputs": true,
        "hasSvg": true,
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
