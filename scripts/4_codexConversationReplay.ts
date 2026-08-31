import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BoopTurn } from "../src/0_terminalTurnVisibility";

export const realCodexTranscript = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "transcripts",
  "codex",
  "session.jsonl",
);

export type CodexPayloadType =
  | "message"
  | "custom_tool_call"
  | "function_call"
  | "custom_tool_call_output"
  | "function_call_output"
  | "reasoning";

export type CodexConversationReplayTurn = BoopTurn & Readonly<{
  sourceLine: number;
  payloadType: CodexPayloadType;
  subtype: string | null;
}>;

export type CodexConversationReplay = Readonly<{
  source: string;
  turns: readonly CodexConversationReplayTurn[];
  longTurn: CodexConversationReplayTurn;
  payloadTypes: readonly CodexPayloadType[];
}>;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function cap(text: string, length: number): string {
  const characters = [...text];
  return characters.length > length ? `${characters.slice(0, length).join("")}…` : text;
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return JSON.stringify(value);
  return value.map((item) => {
    if (typeof item === "string") return item;
    const record = object(item);
    return typeof record.text === "string" ? record.text : "";
  }).filter(Boolean).join("\n");
}

function messageText(payload: JsonObject): string {
  if (!Array.isArray(payload.content)) return "";
  return payload.content.map((item) => object(item).text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

function payloadTurn(
  payload: JsonObject,
  toolNames: Map<string, string>,
): Pick<CodexConversationReplayTurn, "role" | "said" | "subtype" | "payloadType"> | null {
  const payloadType = payload.type as CodexPayloadType;
  if (payloadType === "message") {
    const role = payload.role;
    if (role !== "user" && role !== "assistant") return null;
    const said = messageText(payload);
    return said.trim() ? { role, said, subtype: null, payloadType } : null;
  }
  if (payloadType === "custom_tool_call" || payloadType === "function_call") {
    const subtype = typeof payload.name === "string" ? payload.name : "tool";
    if (typeof payload.call_id === "string") toolNames.set(payload.call_id, subtype);
    const input = payloadType === "custom_tool_call" ? payload.input : payload.arguments;
    return { role: "assistant", said: cap(valueText(input), 400), subtype, payloadType };
  }
  if (payloadType === "custom_tool_call_output" || payloadType === "function_call_output") {
    const name = typeof payload.call_id === "string" ? toolNames.get(payload.call_id) : undefined;
    return {
      role: "assistant",
      said: cap(valueText(payload.output), 400),
      subtype: name ? `${name} result` : "tool result",
      payloadType,
    };
  }
  if (payloadType === "reasoning") {
    return { role: "assistant", said: "reasoning trace", subtype: "reasoning", payloadType };
  }
  return null;
}

export function realCodexConversationReplay(path = realCodexTranscript): CodexConversationReplay {
  const session = "codex-real-session";
  const toolNames = new Map<string, string>();
  const turns = readFileSync(path, "utf8").trimEnd().split("\n").flatMap((line, index) => {
    const record = object(JSON.parse(line));
    const projected = payloadTurn(object(record.payload), toolNames);
    if (!projected || !projected.said.trim()) return [];
    return [{
      session,
      harness: "codex",
      turn: index + 1,
      ts: index + 1,
      sourceLine: index + 1,
      ...projected,
    }];
  });
  const longTurn = turns.find((turn) => turn.sourceLine === 21);
  if (!longTurn) throw new Error("real Codex fixture line 21 did not produce a turn");
  return {
    source: path,
    turns,
    longTurn,
    payloadTypes: [...new Set(turns.map((turn) => turn.payloadType))].sort(),
  };
}
