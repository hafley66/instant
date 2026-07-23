import { describe, expect, it } from "vitest";
import { isToolOnlyTurn, touchedFiles, turnReferences, visibleTurnWindows } from "./0_sessionSidebarModel";
import type { AiMessage } from "./state";

const turn = (id: string, seq: number, text: string): AiMessage => ({
  editor: "claude", session_id: "s", id, seq, role: "assistant", ts: 1_784_808_000_000 + seq,
  preview: id, text, locator: id,
});

describe("session sidebar model", () => {
  it("keeps typed tool references and file chronology", () => {
    const rows = touchedFiles([
      turn("read", 1, '[Read] {"file_path":"src/a.ts"}'),
      turn("edit", 2, '[Edit] {"file_path":"src/a.ts"} [Write] {"file_path":"src/b.ts"}'),
    ], () => "/repo");
    expect(rows).toMatchInlineSnapshot(`
      [
        {
          "displayPath": "a.ts",
          "entry": {
            "ext": "ts",
            "is_dir": false,
            "modified": 0,
            "name": "a.ts",
            "path": "/repo/src/a.ts",
            "size": 0,
          },
          "firstTouchedAt": 1784808000001,
          "lastReadAt": 1784808000001,
          "lastTouchedAt": 1784808000002,
          "references": [
            {
              "action": "read",
              "path": "/repo/src/a.ts",
              "turn": {
                "editor": "claude",
                "id": "read",
                "locator": "read",
                "preview": "read",
                "role": "assistant",
                "seq": 1,
                "session_id": "s",
                "text": "[Read] {\"file_path\":\"src/a.ts\"}",
                "ts": 1784808000001,
              },
            },
            {
              "action": "edit",
              "path": "/repo/src/a.ts",
              "turn": {
                "editor": "claude",
                "id": "edit",
                "locator": "edit",
                "preview": "edit",
                "role": "assistant",
                "seq": 2,
                "session_id": "s",
                "text": "[Edit] {\"file_path\":\"src/a.ts\"} [Write] {\"file_path\":\"src/b.ts\"}",
                "ts": 1784808000002,
              },
            },
          ],
          "touchCount": 2,
        },
        {
          "displayPath": "b.ts",
          "entry": {
            "ext": "ts",
            "is_dir": false,
            "modified": 0,
            "name": "b.ts",
            "path": "/repo/src/b.ts",
            "size": 0,
          },
          "firstTouchedAt": 1784808000002,
          "lastReadAt": 0,
          "lastTouchedAt": 1784808000002,
          "references": [
            {
              "action": "write",
              "path": "/repo/src/b.ts",
              "turn": {
                "editor": "claude",
                "id": "edit",
                "locator": "edit",
                "preview": "edit",
                "role": "assistant",
                "seq": 2,
                "session_id": "s",
                "text": "[Edit] {\"file_path\":\"src/a.ts\"} [Write] {\"file_path\":\"src/b.ts\"}",
                "ts": 1784808000002,
              },
            },
          ],
          "touchCount": 1,
        },
      ]
    `);
    expect(turnReferences(turn("x", 3, '[Read] {"file_path":"a.ts"}'), "/repo")[0].action).toBe("read");
  });

  it("projects visible rows newest-first and nests paired tool records", () => {
    const windows = visibleTurnWindows([
      turn("visible-1", 1, "first visible"),
      turn("tool-1", 2, '[Read] {"file_path":"src/a.ts"}'),
      turn("visible-2", 3, "second visible"),
      turn("tool-2", 4, '[Bash] {"command":"git status"}'),
    ]);
    expect(isToolOnlyTurn(turn("tool-1", 2, '[Read] {"file_path":"src/a.ts"}'))).toBe(true);
    expect(windows.map(({ turn, tools }) => [turn.id, tools.map((tool) => tool.id)])).toMatchInlineSnapshot(`
      [
        [
          "visible-2",
          [
            "tool-2",
          ],
        ],
        [
          "visible-1",
          [
            "tool-1",
          ],
        ],
      ]
    `);
  });
});
