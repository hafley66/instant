import { describe, expect, it } from "vitest";
import { realClaudeConversationReplay } from "./3_claudeConversationReplay";

describe("real Claude conversation replay", () => {
  it("carries every ledger message role and content shape into the receipt gallery", () => {
    const replay = realClaudeConversationReplay();
    expect({
      source: replay.source.split("/").slice(-4).join("/"),
      corpus: {
        turns: replay.turns.length,
        roles: replay.roles,
        contentTypes: replay.contentTypes,
      },
      gallery: replay.gallery.map((turn) => ({
        sourceLine: turn.sourceLine,
        turn: turn.turn,
        role: turn.role,
        subtype: turn.subtype,
        contentTypes: turn.contentTypes,
        characters: [...turn.said].length,
        preview: turn.said.replaceAll("\n", " ").slice(0, 80),
      })),
      longTurn: {
        sourceLine: replay.longTurn.sourceLine,
        role: replay.longTurn.role,
        subtype: replay.longTurn.subtype,
        characters: [...replay.longTurn.said].length,
        lines: replay.longTurn.said.split("\n").length,
      },
    }).toMatchSnapshot();
  });
});
