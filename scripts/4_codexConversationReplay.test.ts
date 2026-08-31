import { describe, expect, it } from "vitest";
import { realCodexConversationReplay } from "./4_codexConversationReplay";

describe("real Codex conversation replay", () => {
  it("mirrors the ledger payload shapes and retains a viewport-tall tool result", () => {
    const replay = realCodexConversationReplay();
    expect({
      source: replay.source.split("/").slice(-4).join("/"),
      turns: replay.turns.length,
      payloadTypes: replay.payloadTypes,
      longTurn: {
        sourceLine: replay.longTurn.sourceLine,
        turn: replay.longTurn.turn,
        role: replay.longTurn.role,
        subtype: replay.longTurn.subtype,
        characters: [...replay.longTurn.said].length,
        lines: replay.longTurn.said.split("\n").length,
        preview: replay.longTurn.said.replaceAll("\n", " ").slice(0, 100),
      },
    }).toMatchSnapshot();
  });
});
