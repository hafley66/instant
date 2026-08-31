import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BoopTurn } from "../src/0_terminalTurnVisibility";

export const realClaudeTranscript = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "transcripts",
  "claude",
  "session.jsonl",
);

export type ConversationRole = "user" | "assistant" | "tool" | "meta";
export type ConversationContentType = "string" | "text" | "thinking" | "tool_use" | "tool_result";

export type ConversationReplayTurn = BoopTurn & Readonly<{
  sourceLine: number;
  contentTypes: readonly ConversationContentType[];
  subtype: string | null;
}>;

export type ConversationReplay = Readonly<{
  source: string;
  turns: readonly ConversationReplayTurn[];
  gallery: readonly ConversationReplayTurn[];
  longTurn: ConversationReplayTurn;
  roles: readonly ConversationRole[];
  contentTypes: readonly ConversationContentType[];
}>;

export type RenderableConversationTurn = Pick<ConversationReplayTurn, "role" | "said" | "subtype">;

type JsonObject = Record<string, unknown>;

const injectedTags = [
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  "system-reminder",
];

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function cap(text: string, length: number): string {
  const characters = [...text];
  return characters.length > length ? `${characters.slice(0, length).join("")}…` : text;
}

function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const value of content) {
    const block = object(value);
    if (block.type === "text" && typeof block.text === "string") return block.text;
  }
  return "";
}

function injectedTag(content: unknown): string | null {
  const match = firstText(content).trimStart().match(/^<([^>]+)>/);
  return match && injectedTags.includes(match[1]) ? match[1] : null;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((value) => object(value).text)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function contentTypes(content: unknown): ConversationContentType[] {
  if (typeof content === "string") return ["string"];
  if (!Array.isArray(content)) return [];
  return [...new Set(content
    .map((value) => object(value).type)
    .filter((value): value is ConversationContentType =>
      value === "text"
      || value === "thinking"
      || value === "tool_use"
      || value === "tool_result"))];
}

// Mirrors ledger.rs::claude_text so the browser receives the same `said`
// strings that Boop stores for this sanitized real session.
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const lines: string[] = [];
  for (const value of content) {
    const block = object(value);
    if (block.type === "text" && typeof block.text === "string") lines.push(block.text);
    if (block.type === "thinking" && typeof block.thinking === "string") {
      lines.push(cap(block.thinking, 600));
    }
    if (block.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "tool";
      lines.push(block.input === undefined ? `[${name}]` : `[${name}] ${cap(JSON.stringify(block.input), 400)}`);
    }
    if (block.type === "tool_result") {
      const result = toolResultText(block.content);
      if (result) lines.push(cap(result, 400));
    }
  }
  return lines.join("\n").trimEnd();
}

function messageRole(record: JsonObject, content: unknown): { role: ConversationRole; subtype: string | null } {
  if (record.type === "assistant") {
    const [type] = contentTypes(content);
    if (type === "thinking") return { role: "assistant", subtype: "thinking" };
    if (type === "tool_use") {
      const block = Array.isArray(content) ? object(content[0]) : {};
      return { role: "assistant", subtype: typeof block.name === "string" ? block.name : "tool" };
    }
    return { role: "assistant", subtype: null };
  }
  if (contentTypes(content).includes("tool_result")) return { role: "tool", subtype: "tool_result" };
  const origin = object(record.origin).kind;
  if (record.promptSource === "system") {
    return { role: "meta", subtype: typeof origin === "string" ? origin : "system" };
  }
  if (record.isCompactSummary === true) return { role: "meta", subtype: "compact-summary" };
  if (record.isMeta === true || injectedTag(content)) {
    return {
      role: "meta",
      subtype: typeof origin === "string" ? origin : injectedTag(content),
    };
  }
  return { role: "user", subtype: null };
}

function readTurns(path: string): ConversationReplayTurn[] {
  const session = "claude-real-session";
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .flatMap((line, index) => {
      const record = object(JSON.parse(line));
      if (record.type !== "user" && record.type !== "assistant") return [];
      const content = object(record.message).content;
      const said = messageText(content);
      if (!said.trim()) return [];
      const { role, subtype } = messageRole(record, content);
      return [{
        session,
        harness: "claude",
        turn: index + 1,
        ts: index + 1,
        role,
        said,
        sourceLine: index + 1,
        contentTypes: contentTypes(content),
        subtype,
      }];
    });
}

function requireLines(turns: readonly ConversationReplayTurn[], lines: readonly number[]) {
  return lines.map((line) => {
    const turn = turns.find((candidate) => candidate.sourceLine === line);
    if (!turn) throw new Error(`real Claude fixture line ${line} did not produce a turn`);
    return turn;
  });
}

export function realClaudeConversationReplay(path = realClaudeTranscript): ConversationReplay {
  const turns = readTurns(path);
  const gallery = requireLines(turns, [4, 19, 20, 23, 38, 44]);
  const [longTurn] = requireLines(turns, [16]);
  return {
    source: path,
    turns,
    gallery,
    longTurn,
    roles: [...new Set(turns.map((turn) => turn.role))].sort(),
    contentTypes: [...new Set(turns.flatMap((turn) => turn.contentTypes))].sort(),
  };
}

function marker(turn: RenderableConversationTurn): string {
  if (turn.role === "user") return "❯";
  if (turn.role === "tool") return "⎿";
  if (turn.role === "meta") return "◆";
  if (turn.subtype === "thinking") return "✻";
  if (turn.subtype) return "⏺";
  return "●";
}

export function renderConversationTurns(turns: readonly RenderableConversationTurn[]): string {
  return turns.map((turn) => {
    const [first = "", ...rest] = turn.said.split("\n");
    return [`${marker(turn)} ${first}`, ...rest.map((line) => `  ${line}`)].join("\r\n");
  }).join("\r\n\r\n") + "\r\n";
}

export function renderConversationWindow(
  turn: RenderableConversationTurn,
  start: number,
  end: number,
): string {
  const lines = turn.said.split("\n").slice(start, end);
  return lines.map((line, index) => start === 0 && index === 0 ? `${marker(turn)} ${line}` : `  ${line}`)
    .join("\r\n");
}
