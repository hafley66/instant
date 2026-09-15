import { describe, expect, it } from "vitest";
import { detectHarness } from "./harness";
import { resolvedTerminalHarness, type PaneSessionBinding } from "./0a_terminalHarnessBinding";

describe("terminal pane session harness binding", () => {
  it("holds an exact OMP binding through shell and bun observation, then switches and clears it", () => {
    const shellBun = detectHarness("zsh", "bun");
    const bindings: (PaneSessionBinding | null)[] = [
      { session: "omp-session", harness: "omp" },
      { session: "codex-session", harness: "codex" },
      null,
      { session: "unknown-session", harness: null },
    ];

    expect(bindings.map((binding) => resolvedTerminalHarness(shellBun, binding))).toMatchInlineSnapshot(`
      [
        {
          "confidence": "high",
          "evidence": [
            "boop:session",
          ],
          "id": "omp",
          "outputTail": "",
        },
        {
          "confidence": "high",
          "evidence": [
            "boop:session",
          ],
          "id": "codex",
          "outputTail": "",
        },
        {
          "confidence": "none",
          "evidence": [],
          "id": null,
          "outputTail": "",
        },
        {
          "confidence": "none",
          "evidence": [],
          "id": null,
          "outputTail": "",
        },
      ]
    `);
  });
});
