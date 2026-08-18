/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { focusedFamilyQuery, normalizeBoopFamily } from "./1_boopFamily";

describe("focusedFamilyQuery", () => {
  it("uses only the exact tmux name and a seven-day history cutoff", () => {
    const before = Date.now();
    const query = focusedFamilyQuery("s:claude-focused");
    const after = Date.now();
    expect(query).toMatchObject({ include_history: true, tmux: "claude-focused" });
    expect(query).not.toHaveProperty("cwd");
    expect(query.history_since_ts).toBeGreaterThanOrEqual(before - 7 * 24 * 60 * 60 * 1000);
    expect(query.history_since_ts).toBeLessThanOrEqual(after - 7 * 24 * 60 * 60 * 1000);
  });
});

describe("normalizeBoopFamily", () => {
  it("keeps Claude descendants and a historical member from typed Boop edges", () => {
    const rows = normalizeBoopFamily({
      sessions: [
        { session: { harness: "claude", id: "4bf4853d-root" }, tmux: "claude-focused", state: "live" },
        { session: { harness: "claude", id: "subagent-1" }, state: "idle" },
        { session: { harness: "codex", id: "historical-1" }, state: "done" },
      ],
      edges: [
        { parent: { harness: "claude", id: "4bf4853d-root" }, child: { harness: "claude", id: "subagent-1" }, kind: "subagent" },
        { parent: { harness: "claude", id: "4bf4853d-root" }, child: { harness: "codex", id: "historical-1" }, kind: "dispatch" },
      ],
      shells: [],
    }, Date.parse("2026-08-18T00:00:00.000Z"));
    expect(rows).toMatchInlineSnapshot(`
      [
        {
          "cwd": "",
          "from": "user",
          "harness": "claude",
          "id": "4bf4853d-root",
          "lastActivity": "2026-08-18T00:00:00.000Z",
          "parentId": null,
          "parentKind": null,
          "status": "live",
          "tmuxMatches": [
            "claude-focused",
          ],
          "tmuxSession": "claude-focused",
          "ts": "2026-08-18T00:00:00.000Z",
          "why": "",
        },
        {
          "cwd": "",
          "from": "user",
          "harness": "claude",
          "id": "subagent-1",
          "lastActivity": "2026-08-18T00:00:00.000Z",
          "parentId": "4bf4853d-root",
          "parentKind": "subagent",
          "status": "idle",
          "tmuxMatches": [],
          "tmuxSession": null,
          "ts": "2026-08-18T00:00:00.000Z",
          "why": "",
        },
        {
          "cwd": "",
          "from": "user",
          "harness": "codex",
          "id": "historical-1",
          "lastActivity": "2026-08-18T00:00:00.000Z",
          "parentId": "4bf4853d-root",
          "parentKind": "dispatch",
          "status": "done",
          "tmuxMatches": [],
          "tmuxSession": null,
          "ts": "2026-08-18T00:00:00.000Z",
          "why": "",
        },
      ]
    `);
  });
});
